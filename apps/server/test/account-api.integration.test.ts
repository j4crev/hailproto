import { createHash, randomBytes, randomUUID } from "node:crypto";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createWebCryptoSigner, encodeBase64Url, signPayload, type HailAddressBinding,
  type HailSenderProfile } from "@hailproto/codec";
import { base58btc } from "multiformats/bases/base58";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createUserVault, unlockUserVault } from "../../hail-user-client-ts/src/vault.js";
import { signGrantRevocation } from "../../hail-user-client-ts/src/grant-revocation.js";
import { AccountApiRepository } from "../src/accounts/repository.js";
import { createApp } from "../src/app.js";
import type { AppConfig } from "../src/config.js";
import { ProviderDatabase } from "../src/db/database.js";
import type { VerifiedAddress } from "../src/discovery/verifier.js";
import { GrantRepository } from "../src/grants/repository.js";
import { GrantService } from "../src/grants/service.js";
import { OnboardingRepository } from "../src/onboarding/repository.js";
import type { HailDidResolver } from "../src/plc/resolver.js";
import type { VerifiedSenderProfile } from "../src/profiles/store.js";
import {AccountMessaging} from "../src/accounts/messaging.js";
import {BodyRepository} from "../src/bodies/repository.js";
import {EnvelopeRepository} from "../src/envelopes/repository.js";
import {EnvelopeService} from "../src/envelopes/service.js";
import {EnvelopeReceiver} from "../src/envelopes/receiver.js";
import {DeliveryRepository} from "../src/delivery/repository.js";
import {DeliveryWorker} from "../src/delivery/worker.js";
import {KeyEncryptor} from "../src/identity/key-encryption.js";
import {inspectSignedPayload} from "@hailproto/codec";
import {ALL_ACCOUNT_SCOPES} from "../src/accounts/repository.js";

const integration = process.env.DATABASE_URL ? describe : describe.skip;
const freshDid = () => `did:plc:${Array.from(randomBytes(24), b => "abcdefghijklmnopqrstuvwxyz234567"[b % 32]).join("")}`;
async function didKey(key: CryptoKey) {
  const bytes = new Uint8Array(34);
  bytes.set([0xed, 0x01]);
  bytes.set(new Uint8Array(await crypto.subtle.exportKey("raw", key)), 2);
  return `did:key:${base58btc.encode(bytes)}`;
}

