import { createHash, generateKeyPairSync, randomBytes, randomUUID } from "node:crypto";
import { SQL } from "bun";
import { cidForCbor } from "@atproto/common";
import { formatDidDoc, PlcClientError, validateOperationLog, type Operation } from "@did-plc/lib";
import { encodeBase64Url, decodeBase64Url, inspectSignedPayload } from "@hailproto/codec";
import { expect, it } from "vitest";
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
    registerSignupMonitorRoutes(app, new SignupMonitorService(db.sql, email, new SignupMonitorClient({ apiOrigin: monitorOrigin, token: monitorToken, publicKey: signer.publicDidKey }, monitorFetch)), providerOrigin);
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
  } finally {
    vault.recoverySecret.fill(0); await db.close(); await monitorDb.close();
    await admin.unsafe(`DROP SCHEMA "${providerSchema}" CASCADE`); await admin.unsafe(`DROP SCHEMA "${monitorSchema}" CASCADE`); await admin.close();
  }
}, 45_000);
