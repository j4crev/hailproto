/** Private evaluation fixture: real HTTPS/API/Postgres, isolated in-memory PLC.
 * DATABASE_URL must name a disposable database. The runner supplies cert.pem and
 * key.pem, trusts that certificate in CLI children, and maps source.example.com
 * to loopback. Run in a disposable container to bind the profile's fixed port 443.
 * This is local onboarding/Connection/delivery evidence, not a public PLC or
 * cross-provider federation deployment.
 */
import { randomBytes } from "node:crypto";
import { isAbsolute, join } from "node:path";
import { stat, writeFile, readFile, unlink } from "node:fs/promises";
import { parseArgs } from "node:util";
import { cidForCbor } from "@atproto/common";
import { didForCreateOp, formatDidDoc, PlcClientError, validateOperationLog, type Operation } from "@did-plc/lib";
import { encodeBase64Url } from "@hailproto/codec";
import { createApp } from "../../src/app.js";
import type { AppConfig } from "../../src/config.js";
import { ProviderDatabase } from "../../src/db/database.js";
import { AccountApiRepository } from "../../src/accounts/repository.js";
import { AccountMessaging } from "../../src/accounts/messaging.js";
import { BodyRepository } from "../../src/bodies/repository.js";
import { EnvelopeRepository } from "../../src/envelopes/repository.js";
import { EnvelopeService } from "../../src/envelopes/service.js";
import { GrantRepository } from "../../src/grants/repository.js";
import { GrantService } from "../../src/grants/service.js";
import { KeyEncryptor } from "../../src/identity/key-encryption.js";
import { canonicalizeHailAddress } from "../../src/identity/address.js";
import { OnboardingRepository } from "../../src/onboarding/repository.js";
import { PrivatePocOnboarding } from "../../src/onboarding/private-poc.js";
import { ActivationService } from "../../src/onboarding/activation.js";
import { AddressVerifier } from "../../src/discovery/verifier.js";
import { PlcHailDidResolver } from "../../src/plc/resolver.js";
import type { PlcDirectoryClient } from "../../src/plc/client.js";
import { AccountConnections } from "../../src/accounts/connections.js";
import { PasskeyAuth } from "../../src/accounts/passkeys.js";
import { ConnectionMessagingAuthority } from "../../src/accounts/connection-authorization.js";
import { EnvelopeReceiver } from "../../src/envelopes/receiver.js";
import { submitEnvelope } from "../../src/envelopes/submission.js";
import { DeliveryRepository } from "../../src/delivery/repository.js";
import { DeliveryWorker } from "../../src/delivery/worker.js";
import { BodyRetriever } from "../../src/delivery/retriever.js";
import { DeliveryStatusSigner } from "../../src/delivery/status.js";
import { DeliveryStatusReceiver } from "../../src/delivery/status-receiver.js";
import { TerminalStatusPublisher } from "../../src/delivery/status-publisher.js";
import { withFreshServingGenerations } from "../../src/db/serving.js";