integration("authenticated account API and real hailp HTTPS CLI", () => {
  let db: ProviderDatabase;
  let accounts: AccountApiRepository;
  let grants: GrantRepository;
  let server: ReturnType<typeof Bun.serve>;
  let receiver: ReturnType<typeof Bun.serve>;
  let app: ReturnType<typeof createApp>;
  let directory: string;
  let origin: string;
  let credential: Awaited<ReturnType<AccountApiRepository["issue"]>>;
  let readonlyCredential: Awaited<ReturnType<AccountApiRepository["issue"]>>;
  let vault: Awaited<ReturnType<typeof createUserVault>>;
  let signedGrant: Uint8Array;
  let grantId: string;
  let senderAvailable = true;
  let redirect = false;
  let losePutResponse = false;
  let loseCredentialResponse = false;
  let redirectedRequests = 0;
  let messageResolver:HailDidResolver;
  const messageEncryptor=new KeyEncryptor(encodeBase64Url(randomBytes(32)));
  const messages: string[]=[];
  let messageError:unknown;
  const ownerId = randomUUID();
  const otherId = randomUUID();
  const senderId = randomUUID();
  const did = freshDid();
  const otherDid = freshDid();
  const senderDid = freshDid();
  const address = `api-owner-${randomUUID()}@source.example.com`;
  const senderAddress = `api-sender-${randomUUID()}@target.example.com`;
  const otherAddress = `api-other-${randomUUID()}@source.example.com`;
  const authorization = () => ({ Authorization: `Bearer ${credential.token}` });
  const grantUrl = () => `${origin}/api/v1/account/grants/${grantId}`;
  const json = async (path: string, value: unknown) => writeFile(join(directory, path), JSON.stringify(value), { mode: 0o600 });
  const credentialRecord = (value: Awaited<ReturnType<AccountApiRepository["issue"]>>) =>
    ({ type: "hailp.api-credential", version: 1, provider: origin, ...value });

  async function cli(args: string[], filename = "owner.credential.json", secret = false) {
    const child = Bun.spawn(["bun", "src/cli/hailp.ts", ...args, "--credentials", join(directory, filename)], {
      cwd: new URL("../../hail-user-client-ts/", import.meta.url).pathname,
      env: { ...Bun.env, NODE_EXTRA_CA_CERTS: join(directory, "cert.pem") },
      stdin: "pipe", stdout: "pipe", stderr: "pipe",
    });
    if (secret) child.stdin.write(`${encodeBase64Url(vault.recoverySecret)}\n`);
    child.stdin.end();
    const [exit, stdout, stderr] = await Promise.all([child.exited,
      new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect(stdout + stderr).not.toContain(credential.token);
    if (secret) expect(stdout + stderr).not.toContain(encodeBase64Url(vault.recoverySecret));
    return { exit, stdout, stderr };
  }

  beforeAll(async () => {
    db = new ProviderDatabase(process.env.DATABASE_URL!);
    await db.migrate();
    accounts = new AccountApiRepository(db.sql);
    grants = new GrantRepository(db.sql);
    directory = await mkdtemp(join(tmpdir(), "hailp-api-"));
    const openssl = Bun.spawn(["openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1",
      "-subj", "/CN=localhost", "-addext", "subjectAltName=DNS:localhost",
      "-addext", "basicConstraints=critical,CA:TRUE", "-keyout", join(directory, "key.pem"),
      "-out", join(directory, "cert.pem")], { stdout: "pipe", stderr: "pipe" });
    if (await openssl.exited !== 0) throw new Error(await new Response(openssl.stderr).text());
    const tls = { cert: Bun.file(join(directory, "cert.pem")), key: Bun.file(join(directory, "key.pem")) };
    receiver = Bun.serve({ hostname: "localhost", port: 0, tls,
      fetch() { redirectedRequests++; return Response.json({}); } });
    server = Bun.serve({ hostname: "localhost", port: 0, tls, async fetch(request) {
      if (redirect) return new Response(null, { status: 302, headers: { Location: `https://localhost:${receiver.port}/` } });
      const response = await app.fetch(request);
      if (loseCredentialResponse && request.method === "POST" && new URL(request.url).pathname === "/api/v1/account/credentials" && response.ok) {
        loseCredentialResponse = false;
        return new Response(null, { status: 503 });
      }
      if (losePutResponse && request.method === "PUT" && response.ok) {
        losePutResponse = false;
        return new Response(null, { status: 503 });
      }
      return response;
    } });
    origin = `https://localhost:${server.port}`;
    for (const [id, accountDid, accountAddress] of [[ownerId, did, address], [otherId, otherDid, otherAddress],
      [senderId, senderDid, senderAddress]] as const) {
      await db.sql`INSERT INTO provider_accounts (id,tenant_id,canonical_address,did,onboarding_state,
        activated_at,activation_binding_digest,activation_verification_mode)
        VALUES (${id},${randomUUID()},${accountAddress},${accountDid},'active',now(),${randomBytes(32)},'public')`;
    }
    vault = await createUserVault();
    vault.vault.did = did;
    const user = await unlockUserVault(JSON.parse(JSON.stringify(vault.vault)), vault.recoverySecret);
    await db.sql`INSERT INTO portable_custody_evidence (account_id,user_recovery_public_key,user_identity_public_key,
      monitor_origin,monitor_confirmed_at,backup_confirmed_at,monitor_verification_mode)
      VALUES (${ownerId},${vault.vault.recovery.publicDidKey},${vault.vault.identity.publicDidKey},
        'https://monitor.example.com',now(),now(),'poc-local')`;
    const sender = await crypto.subtle.generateKey("Ed25519", true, ["sign", "verify"]) as CryptoKeyPair;
    const senderIdentity = await crypto.subtle.generateKey("Ed25519", true, ["sign", "verify"]) as CryptoKeyPair;
    const senderKey = await didKey(sender.publicKey);
    const senderIdentityKey = await didKey(senderIdentity.publicKey);
    const evidence = { document: {}, data: {}, log: [] };
    const resolver: HailDidResolver = { async resolve(value) {
      if (value !== did) throw new Error("No sender lookup is allowed for revocation");
      return { did, identityDidKey: vault.vault.identity.publicDidKey, messagingDidKey: senderKey,
        serviceBase: `${origin}/hail`, evidence };
    } };
    const now = Math.floor(Date.now() / 1000);
    const binding: HailAddressBinding = { type: "hail.address-binding", version: 1, address: senderAddress,
      did: senderDid, issued_at: now, expires_at: now + 3600, key_id: `${senderDid}#hail-identity` };
    const bindingBytes = await signPayload("hail.address-binding", binding, createWebCryptoSigner(binding.key_id, senderIdentity.privateKey));
    const verifiedAddress: VerifiedAddress = { address: senderAddress, did: senderDid, binding,
      representation: bindingBytes, digest: new Uint8Array(createHash("sha256").update(bindingBytes).digest()),
      serviceBase: "https://target.example.com/hail", identityDidKey: senderIdentityKey, messagingDidKey: senderKey,
      plcEvidence: evidence, verifiedAt: new Date() };
    const profile: HailSenderProfile = { type: "hail.sender-profile", version: 1, did: senderDid, revision: 1,
      display_name: "API sender", offers_uncategorized: false, categories: [{ id: "updates", label: "Updates" }],
      updated_at: now, key_id: `${senderDid}#hail-messaging` };
    const profileBytes = await signPayload("hail.sender-profile", profile, createWebCryptoSigner(profile.key_id, sender.privateKey));
    const verifiedProfile: VerifiedSenderProfile = { did: senderDid, profile, representation: profileBytes,
      digest: new Uint8Array(createHash("sha256").update(profileBytes).digest()), serviceBase: verifiedAddress.serviceBase,
      messagingDidKey: senderKey, plcEvidence: evidence, verifiedAt: new Date(), etag: "test-profile" };
    const service = new GrantService(new OnboardingRepository(db.sql), grants,
      { async decrypt() { throw new Error("Provider must never decrypt user keys"); } } as unknown as KeyEncryptor,
      resolver, { async verify() { if (!senderAvailable) throw new Error("Sender offline"); return verifiedAddress; } },
      { async verify() { if (!senderAvailable) throw new Error("Sender offline"); return verifiedProfile; } }, `${origin}/hail`);
    messageResolver={async resolve(value){if(value!==did&&value!==senderDid)throw new Error("Unknown message party");
      const key=await new OnboardingRepository(db.sql).getKey(value===did?ownerId:senderId,"hail-messaging");
      return {did:value,messagingDidKey:key.publicKey,identityDidKey:value===did?vault.vault.identity.publicDidKey:senderIdentityKey,serviceBase:`${origin}/hail`,evidence};}};
    const envelopes=new EnvelopeRepository(db.sql),onboarding=new OnboardingRepository(db.sql);
    const messaging=new AccountMessaging(db.sql,new BodyRepository(db.sql),envelopes,
      new EnvelopeService(onboarding,grants,envelopes,messageEncryptor,messageResolver,`${origin}/hail`),async(sender,id)=>{
        const bytes=await envelopes.sent(sender,id);const envelope=inspectSignedPayload("hail.envelope",bytes!).payload;
        const receiver=new EnvelopeReceiver(onboarding,envelopes,messageResolver,`${origin}/hail`);
        const outcome=await receiver.receive(bytes!);if(!["accepted","duplicate"].includes(outcome))throw new Error(`Not accepted: ${outcome}`);
        if(!messages.includes(id))messages.push(id);
        await db.sql`UPDATE delivery_work work SET next_attempt_at=now()+interval '1 day'
          WHERE message_id<>${id} AND state IN ('accepted','on-hold') AND NOT EXISTS (
            SELECT 1 FROM received_envelopes envelope JOIN provider_migration_fences fence ON fence.account_id=envelope.local_account_id
            WHERE envelope.sender_did=work.sender_did AND envelope.message_id=work.message_id)`;
        const body=await db.sql<{body_bytes:Uint8Array}[]>`SELECT body_bytes FROM detached_bodies WHERE sender_account_id=${sender===did?ownerId:senderId} AND digest=${envelope.body.digest.value}`;
        await new DeliveryWorker(new DeliveryRepository(db.sql),{async retrieve(){return {kind:"success",bytes:new Uint8Array(body[0]!.body_bytes)};}}).processOne();
        return {messageId:id,state:"delivered"};});
    const send=messaging.send.bind(messaging);
    messaging.send=async(...args)=>{try{return await send(...args);}catch(error){messageError=error;throw error;}};
    const proposed = await service.prepareUserSignedGrant(address, senderAddress,
      { scope: { type: "categories", values: ["updates"] }, expiresAt: now + 86400 });
    grantId = proposed.grant_id;
    signedGrant = await user.signGrant(proposed);
    app = createApp({ publicOrigin: origin, hailServiceBase: `${origin}/hail`, providerId: "test" } as AppConfig,
      { accountApi: { accounts, grants, service,messaging }, async checkReadiness() { return { ready: true }; } });
    await json("vault.json", vault.vault);
    await writeFile(join(directory, "initial.cose"), signedGrant, { mode: 0o600 });
    const bootstrap = Bun.spawn(["bun", "src/cli/create-account-credential.ts", address,
      join(directory, "owner.credential.json"), "--write-grants"], { env: { ...Bun.env,
      DATABASE_URL: process.env.DATABASE_URL!, NODE_ENV: "test", PORT: "3000", PROVIDER_ID: "test",
      PUBLIC_ORIGIN: origin, HAIL_SERVICE_BASE: `${origin}/hail`, PLC_DIRECTORY_URL: "http://plc.fixture:2582",
      KEY_ENCRYPTION_KEY: encodeBase64Url(randomBytes(32)) }, stdout: "pipe", stderr: "pipe" });
    if (await bootstrap.exited !== 0) throw new Error(await new Response(bootstrap.stderr).text());
    credential = JSON.parse(await readFile(join(directory, "owner.credential.json"), "utf8"));
    expect(await new Response(bootstrap.stdout).text()).not.toContain(credential.token);
    readonlyCredential = await accounts.issue(address);
    await json("readonly.credential.json", credentialRecord(readonlyCredential));
  });

  afterAll(async () => {
    server?.stop(true);
    receiver?.stop(true);
    if (db) {
      for(const table of ["sent_delivery_status","delivery_status_wrappers","delivery_status_payloads","terminal_status_publications","delivered_messages","verified_body_provenance","delivery_work","reply_capabilities","received_envelopes","sent_envelopes","body_authorizations","detached_bodies"]){
        if(table==="received_envelopes") {
          await db.sql`DELETE FROM received_envelopes WHERE sender_did IN (${did},${senderDid}) AND authorization_type='reply'`;
          await db.sql`DELETE FROM sent_envelopes WHERE sender_did IN (${did},${senderDid}) AND authorization_type='reply'`;
        }
        const column=table==="reply_capabilities"?"original_sender_did":table==="verified_body_provenance"?"sender_did":table==="body_authorizations"||table==="detached_bodies"?"sender_account_id":"sender_did";
        await db.sql.unsafe(`DELETE FROM ${table} WHERE ${column} IN ($1,$2)`,column==="sender_account_id"?[ownerId,senderId]:[did,senderDid]);}
      await db.sql`DELETE FROM provider_migration_fences WHERE account_id IN (${ownerId},${otherId},${senderId})`;
      await db.sql`DELETE FROM account_api_credentials WHERE account_id IN (${ownerId},${otherId},${senderId})`;
      if (grantId) {
        await db.sql`DELETE FROM collocated_grant_receivers WHERE grant_id = ${grantId}`;
        await db.sql`DELETE FROM grant_publications WHERE grant_id = ${grantId}`;
        await db.sql`DELETE FROM grant_consent_evidence WHERE grant_id = ${grantId}`;
        await db.sql`DELETE FROM grant_revisions WHERE grant_id = ${grantId}`;
        await db.sql`DELETE FROM grant_lineages WHERE grant_id = ${grantId}`;
      }
      await db.sql`DELETE FROM portable_custody_evidence WHERE account_id = ${ownerId}`;
      await db.sql`DELETE FROM account_keys WHERE account_id IN (${ownerId},${senderId})`;
      await db.sql`DELETE FROM provider_accounts WHERE id IN (${ownerId},${otherId},${senderId})`;
      await db.close();
    }
    vault?.recoverySecret.fill(0);
    if (directory) await rm(directory, { recursive: true, force: true });
  });

  it("bootstraps a hashed credential and runs real HTTPS account/show/signed-import commands", async () => {
    const missing = await app.request(`${origin}/api/v1/account`);
    expect(missing.status).toBe(401);
    expect(missing.headers.get("Cache-Control")).toBe("no-store");
    expect(missing.headers.get("Content-Type")).toBe("application/problem+json");
    const result = await cli(["account", "show"]);
    if (result.exit) throw new Error(result.stderr);
    expect(JSON.parse(result.stdout)).toMatchObject({ accountId: ownerId, did, custodyProfile: "owner-controlled",
      monitorVerificationMode: "poc-local", identityPublicKey: vault.vault.identity.publicDidKey });
    const imported = await cli(["grant", "create", senderAddress, "--category", "updates", "--vault",
      join(directory,"vault.json"),"--output",join(directory,"created.cose")],"owner.credential.json",true);
    if (imported.exit) throw new Error(imported.stderr);
    grantId = JSON.parse(imported.stdout).grantId;
    signedGrant = new Uint8Array(await readFile(join(directory,"created.cose")));
    await writeFile(join(directory,"initial.cose"),signedGrant);
    expect(JSON.parse(imported.stdout)).toMatchObject({ grantId, revision: 1, status: "active" });
    const retried = await cli(["grant", "create", senderAddress, "--category", "updates", "--vault",
      join(directory,"vault.json"),"--output",join(directory,"created.cose")],"owner.credential.json",true);
    expect(retried.exit).toBe(0);
    expect(JSON.parse(retried.stdout).grantId).toBe(grantId);
    expect(JSON.parse((await cli(["grant","list"])).stdout).grants).toHaveLength(1);
    expect((await cli(["grant", "submit", join(directory, "initial.cose")])).exit).toBe(0);
    const shown = await cli(["grant", "show", grantId, "--output", join(directory, "copy.cose")]);
    if (shown.exit) throw new Error(shown.stderr);
    expect(JSON.parse(shown.stdout)).toMatchObject({ grantId, localRole: "grantor" });
    expect(new Uint8Array(await readFile(join(directory, "copy.cose")))).toEqual(signedGrant);
    const rows = await db.sql<{ token_hash: Uint8Array }[]>`SELECT token_hash FROM account_api_credentials WHERE id=${credential.credentialId}`;
    expect(Buffer.from(rows[0]!.token_hash).toString("hex")).toBe(createHash("sha256").update(credential.token).digest("hex"));
    expect(await db.sql`SELECT role FROM account_keys WHERE account_id=${ownerId}`).toHaveLength(0);
  });

  it("enforces scopes, cross-account isolation and collocated sender read-only ownership", async () => {
    const put = (headers: HeadersInit) => app.request(grantUrl(), { method: "PUT", headers,
      body: Uint8Array.from(signedGrant) });
    expect((await put({ Authorization: `Bearer ${readonlyCredential.token}` })).status).toBe(403);
    const readonlyOutput = join(directory, "readonly-revocation.cose");
    const readonlyAttempt = await cli(["grant", "revoke", grantId, "--vault", join(directory, "vault.json"),
      "--output", readonlyOutput], "readonly.credential.json", true);
    expect(readonlyAttempt.exit).toBe(1);
    expect(readonlyAttempt.stderr).toContain("write permission");
    await expect(readFile(readonlyOutput)).rejects.toMatchObject({ code: "ENOENT" });
    const other = await accounts.issue(otherAddress, true);
    expect((await app.request(grantUrl(), { headers: { Authorization: `Bearer ${other.token}` } })).status).toBe(404);
    expect((await put({ Authorization: `Bearer ${other.token}`, "Content-Type": 'application/cose; cose-type="cose-sign1"' })).status).toBe(404);
    await db.sql`INSERT INTO collocated_grant_receivers (grant_id,grantee_account_id) VALUES (${grantId},${senderId})`;
    const sender = await accounts.issue(senderAddress, true);
    await json("sender.credential.json", credentialRecord(sender));
    const shown = await cli(["grant", "show", grantId], "sender.credential.json");
    expect(shown.exit).toBe(0);
    expect(JSON.parse(shown.stdout).localRole).toBe("grantee");
    const refused = await cli(["grant", "revoke", grantId, "--vault", join(directory, "vault.json"),
      "--output", join(directory, "wrong.cose")], "sender.credential.json", true);
    expect(refused.exit).toBe(1);
    expect(refused.stderr).toContain("authoritative grantor");
    const bad = Uint8Array.from(signedGrant);
    bad[bad.length - 1] = bad[bad.length - 1]! ^ 1;
    expect((await app.request(grantUrl(), { method: "PUT", headers: { ...authorization(),
      "Content-Type": 'application/cose; cose-type="cose-sign1"' }, body: bad })).status).toBe(400);
    expect((await grants.findCurrentByGrantId(grantId))?.payload.status).toBe("active");
  });

  it("inventories credentials and issues deliberate subsets with exact retries and no scope escalation", async () => {
    const manager = await accounts.issue(address, false, undefined, [...ALL_ACCOUNT_SCOPES]);
    await json("credential-manager.json", credentialRecord(manager));
    const path = join(directory, "agent.credential.json");
    const args = ["credential", "create", "--output", path, "--scope", "grants:read", "--scope", "account:read"];
    loseCredentialResponse = true;
    const lost = await cli(args, "credential-manager.json");
    expect(lost.stderr).toContain("HTTP_503");
    const pending = JSON.parse(await readFile(path, "utf8"));
    expect(pending.scopes).toEqual(["account:read", "grants:read"]);
    const committed = await db.sql<{id:string}[]>`SELECT id FROM account_api_credentials WHERE token_hash=${new Uint8Array(createHash("sha256").update(pending.token).digest())}`;
    expect(committed).toHaveLength(1);
    const created = await cli(args, "credential-manager.json");
    expect(created.exit, created.stderr).toBe(0);
    const child = JSON.parse(await readFile(path, "utf8"));
    expect(child.credentialId).toBe(committed[0]!.id);
    expect(child.token).toBe(pending.token);
    expect(child.scopes).toEqual(["account:read", "grants:read"]);
    expect(created.stdout + created.stderr).not.toContain(child.token);
    const retry = await cli(args, "credential-manager.json");
    expect(retry.exit, retry.stderr).toBe(0);
    expect(JSON.parse(retry.stdout).credentialId).toBe(child.credentialId);
    expect((await cli(["credential", "create", "--output", path, "--scope", "account:read"], "credential-manager.json")).exit).toBe(1);
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual(child);
    expect((await cli(["credential", "list"], "agent.credential.json")).stderr).toContain("HTTP_403");
    const forbiddenPath = join(directory, "forbidden.credential.json");
    expect((await cli(["credential", "create", "--output", forbiddenPath], "agent.credential.json")).exit).toBe(1);
    await expect(readFile(forbiddenPath)).rejects.toThrow();

    const limited = await accounts.issue(address, false, undefined, ["account:read", "credentials:write"]);
    const endpoint = `${origin}/api/v1/account/credentials`;
    const post = (token: string, input: unknown) => app.request(endpoint, { method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify(input) });
    const freshToken = () => `hailp_${encodeBase64Url(randomBytes(32))}`;
    expect((await post(limited.token, { token: freshToken(), scopes: ["grants:write"] })).status).toBe(403);
    expect((await post(child.token, { token: freshToken(), scopes: [...ALL_ACCOUNT_SCOPES] })).status).toBe(403);
    for (const scopes of [[], ["account:read", "account:read"], ["unknown"], "account:read"]) {
      expect((await post(manager.token, { token: freshToken(), scopes })).status).toBe(400);
    }
    expect((await post(manager.token, { token: child.token, scopes: [...ALL_ACCOUNT_SCOPES] })).status).toBe(409);
    expect((await post(limited.token, { token: manager.token })).status).toBe(409);
    expect((await post(manager.token, { token: freshToken(), revoke: child.credentialId })).status).toBe(400);
    const duplicate = await app.request(endpoint, { method: "POST", headers: {
      Authorization: `Bearer ${manager.token}`, "Content-Type": "application/json" },
      body: `{"token":"${freshToken()}","scopes":["account:read"],"scopes":[]}` });
    expect(duplicate.status).toBe(400);
    expect((await app.request(endpoint, { method: "POST", headers: {
      Authorization: `Bearer ${manager.token}`, "Content-Type": "application/json", "Content-Encoding": "gzip" }, body: "{}" })).status).toBe(415);

    await accounts.revoke(child.credentialId, ownerId);
    expect((await post(manager.token, { token: child.token, scopes: child.scopes })).status).toBe(409);
    const expired = await accounts.issue(address);
    await db.sql`UPDATE account_api_credentials SET created_at=now()-interval '2 days', expires_at=now()-interval '1 day' WHERE id=${expired.credentialId}`;
    expect((await post(manager.token, { token: expired.token, scopes: expired.scopes })).status).toBe(409);
    const foreign = await accounts.issue(otherAddress, false, undefined, [...ALL_ACCOUNT_SCOPES]);
    expect((await post(manager.token, { token: foreign.token, scopes: foreign.scopes })).status).toBe(409);
    for (let index = 0; index < 51; index++) await accounts.issue(address);
    const inventory = await cli(["credential", "list"], "credential-manager.json");
    expect(inventory.exit, inventory.stderr).toBe(0);
    const page = JSON.parse(inventory.stdout);
    expect(page.credentials).toHaveLength(50);
    expect(page.next).toBe(page.credentials[49].credentialId);
    const following = await cli(["credential", "list", "--after", page.next], "credential-manager.json");
    expect(following.exit, following.stderr).toBe(0);
    const last = JSON.parse(following.stdout);
    expect(last.next).toBeNull();
    const all = [...page.credentials, ...last.credentials];
    const count = await db.sql<{count:number}[]>`SELECT count(*)::integer AS count FROM account_api_credentials WHERE account_id=${ownerId}`;
    expect(all).toHaveLength(count[0]!.count);
    expect(new Set(all.map(row => row.credentialId)).size).toBe(all.length);
    expect(all.some(row => row.credentialId === foreign.credentialId)).toBe(false);
    expect(all.find(row => row.credentialId === child.credentialId).status).toBe("revoked");
    expect(all.find(row => row.credentialId === expired.credentialId).status).toBe("expired");
    for (const row of all) expect(Object.keys(row)).toEqual(["credentialId", "scopes", "createdAt", "expiresAt", "revokedAt", "status"]);
    expect(inventory.stdout + following.stdout).not.toContain(manager.token);
    const combined = await cli(["credential", "list", "--pages", "2", "--provider", origin, "--account-id", ownerId], "credential-manager.json");
    expect(combined.exit, combined.stderr).toBe(0);
    expect(JSON.parse(combined.stdout)).toMatchObject({ cliContractVersion: 1, credentials: all, next: null });
    const mismatched = await cli(["credential", "list", "--provider", "https://other.example.com"], "credential-manager.json");
    expect(mismatched.exit).toBe(1); expect(mismatched.stdout).toBe("");
    expect(JSON.parse(mismatched.stderr).error.code).toBe("SELECTION_MISMATCH");
    expect((await app.request(`${endpoint}?after=not-a-uuid`, { headers: { Authorization: `Bearer ${manager.token}` } })).status).toBe(400);
    expect((await app.request(`${endpoint}?account=${otherId}`, { headers: { Authorization: `Bearer ${manager.token}` } })).status).toBe(400);
  });

  it("sends, reads inbox and replies through real CLI with durable message IDs and scoped ownership",async()=>{
    for(const id of [ownerId,senderId]){
      const key=await crypto.subtle.generateKey("Ed25519",true,["sign","verify"]) as CryptoKeyPair;
      const publicKey=await didKey(key.publicKey),raw=new Uint8Array(await crypto.subtle.exportKey("pkcs8",key.privateKey));
      const encrypted=await messageEncryptor.encrypt(id,"hail-messaging","ed25519",publicKey,raw);raw.fill(0);
      await db.sql`INSERT INTO account_keys (account_id,role,algorithm,public_key,encrypted_private_key,encryption_nonce,encryption_version,kek_id)
        VALUES (${id},'hail-messaging','ed25519',${publicKey},${encrypted.ciphertext},${encrypted.nonce},1,'poc-v1')`;}
    await json("message-sender.credential.json",credentialRecord(await accounts.issue(senderAddress,false,undefined,[...ALL_ACCOUNT_SCOPES])));
    await json("message-owner.credential.json",credentialRecord(await accounts.issue(address,false,undefined,[...ALL_ACCOUNT_SCOPES])));
    const rotatedPath=join(directory,"self-service.credential.json");
    const rotated=await cli(["credential","create","--output",rotatedPath],"message-owner.credential.json");if(rotated.exit)throw new Error(rotated.stderr);
    const rotatedId=JSON.parse(rotated.stdout).credentialId;
    expect((await cli(["credential","create","--output",rotatedPath],"message-owner.credential.json")).exit).toBe(0);
    expect((await cli(["credential","revoke",rotatedId],"message-owner.credential.json")).exit).toBe(0);
    expect((await cli(["account","show"],"self-service.credential.json")).exit).toBe(1);
    await writeFile(join(directory,"text.txt"),"CLI message");
    const args=["send","--grant",grantId,"--category","updates","--file",join(directory,"text.txt"),"--state",join(directory,"message-state.json"),"--reply-until",String(Math.floor(Date.now()/1000)+86400)];
    const sent=await cli(args,"message-sender.credential.json");if(sent.exit)throw new Error(`${sent.stderr} ${String(messageError)}`);
    const id=JSON.parse(sent.stdout).messageId;
    const retry=await cli(args,"message-sender.credential.json");expect(retry.exit).toBe(0);expect(JSON.parse(retry.stdout).messageId).toBe(id);
    // Delivery happened in the fixture, but no authenticated status was retained
    // by its sender. Waiting must not infer acceptance from the send response.
    const waited=await cli(["message","status",id,"--wait","1","--interval","1"],"message-sender.credential.json");
    expect(waited.exit,waited.stderr).toBe(0);
    expect(JSON.parse(waited.stdout)).toMatchObject({cliContractVersion:1,messageId:id,state:"indeterminate",revision:null,
      wait:{completed:false,timedOut:true}});
    const inbox=await cli(["inbox","list","--pages","2"],"message-owner.credential.json");expect(inbox.exit).toBe(0);expect(JSON.parse(inbox.stdout).messages).toHaveLength(1);
    const read=await cli(["inbox","show",senderDid,id],"message-owner.credential.json");if(read.exit)throw new Error(read.stderr);
    expect(JSON.parse(read.stdout).body.blocks[0].children[0].text).toBe("CLI message");
    expect(JSON.parse(read.stdout).reply.allowed).toBe(true);
    expect((await cli(["inbox","show",senderDid,id],"message-sender.credential.json")).exit).toBe(1);
    const reply=await cli(["reply",id,"--file",join(directory,"text.txt"),"--state",join(directory,"reply-state.json")],"message-owner.credential.json");if(reply.exit)throw new Error(reply.stderr);
    expect((await cli(["inbox","list"],"message-sender.credential.json")).exit).toBe(0);
    await writeFile(join(directory,"text.txt"),"changed");
    expect((await cli(args,"message-sender.credential.json")).exit).toBe(1);
    expect(await db.sql`SELECT message_id FROM delivered_messages WHERE sender_did=${senderDid} AND message_id=${id}`).toHaveLength(1);
  });

  it("rejects fenced writes and recovers a committed revocation after a lost response without user keys at the provider", async () => {
    senderAvailable = false;
    const revoked = await signGrantRevocation(join(directory, "vault.json"), signedGrant, grantId,
      senderAddress, join(directory, "fence.cose"), vault.recoverySecret);
    await db.sql`INSERT INTO provider_migration_fences (did,account_id,transfer_id,destination_service_base,state)
      VALUES (${did},${ownerId},${randomUUID()},'https://target.example.com/hail','fenced')`;
    expect((await app.request(grantUrl(), { method: "PUT", headers: { ...authorization(),
      "Content-Type": 'application/cose; cose-type="cose-sign1"' }, body: Uint8Array.from(revoked) })).status).toBe(409);
    await expect(accounts.issue(address)).rejects.toThrow("migration-fenced");
    expect((await grants.findCurrentByGrantId(grantId))?.payload.status).toBe("active");
    await db.sql`DELETE FROM provider_migration_fences WHERE account_id=${ownerId}`;
    const args = ["grant", "revoke", grantId, "--vault", join(directory, "vault.json"),
      "--output", join(directory, "revoked.cose")];
    losePutResponse = true;
    const lost = await cli(args, "owner.credential.json", true);
    expect(lost.exit).toBe(1);
    expect(lost.stderr).toContain("HTTP_503");
    const first = await readFile(join(directory, "revoked.cose"));
    const retry = await cli(args, "owner.credential.json", true);
    if (retry.exit) throw new Error(retry.stderr);
    expect(JSON.parse(retry.stdout)).toMatchObject({ grantId, status: "revoked", revision: 2 });
    expect(await readFile(join(directory, "revoked.cose"))).toEqual(first);
    expect(await db.sql`SELECT revision FROM grant_revisions WHERE grant_id=${grantId}`).toHaveLength(2);
    expect(await db.sql`SELECT revision FROM grant_publications WHERE grant_id=${grantId}`).toHaveLength(2);
    expect((await grants.findReceivedForSender(grantId, senderDid))?.payload.status).toBe("revoked");
    expect(await db.sql`SELECT role FROM account_keys WHERE account_id=${ownerId} AND role='hail-identity'`).toHaveLength(0);
  });

  it("bounds transport and authenticates before revealing account or Grant validation", async () => {
    expect((await app.request(`${origin}/api/v1/account/grants/not-an-id`)).status).toBe(401);
    expect((await app.request(grantUrl(), { method: "POST", headers: authorization() })).status).toBe(405);
    expect((await app.request(`${origin}/api/v1/account?account=${otherId}`, { headers: authorization() })).status).toBe(400);
    expect((await app.request(grantUrl(), { method: "PUT", headers: { ...authorization(),
      "Content-Type": "application/json" }, body: "{}" })).status).toBe(415);
    expect((await app.request(grantUrl(), { method: "PUT", headers: { ...authorization(),
      "Content-Type": 'application/cose; cose-type="cose-sign1"' }, body: new Uint8Array(262_145) })).status).toBe(413);
    const hidden = await cli(["account", "show"], credential.token);
    expect(hidden.exit).toBe(1);
    expect(hidden.stderr).toContain("[REDACTED]");
  });

  it("rejects redirects, insecure credential files, expired credentials and revoked credentials", async () => {
    redirect = true;
    try {
      const refused = await cli(["account", "show"]);
      expect(refused.exit).toBe(1);
      expect(redirectedRequests).toBe(0);
    } finally { redirect = false; }
    const file = join(directory, "readonly.credential.json");
    await chmod(file, 0o644);
    expect((await cli(["account", "show"], "readonly.credential.json")).exit).toBe(1);
    await chmod(file, 0o600);
    await db.sql`UPDATE account_api_credentials SET created_at=now()-interval '2 days',
      expires_at=now()-interval '1 day' WHERE id=${readonlyCredential.credentialId}`;
    const expired = await cli(["account", "show"], "readonly.credential.json");
    expect(expired.stderr).toContain("HTTP_401");
    await accounts.revoke(credential.credentialId);
    await accounts.revoke(credential.credentialId);
    const revoked = await cli(["account", "show"]);
    expect(revoked.stderr).toContain("HTTP_401");
  });
});
