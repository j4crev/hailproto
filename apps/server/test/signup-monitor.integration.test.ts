import { createHash, generateKeyPairSync, randomBytes, randomUUID, sign } from "node:crypto";
import { SQL } from "bun";
import { cidForCbor } from "@atproto/common";
import { formatDidDoc, PlcClientError, validateOperationLog, type Operation } from "@did-plc/lib";
import { encodeBase64Url, decodeBase64Url, inspectSignedPayload } from "@hailproto/codec";
import { expect, it, vi } from "vitest";
import { Hono } from "hono";
import { createUserVault, unlockUserVault } from "../../cli/src/vault.js";
import { verifyUserVault } from "../../cli/src/vault-crypto.js";
import worker, { AlertDeduplicator, type Env } from "../../plc-monitor/deploy/cloudflare-alert-worker/worker.js";
import type { DurableStorage, EmailBinding } from "../../plc-monitor/deploy/cloudflare-alert-worker/signup-email.js";
import { MonitorDatabase } from "../../plc-monitor/src/database.js";
import { createMonitorEnrollmentApi } from "../../plc-monitor/src/enrollment.js";
import { PlcMonitor } from "../../plc-monitor/src/monitor.js";
import { MonitorNotifier } from "../../plc-monitor/src/notifier.js";
import type { MonitorPlcClient } from "../../plc-monitor/src/plc.js";
import { MonitorSigner } from "../../plc-monitor/src/signing.js";
import { ProviderDatabase } from "../src/db/database.js";
import { KeyEncryptor } from "../src/identity/key-encryption.js";
import { OnboardingRepository } from "../src/onboarding/repository.js";
import { PublicOnboarding } from "../src/onboarding/public.js";
import { SignupEmailClient, registerSignupEmailRoutes } from "../src/onboarding/email.js";
import { SignupMonitorClient, SignupMonitorService, registerSignupMonitorRoutes } from "../src/onboarding/monitor.js";
import { SignupCoordinator, registerSignupRoutes } from "../src/onboarding/signup.js";
import { createSignupInvitation } from "../src/onboarding/invitation.js";
import { AccountApiRepository } from "../src/accounts/repository.js";
import { PasskeyAuth } from "../src/accounts/passkeys.js";
import type { PlcDirectoryClient } from "../src/plc/client.js";
import { PlcHailDidResolver } from "../src/plc/resolver.js";
import { VerifiedPublicPlcResolver } from "../src/plc/public-resolver.js";