const { values } = parseArgs({ args: Bun.argv.slice(2), options: { directory: { type: "string" } }, strict: true });
const directory = values.directory;
if (!directory || !isAbsolute(directory)) throw new Error("--directory must be an absolute private runtime directory");
const info = await stat(directory);
if (!info.isDirectory() || (info.mode & 0o077) !== 0) throw new Error("Runtime directory must have mode 0700");
if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL must name a disposable evaluation database");
// These exact origins are permitted by assertPrivatePocRegistry. Do not relax
// production private-POC guards to accommodate an evaluation's ephemeral ports.
const hostname = "source.example.com";
canonicalizeHailAddress(`fixture@${hostname}`);
const db = new ProviderDatabase(process.env.DATABASE_URL);
const operations = new Map<string, Operation>();
const plc: PlcDirectoryClient = {
  async health() { return { status: "ok" }; },
  async getOperationLog(did) {
    const operation = operations.get(did);
    if (!operation) throw new PlcClientError(404, null, "Unknown private fixture DID");
    return [operation];
  },
  async getDocumentData(did) {
    const data = await validateOperationLog(did, await this.getOperationLog(did));
    if (!data) throw new Error("Private fixture DID has no document");
    return data;
  },
  async getDocument(did) { return formatDidDoc(await this.getDocumentData(did)); },
  async getAuditableLog(did) {
    const operation = (await this.getOperationLog(did))[0]!;
    return [{ did, operation, cid: (await cidForCbor(operation)).toString(), nullified: false, createdAt: new Date().toISOString() }];
  },
  async sendOperation(did, operation) {
    if (operation.prev !== null || await didForCreateOp(operation) !== did) throw new Error("Fixture accepts only valid genesis operations");
    await validateOperationLog(did, [operation]);
    const prior = operations.get(did);
    if (prior && (await cidForCbor(prior)).toString() !== (await cidForCbor(operation)).toString()) throw new Error("Conflicting genesis");
    operations.set(did, operation);
  },
};
let app: ReturnType<typeof createApp> | undefined;
const server = Bun.serve({
  hostname: "127.0.0.1", port: 443,
  tls: { cert: Bun.file(join(directory, "cert.pem")), key: Bun.file(join(directory, "key.pem")) },
  async fetch(request) {
    const response = app ? await app.fetch(request) : new Response(null, { status: 503 });
    // Coordinator-only fault injection: discard one successful persisted response.
    if (response.ok && request.method === "POST") {
      try {
        const fault = JSON.parse(await readFile(join(directory, "lose-response.json"), "utf8"));
        if (fault.path === new URL(request.url).pathname) {
          await unlink(join(directory, "lose-response.json"));
          await response.body?.cancel();
          return Response.json({error:"Fixture lost a persisted response; retry exact artifacts"}, {status:503});
        }
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    }
    return response;
  },
});
let stopping = false;
let worker: Promise<void> | undefined;
async function stop() {
  if (stopping) return;
  stopping = true;
  await worker?.catch(()=>{});
  await server.stop(true);
  await db.close();
}
for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => { void stop().then(() => process.exit(0)); });
try {
  await db.migrate();
  await db.sql`UPDATE provider_registration_settings SET mode='public' WHERE singleton=true`;
  const provider = `https://${hostname}`, base = `${provider}/hail`;
  const repository = new OnboardingRepository(db.sql), accounts = new AccountApiRepository(db.sql);
  const grants = new GrantRepository(db.sql), envelopes = new EnvelopeRepository(db.sql);
  const encryptor = new KeyEncryptor(encodeBase64Url(randomBytes(32))), resolver = new PlcHailDidResolver(plc);
  // Resolve only this fixture's discovery requests through the real app routes.
  // WebFinger uses the address domain's default port; no DNS or public fetch occurs.
  const validateTarget = (url: URL) => {
    if (url.protocol !== "https:" || url.hostname !== hostname || url.username || url.password ||
        (url.port !== "" && url.port !== String(server.port))) throw new Error("Fixture discovery target denied");
  };
  const localFetch = async (request:Request) => {
    const url = new URL(request.url);
    validateTarget(url);
    url.port = String(server.port);
    return app!.fetch(new Request(url, request));
  };
  const verifier = new AddressVerifier(plc, localFetch, validateTarget, undefined, resolver);
  const service = new GrantService(repository, grants, encryptor, resolver, verifier, {
    async verify() { throw new Error("Sender profiles are outside this onboarding fixture"); },
  }, base);
  const connections = new AccountConnections(db.sql, encryptor, resolver, new PasskeyAuth(db.sql,hostname,provider),provider);
  const authority = new ConnectionMessagingAuthority(db.sql,resolver,base,connections.federation);
  const bodies = new BodyRepository(db.sql), statusSigner = new DeliveryStatusSigner(db.sql,repository,encryptor,resolver,base);
  const statusReceiver = new DeliveryStatusReceiver(db.sql,repository,resolver,base);
  const messaging = new AccountMessaging(db.sql, bodies, envelopes,
    new EnvelopeService(repository, grants, envelopes, encryptor, resolver, base,undefined,authority),
    (sender,id) => submitEnvelope(sender,id,envelopes,resolver,statusReceiver,{fetch:localFetch,validateTarget},authority));
  const delivery = new DeliveryWorker(new DeliveryRepository(db.sql,authority),new BodyRetriever(resolver,localFetch,validateTarget));
  const statuses = new TerminalStatusPublisher(db.sql,statusSigner,resolver,localFetch,validateTarget);
  const config: AppConfig = { nodeEnv: "test", port: server.port!, providerId: "agent-eval", publicOrigin: provider,
    hailServiceBase: base, plcDirectoryUrl: "http://plc.fixture:2582", databaseUrl: process.env.DATABASE_URL,
    keyEncryptionKey: encodeBase64Url(randomBytes(32)), pocManagedTransfer: false };
  app = createApp(config, {
    accountApi: { accounts, grants, service, messaging, connections }, discoveryStore: repository,
    bodyStore: bodies, envelopeReceiver:new EnvelopeReceiver(repository,envelopes,resolver,base),
    deliveryStatusSigner:statusSigner,deliveryStatusReceiver:statusReceiver,
    selfServiceOnboarding: { sql: db.sql,
      onboarding: new PrivatePocOnboarding(db.sql, plc, encryptor, config.plcDirectoryUrl, base),
      activation: new ActivationService(repository, verifier, base, "public"), provider, profile: "private-poc" },
    async checkReadiness() { return { ready: true }; },
  });
  worker = (async () => {
    while (!stopping) {
      await withFreshServingGenerations(db.sql,async()=>{
        await connections.federation.workOne();
        await delivery.processOne();
        await statuses.publishOne();
      });
      await Bun.sleep(100);
    }
  })();
  worker.catch(error=>{ console.error("Fixture worker failed", error); void stop().finally(()=>process.exit(1)); });
  await writeFile(join(directory, "ready.json"), JSON.stringify({ provider, hostname, port: server.port,
    profile: "private-poc", plc: "in-memory-private", discovery: "local-app-routes",
    capabilities: ["account-create", "account-show", "credential-list", "inbox-list", "grant-list", "connection-invite", "connection-accept", "connection-send"],
    unsupported: ["cross-provider-federation", "managed-cli-consent"] }) + "\n", { mode: 0o600, flag: "wx" });
} catch (error) {
  await stop();
  throw error;
}
