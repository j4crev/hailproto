import { decodeBase64Url } from "@hailproto/codec/base64url";
import { CID } from "multiformats/cid";
import { hash } from "../../src/http.js";

export interface EmailBinding {
  send(message: { to: string; from: { email: string; name: string }; subject: string; text: string; html?: string }): Promise<{ messageId: string }>;
}
export interface EmailEnvironment { EMAIL: EmailBinding; SIGNUP_SENDER: string; SIGNUP_ORIGIN: string; }
export interface DurableStorage {
  get<T>(key: string): Promise<T | undefined>;
  put(key: string, value: unknown): Promise<void>;
  delete(key: string): Promise<boolean>;
  list<T>(options: { prefix: string }): Promise<Map<string, T>>;
  getAlarm(): Promise<number | null>;
  setAlarm(time: number): Promise<void>;
  transaction<T>(callback: (transaction: Pick<DurableStorage, "get" | "put" | "delete">) => Promise<T>): Promise<T>;
}
interface Signup {
  email: string; signupHash: string; codeHash: string | null; attempts: number;
  state: "sending" | "pending" | "verified" | "bound";
  expiresAt: number; lastSendAt: number; claim: string; verifiedAt?: number;
  did?: string; operationCid?: string;
}
export interface Recipient {
  hailAddress?: string; email: string; signupId: string; signupHash: string; did: string; operationCid: string; verifiedAt: number;
}
interface Rate { count: number; expiresAt: number; }
const hour = 3_600_000, codeLifetime = 10 * 60_000, verifiedLifetime = 24 * hour;
const uuid = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/;
export const signupEmailPaths = new Set(["/signup-email", "/signup-email/verify", "/signup-email/bind", "/signup-email/invite"]);
const reply = (value: unknown, status = 200, retry?: number) => Response.json(value, { status,
  headers: { "Cache-Control": "no-store", ...(retry ? { "Retry-After": String(retry) } : {}) } });

function emailAddress(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 254) return null;
  const parts = value.split("@");
  if (parts.length !== 2) return null;
  const [local, rawDomain] = parts as [string, string], domain = rawDomain.toLowerCase();
  if (!local || local.length > 64 || !/^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+$/.test(local) ||
    local.startsWith(".") || local.endsWith(".") || local.includes("..") ||
    domain.length > 253 || !domain.includes(".") ||
    domain.split(".").some(label => label.length > 63 || !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label)) ||
    !/^[a-z]{2,63}$/.test(domain.split(".").at(-1)!)) return null;
  return `${local}@${domain}`;
}

function code(): string {
  let value: number;
  do { value = crypto.getRandomValues(new Uint32Array(1))[0]!; } while (value >= 4_200_000_000);
  return String(value % 100_000_000).padStart(8, "0");
}

export async function sendEmail(env: Pick<EmailEnvironment, "EMAIL">, message: Omit<Parameters<EmailBinding["send"]>[0], "from"> & { from: string }): Promise<void> {
  try { await env.EMAIL.send({ ...message, from: { email: message.from, name: "Hail" } }); }
  catch { throw new Error("Email delivery unavailable"); } // Do not expose vendor errors containing recipients or message content.
}