it.skipIf(!process.env.DATABASE_URL)("automates verified-email monitored signup across provider, monitor and receiver without private artifacts or CLI exchanges", async () => {
  const admin = new SQL(process.env.DATABASE_URL!), suffix = randomUUID().replaceAll("-", ""), providerSchema = `signup_provider_${suffix}`, monitorSchema = `signup_monitor_${suffix}`;
  await admin.unsafe(`CREATE SCHEMA "${providerSchema}"`); await admin.unsafe(`CREATE SCHEMA "${monitorSchema}"`);
  const databaseUrl = (schema: string) => { const url = new URL(process.env.DATABASE_URL!); url.searchParams.set("options", `-csearch_path=${schema}`); return url.toString(); };
  const db = new ProviderDatabase(databaseUrl(providerSchema)), monitorDb = new MonitorDatabase(databaseUrl(monitorSchema));
  const vault = await createUserVault(), signer = new MonitorSigner(generateKeyPairSync("ed25519").privateKey);
  const providerOrigin = "https://provider.example.com", monitorOrigin = "https://monitor.example.com", alertOrigin = "https://alerts.example.com", serviceBase = `${providerOrigin}/hail`;
  const signupToken = `hailp_${encodeBase64Url(randomBytes(32))}`, signupId = randomUUID(), emailToken = encodeBase64Url(randomBytes(32)), monitorToken = encodeBase64Url(randomBytes(32));
  const emailMessages: Parameters<EmailBinding["send"]>[0][] = [], stored = new Map<string, unknown>();
  let alarm: number | null = null, serial: Promise<unknown> = Promise.resolve(), failAlert = true;
  const storage: DurableStorage = {
    async get<T>(key: string) { return stored.get(key) as T | undefined; }, async put(key, value) { stored.set(key, value); },
    async delete(key) { return stored.delete(key); }, async list<T>({ prefix }: { prefix: string }) { return new Map([...stored].filter(([key]) => key.startsWith(prefix))) as Map<string, T>; },
    async getAlarm() { return alarm; }, async setAlarm(time) { alarm = time; },
    transaction<T>(callback: (tx: Pick<DurableStorage, "get" | "put" | "delete">) => Promise<T>): Promise<T> {
      const result = serial.then(() => callback(storage)); serial = result.catch(() => {}); return result;
    },
  };
  const env: Env = { EMAIL: { async send(message) {
    if (message.from.email.startsWith("security@") && failAlert) throw new Error("Simulated email outage");
    emailMessages.push(message); return { messageId: randomUUID() };
  } }, SIGNUP_SENDER: "welcome@notify.example.com", SIGNUP_ORIGIN: providerOrigin, SIGNUP_EMAIL_TOKEN: emailToken,
    ALERT_SENDER: "security@notify.example.com", ALERT_RECIPIENT: "operator@example.com", MONITOR_PUBLIC_KEY: signer.publicDidKey,
    HEARTBEAT_TOKEN: "unused", BACKUP_TOKEN: "unused", PROVIDER_HEALTH_URL: `${providerOrigin}/health/ready`,
    HAIL_PRODUCTION_MONITOR: { get: async () => null, put: async () => {} }, ALERT_DEDUPLICATOR: null as never };
  const receiver = new AlertDeduplicator({ storage }, env);
  env.ALERT_DEDUPLICATOR = { idFromName: name => name, get: () => ({ fetch: request => receiver.fetch(request) }) };
  let receiverAvailable = true;
  const receiverFetch = async (url: string | URL | Request, init?: RequestInit) => {
    if (!receiverAvailable) throw new Error("Receiver unavailable");
    const request = new Request(url, init); expect(new URL(request.url).origin).toBe(alertOrigin);
    return worker.fetch(request, env);
  };
  const logs = new Map<string, Operation[]>(), auditCreatedAt = new Date().toISOString();
  let losePlcResponse = true;
  const plc: PlcDirectoryClient = {
    async health() { return { status: "ok" }; },
    async sendOperation(did, operation) { logs.set(did, [operation]); if (losePlcResponse) { losePlcResponse = false; throw new Error("Lost PLC response"); } },
    async getOperationLog(did) { const log = logs.get(did); if (!log) throw new PlcClientError(404, null, "Absent test identity"); return log; },
    async getDocumentData(did) { return (await validateOperationLog(did, await this.getOperationLog(did)))!; },
    async getDocument(did) { return formatDidDoc(await this.getDocumentData(did)); },
    async getAuditableLog(did) { return Promise.all((await this.getOperationLog(did)).map(async operation => ({
      did, operation, cid: (await cidForCbor(operation)).toString(), nullified: false, createdAt: auditCreatedAt,
    }))); },
  };
  const monitorPlc: MonitorPlcClient = { ...plc, async exportAfter() { throw new Error("No global PLC export needed"); } };
  try {
    await db.migrate(); await monitorDb.migrate(); await verifyUserVault(vault.vault, vault.recoverySecret);
    const reader = (name: string) => ({ origin: `https://reader-${name}.example.com`, operator: `reader-${name}`,
      resolver: new PlcHailDidResolver(plc), audit: (did: string) => plc.getAuditableLog(did), health: async () => ({ lastCommittedOpTime: new Date().toISOString() }) });
    const resolver = new VerifiedPublicPlcResolver(db.sql, [reader("one"), reader("two")], ["provider"], [providerOrigin]), repository = new OnboardingRepository(db.sql);
    const onboarding = new PublicOnboarding(db.sql, plc, resolver, new KeyEncryptor(encodeBase64Url(randomBytes(32))), "https://plc.directory", serviceBase,
      { async verify(address) {
        const account = await repository.getAccountByAddress(address), binding = await repository.getBindingForAccount(account.id), current = await resolver.resolve(account.did!);
        return { address, did: account.did!, serviceBase, identityDidKey: current.identityDidKey, messagingDidKey: current.messagingDidKey,
          plcEvidence: current.evidence, verifiedAt: new Date(), binding: inspectSignedPayload("hail.address-binding", binding.cose).payload,
          representation: binding.cose, digest: binding.digest };
      } }, { profile: "reduced-assurance-alpha-v1", monitorOrigin, monitorPublicKey: signer.publicDidKey });
    const prepared = await onboarding.prepare(`signup-${suffix}@provider.example.com`, vault.vault.recovery.publicDidKey, vault.vault.identity.publicDidKey,
      true, "managed", monitorOrigin, signer.publicDidKey, new Uint8Array(createHash("sha256").update(signupToken).digest()), true);
    const owner = await unlockUserVault(vault.vault, vault.recoverySecret);
    const genesis = await owner.signManagedGenesis({ type: "plc_operation", prev: null, rotationKeys: [prepared.userRecoveryKey, prepared.providerRotationKey],
      verificationMethods: { "hail-identity": prepared.userIdentityKey, "hail-messaging": prepared.providerMessagingKey },
      alsoKnownAs: [], services: { hail: { type: "HailMessaging", endpoint: serviceBase } } });
    const registered = await onboarding.register(prepared.accountId, new TextEncoder().encode(JSON.stringify(genesis.operation)), new Uint8Array());
    expect(registered.state).toBe("address-staged"); expect(logs.size).toBe(1);

    let monitor = new PlcMonitor(monitorDb.sql, monitorPlc);
    let api = createMonitorEnrollmentApi({ token: monitorToken, providerOrigin, alertOrigin, monitorOrigin, hostname: "127.0.0.1", port: 3001 }, monitor, signer, receiverFetch);
    let loseMonitorReply = false, tamperSignature = false, monitorCalls = 0;
    const monitorFetch = (async (url: string | URL | Request, init?: RequestInit) => {
      const request = new Request(url, init); expect(new URL(request.url).origin).toBe(monitorOrigin); monitorCalls++;
      const body = await request.clone().json() as Record<string, unknown>;
      expect(Object.keys(body).sort()).toEqual(["operation", "signupHash", "signupId"]);
      const response = await api.fetch(request);
      if (loseMonitorReply) { loseMonitorReply = false; throw new Error("Lost committed monitor response"); }
      if (tamperSignature && response.status === 200) {
        const value = await response.json() as { attestation: { signature: string } }, signature = decodeBase64Url(value.attestation.signature);
        signature[0] = signature[0]! ^ 1; value.attestation.signature = encodeBase64Url(signature); return Response.json(value);
      }
      return response;
    }) as unknown as typeof fetch;
    const email = new SignupEmailClient({ origin: alertOrigin, token: emailToken }, receiverFetch as unknown as typeof fetch);
    const app = new Hono(); registerSignupEmailRoutes(app, db.sql, email, providerOrigin);
    const monitoring=new SignupMonitorService(db.sql, email, new SignupMonitorClient({ apiOrigin: monitorOrigin, token: monitorToken, publicKey: signer.publicDidKey }, monitorFetch));
    registerSignupMonitorRoutes(app, monitoring, providerOrigin);
    const post = (path: string, body: unknown, token = signupToken) => app.request(`${providerOrigin}/api/v1/${path}`, { method: "POST",
      headers: { "Content-Type": "application/json", Origin: providerOrigin, Authorization: `Bearer ${token}` }, body: JSON.stringify(body) });
    const enrollment = () => post("signup-monitor", { signupId, accountId: prepared.accountId });
    expect((await enrollment()).status).toBe(409); expect(monitorCalls).toBe(0);
    expect((await post("signup-email/start", { signupId, email: "owner@example.com" })).status).toBe(200);
    const code = emailMessages[0]!.text.match(/code is: (\d{8})/)![1]!;
    expect((await enrollment()).status).toBe(409); expect(monitorCalls).toBe(0);
    expect((await post("signup-email/verify", { signupId, code })).status).toBe(200);
    expect((await post("signup-monitor", { signupId, accountId: prepared.accountId }, `hailp_${encodeBase64Url(randomBytes(32))}`)).status).toBe(403);

    receiverAvailable = false; expect((await enrollment()).status).toBe(503); receiverAvailable = true;
    expect(await monitorDb.sql`SELECT did FROM monitored_dids`).toHaveLength(0);
    loseMonitorReply = true; expect((await enrollment()).status).toBe(503);
    expect(await monitorDb.sql`SELECT did FROM monitored_dids`).toHaveLength(1);
    const fingerprint = async () => JSON.stringify(await monitorDb.sql`SELECT enrolled_at,coverage_since,expected_cid,expected_state,alert_webhook_url FROM monitored_dids`);
    const baseline = await fingerprint();
    expect((await enrollment()).status).toBe(202); expect(await fingerprint()).toBe(baseline);
    expect(await monitorDb.sql`SELECT did FROM monitor_bootstrap_checkpoints`).toHaveLength(1);
    expect(await monitorDb.sql`SELECT id FROM monitor_alerts WHERE category='onboarding-enrollment'`).toHaveLength(1);
    expect(emailMessages).toHaveLength(1);
    expect((await monitor.poll()).state).toBe("current");
    const notifier = new MonitorNotifier(monitorDb.sql, signer, { async send(url, bytes, signature, publicKey) {
      expect(url).toBe(`${alertOrigin}/hail/signup`);
      return (await receiverFetch(url, { method: "POST", headers: { "Content-Type": "application/json", "X-Hail-Monitor-Key": publicKey,
        "X-Hail-Monitor-Signature": encodeBase64Url(signature) }, body: Uint8Array.from(bytes) })).status;
    } });
    expect(await notifier.sendOne()).toBe("retry"); expect((await enrollment()).status).toBe(202);
    expect((await repository.getAccount(prepared.accountId)).state).toBe("address-staged");
    failAlert = false; await monitorDb.sql`UPDATE monitor_alerts SET next_attempt_at=now()-interval '1 second' WHERE sent_at IS NULL`;
    expect(await notifier.sendOne()).toBe("sent"); expect(emailMessages).toHaveLength(2);
    expect(emailMessages[1]!).toMatchObject({ to: "owner@example.com", from: { email: "security@notify.example.com", name: "Hail" } });

    await monitorDb.sql`UPDATE monitored_dids SET last_polled_at=now()-interval '6 minutes'`;
    expect((await enrollment()).status).toBe(202); await monitor.poll();
    tamperSignature = true; expect((await enrollment()).status).toBe(503); tamperSignature = false;
    expect((await repository.getAccount(prepared.accountId)).state).toBe("address-staged");
    // Rebuild service instances as after a monitor process restart; keep all retained evidence.
    monitor = new PlcMonitor(monitorDb.sql, monitorPlc);
    api = createMonitorEnrollmentApi({ token: monitorToken, providerOrigin, alertOrigin, monitorOrigin, hostname: "127.0.0.1", port: 3001 }, monitor, signer, receiverFetch);
    const ready = await enrollment(); expect(ready.status).toBe(200);
    const result = await ready.json() as { state: string; attestation: { payload: string; signature: string } };
    expect(result.state).toBe("ready"); expect(await fingerprint()).toBe(baseline);
    await onboarding.activate(prepared.accountId, { payloadBytes: decodeBase64Url(result.attestation.payload), signature: decodeBase64Url(result.attestation.signature) });
    expect((await repository.getAccount(prepared.accountId)).state).toBe("active");
    expect(await db.sql`SELECT account_id FROM public_onboarding_evidence WHERE monitor_assurance='reduced-assurance-alpha-v1'`).toHaveLength(1);
    expect(await db.sql`SELECT id FROM account_api_credentials`).toHaveLength(0);
    expect(await monitorDb.sql`SELECT id FROM monitor_alerts WHERE sent_at IS NOT NULL`).toHaveLength(1);
    expect(await notifier.sendOne()).toBe("idle"); expect(emailMessages).toHaveLength(2);
    await expect(monitor.enroll(genesis.did, registered.operationCid, `${alertOrigin}/hail`, await plc.getDocumentData(genesis.did))).rejects.toThrow("retry differs");
    await monitorDb.sql`UPDATE monitor_alerts SET category='coverage-lost' WHERE did=${genesis.did}`;
    expect((await enrollment()).status).toBe(409); expect(await fingerprint()).toBe(baseline);

    const browserVault=await createUserVault();
    try{
      const inviteKey=encodeBase64Url(randomBytes(32)),invite=createSignupInvitation(providerOrigin,inviteKey);
      const setupToken=`hailp_${encodeBase64Url(randomBytes(32))}`,enrollmentToken=`hailp_${encodeBase64Url(randomBytes(32))}`,id=randomUUID();
      const policy={profile:"reduced-assurance-alpha-v1" as const,monitorOrigin,monitorPublicKey:signer.publicDidKey};
      let coordinator=new SignupCoordinator(db.sql,onboarding,monitoring,providerOrigin,policy,inviteKey);
      const accounts=new AccountApiRepository(db.sql),signupApp=new Hono();
      // Forward through a stable route while replacing the controller to simulate restart.
      registerSignupRoutes(signupApp,{prepare:(...args)=>coordinator.prepare(...args),status:(...args)=>coordinator.status(...args),
        checkAddress:(...args)=>coordinator.checkAddress(...args),advance:(...args)=>coordinator.advance(...args),complete:(...args)=>coordinator.complete(...args)} as SignupCoordinator,accounts,providerOrigin);
      registerSignupEmailRoutes(signupApp,db.sql,email,providerOrigin);
      const call=(path:string,body?:unknown,cookie?:string)=>signupApp.request(`${providerOrigin}/api/v1/${path}`,{
        method:body===undefined?"GET":"POST",headers:{Origin:providerOrigin,"Content-Type":"application/json",Authorization:`Bearer ${setupToken}`,
          ...(cookie?{Cookie:`hail_session=${cookie}`}:{})},...(body!==undefined?{body:JSON.stringify(body)}:{})});
      const request={signupId:id,address:`browser-${suffix}@provider.example.com`,recoveryKey:browserVault.vault.recovery.publicDidKey,
        identityKey:browserVault.vault.identity.publicDidKey,enrollmentHash:encodeBase64Url(createHash("sha256").update(enrollmentToken).digest()),
        invitation:invite,backupVerified:true,managedAccepted:true,alphaMonitoringAccepted:true};
      expect(await coordinator.checkAddress({address:request.address,invitation:invite})).toEqual({address:request.address,available:true});
      await expect(coordinator.checkAddress({address:request.address,invitation:"invalid"})).rejects.toMatchObject({status:403});
      await expect(coordinator.checkAddress({address:"elsewhere@other.example",invitation:invite})).rejects.toMatchObject({status:400});
      const created=await call("signup",request);expect(created.status).toBe(200);
      expect(await coordinator.checkAddress({address:request.address,invitation:invite})).toEqual({address:request.address,available:false});
      const setup=await created.json() as {accountId:string;state:string;expiresAt:string;preparation:typeof prepared};
      expect((await signupApp.request(`${providerOrigin}/api/v1/signup/${id}`,{headers:{Authorization:`Bearer ${setupToken}`}})).status).toBe(200);
      expect(setup.state).toBe("prepared");expect((await call("signup",request)).status).toBe(200);
      expect((await call("signup",{...request,address:`other-${suffix}@provider.example.com`})).status).toBe(409);
      expect((await call("signup",{...request,signupId:randomUUID()})).status).toBe(409); // Single-use invitation.
      expect((await call(`signup/${id}/advance`,{operation:genesis.operation,enrollmentToken})).status).toBe(400);
      expect((await db.sql<{operation_bytes:Uint8Array|null}[]>`SELECT operation_bytes FROM account_signup_ceremonies WHERE id=${id}`)[0]!.operation_bytes).toBeNull();
      const browserOwner=await unlockUserVault(browserVault.vault,browserVault.recoverySecret),p=setup.preparation;
      const signed=await browserOwner.signManagedGenesis({type:"plc_operation",prev:null,rotationKeys:[p.userRecoveryKey,p.providerRotationKey],
        verificationMethods:{"hail-identity":p.userIdentityKey,"hail-messaging":p.providerMessagingKey},alsoKnownAs:[],
        services:{hail:{type:"HailMessaging",endpoint:serviceBase}}});
      const lock=await db.sql.reserve();try{
        await lock`SELECT pg_advisory_lock(684245160)`;
        await expect(coordinator.advance(id,setupToken,{operation:signed.operation,enrollmentToken})).rejects.toMatchObject({status:202});
      }finally{await lock`SELECT pg_advisory_unlock(684245160)`;lock.release();}
      expect((await call("signup-email/start",{signupId:id,email:"browser-owner@example.com"})).status).toBe(200);
      const emailCode=emailMessages.at(-1)!.text.match(/code is: (\d{8})/)![1]!;
      expect((await call("signup-email/verify",{signupId:id,code:emailCode})).status).toBe(200);
      const originalRegister=onboarding.register.bind(onboarding);let loseRegistration=true;
      onboarding.register=async(...args)=>{const result=await originalRegister(...args);if(loseRegistration){loseRegistration=false;throw new Error("Lost retained registration response");}return result;};
      expect((await call(`signup/${id}/advance`,{operation:signed.operation,enrollmentToken})).status).toBe(503);
      coordinator=new SignupCoordinator(db.sql,onboarding,monitoring,providerOrigin,policy,inviteKey);
      expect((await call(`signup/${id}/advance`,{enrollmentToken})).status).toBe(202);
      await monitor.poll();expect(await notifier.sendOne()).toBe("sent");
      const originalActivate=onboarding.activate.bind(onboarding);let loseActivation=true,oldEpoch:string|undefined;
      onboarding.activate=async(...args)=>{oldEpoch=args[2]?.epoch;await originalActivate(...args);if(loseActivation){loseActivation=false;throw new Error("Lost committed activation response");}};
      expect((await call(`signup/${id}/advance`,{enrollmentToken})).status).toBe(503);
      expect((await repository.getAccount(setup.accountId)).state).toBe("active");
      const chosen=(await db.sql<{monitor_payload:Uint8Array;monitor_signature:Uint8Array}[]>`SELECT monitor_payload,monitor_signature FROM account_signup_ceremonies WHERE id=${id}`)[0]!;
      const beforeRetry=monitorCalls;
      coordinator=new SignupCoordinator(db.sql,onboarding,monitoring,providerOrigin,policy,inviteKey);
      const enroll=await call(`signup/${id}/advance`,{enrollmentToken});expect(enroll.status).toBe(200);
      const access=await enroll.json() as {state:string;enrollment:{url:string}};
      expect(access.state).toBe("passkey-enrollment");expect(access.enrollment.url).toBe(`${providerOrigin}/auth/recover#token=${enrollmentToken}`);
      expect(monitorCalls).toBe(beforeRetry); // No new attestation after ambiguous activation.
      expect(await db.sql`SELECT id FROM account_api_credentials`).toHaveLength(0);
      expect(await accounts.authenticate(`Bearer ${setupToken}`)).toBeNull();
      await expect(originalActivate(setup.accountId,{payloadBytes:chosen.monitor_payload,signature:chosen.monitor_signature},{id,epoch:oldEpoch!}))
        .rejects.toThrow("superseded");
      expect((await call(`signup/${id}/advance`,{enrollmentToken})).status).toBe(200);
      expect(await db.sql`SELECT id FROM account_passkey_enrollment_capabilities WHERE account_id=${setup.accountId}`).toHaveLength(1);
      const clock=vi.spyOn(Date,"now").mockReturnValue(Date.now()+11*60_000);
      try{expect((await coordinator.advance(id,setupToken,{enrollmentToken})).state).toBe("enrollment-expired");}
      finally{clock.mockRestore();}
      const expired=vi.spyOn(Date,"now").mockReturnValue(Date.now()+25*3600_000);
      try{
        await expect(coordinator.status(id,setupToken)).rejects.toMatchObject({status:410});
        await expect(coordinator.prepare(request,setupToken)).rejects.toMatchObject({status:410});
      }finally{expired.mockRestore();}
      expect(await db.sql`SELECT id FROM account_passkey_enrollment_capabilities WHERE account_id=${setup.accountId}`).toHaveLength(1);
      expect((await call(`signup/${id}/complete`,{})).status).toBe(401);

      const passkeys=new PasskeyAuth(db.sql,"provider.example.com",providerOrigin),key=generateKeyPairSync("ec",{namedCurve:"prime256v1"});
      const jwk=key.publicKey.export({format:"jwk"}),cose=Buffer.concat([Buffer.from("a5010203262001215820","hex"),Buffer.from(jwk.x!,"base64url"),
        Buffer.from("225820","hex"),Buffer.from(jwk.y!,"base64url")]),credential=encodeBase64Url(randomBytes(32));
      const start=await passkeys.recoveryOptions(enrollmentToken),client=Buffer.from(JSON.stringify({type:"webauthn.create",challenge:start.options.challenge,origin:providerOrigin}));
      const credentialBytes=Buffer.from(credential,"base64url"),auth=Buffer.alloc(55+credentialBytes.length+cose.length);
      createHash("sha256").update("provider.example.com").digest().copy(auth);auth[32]=69;auth.writeUInt16BE(credentialBytes.length,53);
      credentialBytes.copy(auth,55);cose.copy(auth,55+credentialBytes.length);
      const text=(value:string)=>Buffer.concat([Buffer.from([0x60+value.length]),Buffer.from(value)]);
      const attestation=Buffer.concat([Buffer.from([0xa3]),text("fmt"),text("none"),text("attStmt"),Buffer.from([0xa0]),text("authData"),Buffer.from([0x58,auth.length]),auth]);
      await passkeys.recover(enrollmentToken,start.challengeId,{id:credential,rawId:credential,type:"public-key",clientExtensionResults:{},
        response:{clientDataJSON:client.toString("base64url"),attestationObject:attestation.toString("base64url"),transports:["usb"]}},"Signup passkey");
      const postEnrollment=await call(`signup/${id}/advance`,{enrollmentToken});expect(postEnrollment.status).toBe(200);
      expect((await postEnrollment.json() as {state:string}).state).toBe("sign-in-required");
      const signIn=async(counter:number)=>{
        const login=await passkeys.authenticationOptions(),loginClient=Buffer.from(JSON.stringify({type:"webauthn.get",challenge:login.options.challenge,origin:providerOrigin}));
        const loginAuth=Buffer.alloc(37);createHash("sha256").update("provider.example.com").digest().copy(loginAuth);loginAuth[32]=5;loginAuth.writeUInt32BE(counter,33);
        const signature=sign("sha256",Buffer.concat([loginAuth,createHash("sha256").update(loginClient).digest()]),key.privateKey);
        return passkeys.authenticate(login.challengeId,{id:credential,rawId:credential,type:"public-key",clientExtensionResults:{},response:{
          clientDataJSON:loginClient.toString("base64url"),authenticatorData:loginAuth.toString("base64url"),signature:signature.toString("base64url"),
          userHandle:Buffer.from(setup.accountId.replaceAll("-",""),"hex").toString("base64url")}});
      };
      const stale=await signIn(1);
      await db.sql`UPDATE account_passkey_sessions SET created_at=now()-interval '6 minutes' WHERE token_hash=${new Uint8Array(createHash("sha256").update(stale.token).digest())}`;
      expect((await call(`signup/${id}/complete`,{},stale.token)).status).toBe(403);
      const session=await signIn(2);
      expect((await call(`signup/${id}/complete`,{},session.token)).status).toBe(200);
      expect((await call(`signup/${id}/complete`,{},session.token)).status).toBe(200);
      expect((await call(`signup/${id}`)).status).toBe(403);
      expect((await call(`signup/${id}/advance`,{enrollmentToken})).status).toBe(403);
      expect((await call("signup",request)).status).toBe(403);
      await expect(passkeys.recoveryOptions(enrollmentToken)).rejects.toMatchObject({status:401});
      expect(await accounts.authenticate(undefined,session.token)).not.toBeNull();
      expect(await db.sql`SELECT id FROM account_api_credentials`).toHaveLength(0);
      expect((await db.sql<{signup_token_hash:Uint8Array|null}[]>`SELECT signup_token_hash FROM public_onboarding_preparations WHERE account_id=${setup.accountId}`)[0]!.signup_token_hash).toBeNull();
      await expect(db.sql`UPDATE account_signup_ceremonies SET completed_at=NULL,completed_by=NULL WHERE id=${id}`).rejects.toThrow("cannot be replaced");
      const rollback=await db.sql.reserve();try{
        await expect(rollback.unsafe(await Bun.file(new URL("../migrations/rollback/0058_signup_ceremonies.sql",import.meta.url)).text())).rejects.toThrow("prevent rollback");
      }finally{await rollback.unsafe("ROLLBACK");rollback.release();}
      const generationVault=await createUserVault();try{
        const retiredToken=`hailp_${encodeBase64Url(randomBytes(32))}`,retiredId=randomUUID();
        const retired=await coordinator.prepare({...request,signupId:retiredId,address:`retired-${suffix}@provider.example.com`,
          recoveryKey:generationVault.vault.recovery.publicDidKey,identityKey:generationVault.vault.identity.publicDidKey,
          enrollmentHash:encodeBase64Url(randomBytes(32)),invitation:createSignupInvitation(providerOrigin,inviteKey)},retiredToken);
        await db.sql.begin(async tx=>{await tx`SELECT set_config('hail.returning_account',${retired.accountId},true)`;
          await tx`UPDATE account_serving_generations SET generation=2 WHERE account_id=${retired.accountId}`;});
        await expect(coordinator.status(retiredId,retiredToken)).rejects.toMatchObject({status:403});
      }finally{generationVault.recoverySecret.fill(0);}
    }finally{browserVault.recoverySecret.fill(0);}
  } finally {
    vault.recoverySecret.fill(0); await db.close(); await monitorDb.close();
    await admin.unsafe(`DROP SCHEMA "${providerSchema}" CASCADE`); await admin.unsafe(`DROP SCHEMA "${monitorSchema}" CASCADE`); await admin.close();
  }
}, 45_000);