export async function signupEmail(path: string, input: unknown, storage: DurableStorage, env: EmailEnvironment): Promise<Response> {
  if(path==="/signup-email/invite")return sendSignupInvitation(input,storage,env);
  if (!input || typeof input !== "object" || Array.isArray(input)) return reply({ error: "Invalid signup email request" }, 400);
  const row = input as Record<string, unknown>, fields = path === "/signup-email" ? ["signupId", "signupHash", "email", "resend"] :
    path === "/signup-email/verify" ? ["signupId", "signupHash", "code"] : ["signupId", "signupHash", "did", "operationCid", "hailAddress"];
  if (Object.keys(row).some(key => !fields.includes(key)) || typeof row.signupId !== "string" || !uuid.test(row.signupId) ||
    typeof row.signupHash !== "string") return reply({ error: "Invalid signup email request" }, 400);
  try { decodeBase64Url(row.signupHash, 32); } catch { return reply({ error: "Invalid signup email request" }, 400); }
  const signupId = row.signupId, signupHash = row.signupHash, key = `signup:${signupId}`, now = Date.now();

  if (path === "/signup-email") {
    const email = emailAddress(row.email);
    if (!email || row.resend !== undefined && typeof row.resend !== "boolean") return reply({ error: "Invalid email address" }, 400);
    const origin = new URL(env.SIGNUP_ORIGIN);
    if (origin.protocol !== "https:" || origin.origin !== env.SIGNUP_ORIGIN) throw new Error("Invalid signup origin configuration");
    const challenge = code(), codeHash = await hash(`${signupId}\0${signupHash}\0${email}\0${challenge}`), claim = crypto.randomUUID();
    const mailboxKey = `email-rate:${await hash(email.toLowerCase())}`;
    const result = await storage.transaction(async tx => {
      const prior = await tx.get<Signup>(key);
      if (prior && (prior.email !== email || prior.signupHash !== signupHash)) return { status: 409 };
      if (prior?.state === "bound" || prior?.state === "verified" && prior.expiresAt > now) return { verified: true, expiresAt: prior.expiresAt };
      if (prior?.state === "pending" && prior.expiresAt > now && !row.resend) return { verified: false, expiresAt: prior.expiresAt };
      if (prior && now - prior.lastSendAt < 60_000) return { status: prior.state === "sending" ? 503 : 429, retry: 60 };
      const mailbox = await tx.get<Rate>(mailboxKey), global = await tx.get<Rate>("email-rate:global");
      if (mailbox && mailbox.expiresAt > now && mailbox.count >= 5 || global && global.expiresAt > now && global.count >= 100)
        return { status: 429, retry: Math.max(1, Math.ceil(((mailbox && mailbox.expiresAt > now && mailbox.count >= 5 ? mailbox : global)!.expiresAt - now) / 1000)) };
      for (const [rateKey, priorRate] of [[mailboxKey, mailbox], ["email-rate:global", global]] as const)
        await tx.put(rateKey, priorRate && priorRate.expiresAt > now ? { ...priorRate, count: priorRate.count + 1 } : { count: 1, expiresAt: now + hour });
      await tx.put(key, { email, signupHash, codeHash, claim, state: "sending", attempts: 0,
        expiresAt: now + codeLifetime, lastSendAt: now } satisfies Signup);
      return { send: true, expiresAt: now + codeLifetime };
    });
    if (!(await storage.getAlarm())) await storage.setAlarm(now + hour);
    if (result.status) return reply({ error: "Signup email request refused" }, result.status, result.retry);
    if (!result.send) return reply({ verified: result.verified, expiresAt: result.expiresAt });
    try {
      await sendEmail(env, { to: email, from: env.SIGNUP_SENDER, subject: "Verify your Hail security email",
        text: `Your Hail signup verification code is: ${challenge}\n\nEnter it only in the signup you started at:\n${origin.href}\n\nIt expires in 10 minutes.\n\nThis verifies where identity-security alerts should be sent. It does not sign you in, reset your account or authorize recovery. Never send anyone your recovery secret.\n\nIf you did not request this email, ignore it.` });
      return await storage.transaction(async tx => {
        const saved = await tx.get<Signup>(key);
        if (!saved || saved.claim !== claim) return reply({ error: "Signup email request superseded" }, 409);
        if (saved.state === "sending") await tx.put(key, { ...saved, state: "pending" });
        return reply({ verified: saved.state === "verified" || saved.state === "bound", expiresAt: saved.expiresAt });
      });
    } catch { return reply({ error: "Signup email delivery unavailable; retry later" }, 503, 60); }
  }

  if (path === "/signup-email/verify") {
    if (typeof row.code !== "string" || !/^\d{8}$/.test(row.code)) return reply({ error: "Invalid verification code" }, 400);
    const supplied = row.code;
    return storage.transaction(async tx => {
      const saved = await tx.get<Signup>(key);
      if (!saved || saved.signupHash !== signupHash || saved.state !== "bound" && saved.expiresAt <= now)
        return reply({ error: "Verification refused or expired" }, 409);
      if (saved.state === "verified" || saved.state === "bound") return reply({ verified: true, expiresAt: saved.expiresAt });
      if (saved.attempts >= 5) return reply({ error: "Verification attempts exhausted; request a new code" }, 429);
      const correct = saved.codeHash === await hash(`${signupId}\0${signupHash}\0${saved.email}\0${supplied}`);
      await tx.put(key, { ...saved, attempts: saved.attempts + 1, ...(correct ? {
        state: "verified", codeHash: null, verifiedAt: now, expiresAt: now + verifiedLifetime,
      } : {}) });
      return correct ? reply({ verified: true, expiresAt: now + verifiedLifetime }) : reply({ error: "Verification refused or expired" }, 409);
    });
  }

  if (typeof row.did !== "string" || !/^did:plc:[a-z2-7]{24}$/.test(row.did) || typeof row.operationCid !== "string")
    return reply({ error: "Invalid signup identity" }, 400);
  try {
    const cid = CID.parse(row.operationCid);
    if (cid.toString() !== row.operationCid || cid.code !== 0x71 || cid.multihash.code !== 0x12 || cid.multihash.digest.length !== 32) throw new Error();
  } catch { return reply({ error: "Invalid signup identity" }, 400); }
  // Optional for old senders; never infer the Hail address from the security email.
  if (row.hailAddress !== undefined && (typeof row.hailAddress !== "string" || row.hailAddress.length > 254 ||
    !/^[^\s@\x00-\x1f\x7f]+@[^\s@\x00-\x1f\x7f]+$/.test(row.hailAddress)))
    return reply({ error: "Invalid Hail address" }, 400);
  const hailAddress = row.hailAddress as string | undefined;
  const did = row.did, operationCid = row.operationCid;
  return storage.transaction(async tx => {
    const saved = await tx.get<Signup>(key), recipientKey = `recipient:${did}`, recipient = await tx.get<Recipient>(recipientKey);
    if (!saved || saved.signupHash !== signupHash || !saved.verifiedAt ||
      saved.state !== "verified" && saved.state !== "bound" || saved.state !== "bound" && saved.expiresAt <= now ||
      saved.state === "bound" && (saved.did !== did || saved.operationCid !== operationCid) ||
      recipient && (recipient.signupId !== signupId || recipient.signupHash !== signupHash || recipient.operationCid !== operationCid || recipient.email !== saved.email || hailAddress !== undefined && recipient.hailAddress !== undefined && recipient.hailAddress !== hailAddress))
      return reply({ error: "Verified signup destination cannot be bound" }, 409);
    const retainedAddress = recipient?.hailAddress ?? hailAddress;
    await tx.put(recipientKey, { ...(retainedAddress ? { hailAddress: retainedAddress } : {}), email: saved.email, signupId, signupHash, did, operationCid, verifiedAt: saved.verifiedAt } satisfies Recipient);
    await tx.put(key, { ...saved, state: "bound", codeHash: null, did, operationCid });
    return reply({ bound: true, did, operationCid });
  });
}

export async function pruneSignupEmail(storage: DurableStorage): Promise<void> {
  const now = Date.now();
  let pending = false;
  // ponytail: one existing coordination object, partition by signup/DID if alpha volume makes these scans expensive.
  for (const prefix of ["signup:", "email-rate:", "invitation:"])
    for (const [key, value] of await storage.list<{ expiresAt: number; state?: string }>({ prefix })) {
      if (value.state === "bound") continue;
      if (value.expiresAt <= now) await storage.transaction(async tx => {
        const current = await tx.get<{ expiresAt: number; state?: string }>(key);
        if (current && current.state !== "bound" && current.expiresAt <= now) await tx.delete(key);
        else if (current && current.state !== "bound") pending = true;
      });
      else pending = true;
    }
  if (pending) await storage.setAlarm(now + hour);
}

// The provider supplies a signed bearer, while this service pins the destination
// origin and message template. It cannot be used to send arbitrary email content.
async function sendSignupInvitation(input:unknown,storage:DurableStorage,env:EmailEnvironment):Promise<Response>{
  if(!input||typeof input!=="object"||Array.isArray(input))return reply({error:"Invalid invitation"},400);
  const row=input as Record<string,unknown>,email=emailAddress(row.email),now=Date.now();
  if(Object.keys(row).sort().join(',')!=="email,expiresAt,id,url"||typeof row.id!=="string"||!uuid.test(row.id)||!email||
    typeof row.url!=="string"||row.url.length>3000||typeof row.expiresAt!=="number"||!Number.isSafeInteger(row.expiresAt)||
    row.expiresAt*1000<=now||row.expiresAt*1000>now+7*86400_000+300_000)return reply({error:"Invalid invitation"},400);
  let url:URL;
  try{
    url=new URL(row.url);
    if(url.protocol!=="https:"||url.origin!==env.SIGNUP_ORIGIN||url.pathname!=="/signup"||url.search||url.username||url.password||
      !/^#invitation=[A-Za-z0-9_.%-]+$/.test(url.hash))throw new Error();
  }catch{return reply({error:"Invalid invitation URL"},400);}
  const digest=await hash(JSON.stringify({email,url:row.url,expiresAt:row.expiresAt})),key=`invitation:${row.id}`;
  type InvitationRecord={digest:string;state:"sending"|"sent";expiresAt:number};
  const result=await storage.transaction(async tx=>{
    const prior=await tx.get<InvitationRecord>(key);
    if(prior)return prior.digest!==digest?409:prior.state==="sent"?204:503;
    const mailboxKey=`email-rate:invite:${await hash(email.toLowerCase())}`;
    const mailbox=await tx.get<Rate>(mailboxKey),global=await tx.get<Rate>("email-rate:invite-global");
    if(mailbox&&mailbox.expiresAt>now&&mailbox.count>=5||global&&global.expiresAt>now&&global.count>=100)return 429;
    for(const [rateKey,priorRate] of [[mailboxKey,mailbox],["email-rate:invite-global",global]] as const)
      await tx.put(rateKey,priorRate&&priorRate.expiresAt>now?{...priorRate,count:priorRate.count+1}:{count:1,expiresAt:now+hour});
    await tx.put(key,{digest,state:"sending",expiresAt:(row.expiresAt as number)*1000} satisfies InvitationRecord);
    return 0;
  });
  if(!(await storage.getAlarm()))await storage.setAlarm(now+hour);
  if(result)return new Response(null,{status:result,headers:{"Cache-Control":"no-store"}});
  try{
    const escapeHtml=(value:string)=>value.replace(/[&<>"']/g,char=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"})[char]!);
    await sendEmail(env,{to:email,from:env.SIGNUP_SENDER,subject:"You're invited to Hail",
      html:`<p>You've been invited to create an account at ${escapeHtml(url.origin)}.</p><p><a href="${escapeHtml(url.href)}">Join Now</a></p><p>This single-use invitation expires ${new Date(row.expiresAt*1000).toISOString()}. Keep the link private. It allows signup only, not access to an existing account.</p><p>If you weren't expecting this invitation, you can ignore it.</p>`,
      text:`You've been invited to create an account at ${url.origin}.\n\n${url.href}\n\nThis single-use invitation expires ${new Date(row.expiresAt*1000).toISOString()}. Keep the link private. It allows signup only, not access to an existing account.\n\nIf you weren't expecting this invitation, you can ignore it.`});
    await storage.put(key,{digest,state:"sent",expiresAt:row.expiresAt*1000} satisfies InvitationRecord);
    return new Response(null,{status:204,headers:{"Cache-Control":"no-store"}});
  }catch{
    // An email API failure can be ambiguous. Do not send a second copy on retry.
    return reply({error:"Invitation delivery unconfirmed"},503);
  }
}
