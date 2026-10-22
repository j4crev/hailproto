import { createHash, randomBytes, randomUUID } from "node:crypto";
import { SQL } from "bun";
import { cidForCbor } from "@atproto/common";
import { P256Keypair } from "@atproto/crypto";
import { didForCreateOp, formatDidDoc, PlcClientError, signOperation, validateOperationLog, type Operation } from "@did-plc/lib";
import { createWebCryptoSigner, encodeBase64Url, inspectSignedPayload, signPayload } from "@hailproto/codec";
import { expect, it } from "vitest";
import { ProviderDatabase } from "../src/db/database.js";
import { KeyEncryptor } from "../src/identity/key-encryption.js";
import { signOnboardingMonitorAttestation } from "../src/migration/monitor-attestation.js";
import { OnboardingRepository } from "../src/onboarding/repository.js";
import { PublicOnboarding } from "../src/onboarding/public.js";
import type { PlcDirectoryClient } from "../src/plc/client.js";
import { PlcHailDidResolver } from "../src/plc/resolver.js";
import { VerifiedPublicPlcResolver } from "../src/plc/public-resolver.js";
import { plcStateDigest } from "../src/plc/read-evidence.js";
import { publicEdKey } from "./public-plc-fixture.js";
import { SameProviderCustodyTransition } from "../src/accounts/custody-transition.js";
import { ManagedTransferAuthorization } from "../src/migration/managed-authorization.js";
import { encodeManagedHandshake, managedHandshakeSignatureInput } from "../src/migration/managed-handshake.js";
import { Hono } from "hono";
import { SignupEmailClient, registerSignupEmailRoutes } from "../src/onboarding/email.js";

it.skipIf(!process.env.DATABASE_URL)("public owner/managed onboarding seals owner, monitor, reads and binding atomically", async () => {
  const admin = new SQL(process.env.DATABASE_URL!), schema = `public_onboarding_${randomUUID().replaceAll("-", "")}`;
  await admin.unsafe(`CREATE SCHEMA "${schema}"`);
  const url = new URL(process.env.DATABASE_URL!); url.searchParams.set("options", `-csearch_path=${schema}`);
  const db = new ProviderDatabase(url.toString()), logs = new Map<string, Operation[]>();
  const auditCreatedAt = new Date().toISOString();
  let ambiguous = true;
  const plc: PlcDirectoryClient = {
    async health() { return { status: "ok" }; },
    async sendOperation(did, operation) { logs.set(did, [operation]); if (ambiguous) { ambiguous = false; throw new Error("lost response"); } },
    async getOperationLog(did) { const log = logs.get(did); if (!log) throw new PlcClientError(404, null, "missing"); return log; },
    async getDocumentData(did) { return (await validateOperationLog(did, await this.getOperationLog(did)))!; },
    async getDocument(did) { return formatDidDoc(await this.getDocumentData(did)); },
    async getAuditableLog(did) { return Promise.all((await this.getOperationLog(did)).map(async operation => ({
      did, operation, cid: (await cidForCbor(operation)).toString(), nullified: false, createdAt: auditCreatedAt,
    }))); },
  };
  const reader = (name: string) => ({ origin: `https://reader-${name}.example.com`, operator: `reader-${name}`,
    resolver: new PlcHailDidResolver(plc), audit: (did: string) => plc.getAuditableLog(did),
    health: async () => ({ lastCommittedOpTime: new Date().toISOString() }) });
  const resolver = new VerifiedPublicPlcResolver(db.sql, [reader("one"), reader("two")], ["provider"], ["https://local.example.com"]);
  const repository = new OnboardingRepository(db.sql), base = "https://local.example.com/hail";
  const verifier = { async verify(address: string) {
    const account = await repository.getAccountByAddress(address), binding = await repository.getBindingForAccount(account.id);
    const resolved = await resolver.resolve(account.did!);
    return { address, did: account.did!, serviceBase: resolved.serviceBase, identityDidKey: resolved.identityDidKey,
      messagingDidKey: resolved.messagingDidKey, plcEvidence: resolved.evidence, verifiedAt: new Date(),
      binding: inspectSignedPayload("hail.address-binding", binding.cose).payload,
      representation: binding.cose, digest: binding.digest };
  } };
  const service = new PublicOnboarding(db.sql, plc, resolver,
    new KeyEncryptor(encodeBase64Url(randomBytes(32))), "https://plc.directory", base, verifier);
  try {
    await db.migrate();
    for (const { custody, alpha } of [{ custody: "owner-controlled", alpha: false },
      { custody: "managed", alpha: false }, { custody: "managed", alpha: true }] as const) {
      const owner = await P256Keypair.create(), identity = await publicEdKey(), monitor = await publicEdKey();
      const address = `${custody}-${randomUUID()}@local.example.com`;
      const current = alpha ? new PublicOnboarding(db.sql, plc, resolver,
        new KeyEncryptor(encodeBase64Url(randomBytes(32))), "https://plc.directory", base, verifier,
        { profile: "reduced-assurance-alpha-v1", monitorOrigin: "https://monitor.example.com", monitorPublicKey: monitor.didKey }) : service;
      const signupToken = `hailp_${encodeBase64Url(randomBytes(32))}`;
      const hash = new Uint8Array(createHash("sha256").update(signupToken).digest());
      if (alpha) {
        await expect(current.prepare(address, owner.did(), identity.didKey, true, custody,
          "https://monitor.example.com", monitor.didKey, hash)).rejects.toThrow("explicit");
        await expect(current.prepare(address, owner.did(), identity.didKey, true, "owner-controlled",
          "https://monitor.example.com", monitor.didKey, hash, true)).rejects.toThrow("explicit");
        await expect(current.prepare(address, owner.did(), identity.didKey, true, custody,
          "https://other-monitor.example.com", monitor.didKey, hash, true)).rejects.toThrow("pinned");
      }
      const prepared = await current.prepare(address, owner.did(), identity.didKey, true, custody,
        "https://monitor.example.com", monitor.didKey, hash, alpha);
      expect(prepared.monitorAssurance).toBe(alpha ? "reduced-assurance-alpha-v1" : "independent");
      expect((await current.prepare(address, owner.did(), identity.didKey, true, custody,
        "https://monitor.example.com", monitor.didKey, hash, alpha)).accountId).toBe(prepared.accountId);
      if (alpha) await expect(service.prepare(address, owner.did(), identity.didKey, true, custody,
        "https://monitor.example.com", monitor.didKey, hash)).rejects.toThrow("different");
      let emailed = 0;
      const emailApp = new Hono();
      registerSignupEmailRoutes(emailApp, db.sql, new SignupEmailClient({ origin: "https://alerts.example.com", token: encodeBase64Url(randomBytes(32)) },
        (async (_url: string | URL | Request, init?: RequestInit) => {
          const input = JSON.parse(init!.body as string); emailed++;
          expect(input.signupHash).toBe(encodeBase64Url(hash));
          return Response.json({ bound: true, did: input.did, operationCid: input.operationCid });
        }) as unknown as typeof fetch), "https://local.example.com");
      const emailBind = (token = signupToken) => emailApp.request("https://local.example.com/api/v1/signup-email/bind", { method: "POST",
        headers: { "Content-Type": "application/json", Origin: "https://local.example.com", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ signupId: randomUUID(), accountId: prepared.accountId }) });
      expect((await emailBind()).status).toBe(403); // No registered owner-authorized identity yet.
      const operation = await signOperation({ type: "plc_operation", prev: null,
        rotationKeys: [owner.did(), prepared.providerRotationKey],
        verificationMethods: { "hail-identity": prepared.userIdentityKey, "hail-messaging": prepared.providerMessagingKey },
        alsoKnownAs: [], services: { hail: { type: "HailMessaging", endpoint: base } } }, owner);
      const did = await didForCreateOp(operation);
      const now = Math.floor(Date.now() / 1000);
      const binding = custody === "managed" ? new Uint8Array() : await signPayload("hail.address-binding",
        { type: "hail.address-binding", version: 1, address, did, issued_at: now, expires_at: now + 86400,
          key_id: `${did}#hail-identity` }, createWebCryptoSigner(`${did}#hail-identity`, identity.pair.privateKey));
      const operationBytes = new TextEncoder().encode(JSON.stringify(operation));
      if (alpha) await expect(service.register(prepared.accountId, operationBytes, binding)).rejects.toThrow("assurance");
      const registered = await current.register(prepared.accountId, operationBytes, binding);
      expect(registered).toMatchObject({ did, state: "address-staged" });
      expect((await repository.getAccount(prepared.accountId)).state).toBe("address-staged");
      expect((await emailBind(`hailp_${encodeBase64Url(randomBytes(32))}`)).status).toBe(403);
      expect((await emailBind()).status).toBe(alpha ? 200 : 403);
      expect(emailed).toBe(alpha ? 1 : 0);
      expect(await db.sql`SELECT account_id FROM public_onboarding_evidence WHERE account_id=${prepared.accountId}`).toHaveLength(0);
      const state = await plc.getDocumentData(did), payload = {
        type: "hail.plc-onboarding-monitor-attestation" as const, version: 1 as const, did,
        operation_cid: registered.operationCid, monitor_origin: "https://monitor.example.com",
        coverage_since: now - 1000, observed_at: now, bootstrap_state_digest: plcStateDigest(state), export_sequence: 1,
      };
      const stale = await signOnboardingMonitorAttestation({ ...payload, observed_at: now - 301 }, monitor.pair.privateKey);
      await expect(current.activate(prepared.accountId, stale)).rejects.toThrow("stale");
      expect((await repository.getAccount(prepared.accountId)).state).toBe("address-staged");
      expect(await db.sql`SELECT account_id FROM public_onboarding_evidence WHERE account_id=${prepared.accountId}`).toHaveLength(0);
      const attestation = await signOnboardingMonitorAttestation(payload, monitor.pair.privateKey);
      if (alpha) {
        await expect(service.activate(prepared.accountId, attestation)).rejects.toThrow("assurance");
        // An old writer omitting the assurance column cannot label an alpha
        // preparation independent. All other evidence is structurally valid.
        const prior = (await db.sql<{ account_id: string }[]>`SELECT account_id FROM public_onboarding_evidence LIMIT 1`)[0]!;
        await expect(db.sql`INSERT INTO public_onboarding_evidence
          (account_id,did,operation_cid,genesis_digest,binding_digest,plc_evidence_digest,monitor_origin,monitor_public_key,
           monitor_payload,monitor_signature,monitor_state_digest,monitor_export_sequence,activated_at,record_version,read_evidence_policy_version)
          SELECT ${prepared.accountId},${did},${registered.operationCid},genesis_digest,binding_digest,plc_evidence_digest,
            monitor_origin,monitor_public_key,${attestation.payloadBytes},${attestation.signature},monitor_state_digest,
            monitor_export_sequence,activated_at,record_version,read_evidence_policy_version
          FROM public_onboarding_evidence WHERE account_id=${prior.account_id}`).rejects.toThrow(/foreign key/);
      }
      await current.activate(prepared.accountId, attestation);
      await current.activate(prepared.accountId, attestation);
      expect((await repository.getAccount(prepared.accountId)).activationVerificationMode).toBe("public");
      expect(await db.sql`SELECT account_id FROM public_onboarding_evidence WHERE account_id=${prepared.accountId}
        AND record_version=1 AND read_evidence_policy_version='hail.plc-read-evidence-v1'
        AND monitor_assurance=${alpha ? "reduced-assurance-alpha-v1" : "independent"}`).toHaveLength(1);
      expect(await db.sql`SELECT action_type FROM public_signing_authority_evidence WHERE local_account_id=${prepared.accountId} AND action_type='address-binding'`).toHaveLength(1);
      if (custody === "managed") expect(await db.sql`SELECT account_id FROM managed_custody_evidence WHERE account_id=${prepared.accountId}
        AND verification_mode=${alpha ? "reduced-assurance-alpha-v1" : "strict-public-v1"}
        AND managed_profile_version='hail-managed-custody-v1'`).toHaveLength(1);
      else expect(await db.sql`SELECT account_id FROM portable_custody_evidence WHERE account_id=${prepared.accountId} AND monitor_verification_mode='independent'`).toHaveLength(1);
      await expect(current.activate(prepared.accountId, { ...attestation, signature: Uint8Array.from(attestation.signature, byte => byte ^ 1) })).rejects.toThrow("changed");
      if (alpha) {
        await expect(service.activate(prepared.accountId, attestation)).rejects.toThrow("assurance");
        await expect(db.sql`UPDATE managed_custody_evidence SET verification_mode='strict-public-v1' WHERE account_id=${prepared.accountId}`)
          .rejects.toThrow("explicit assurance transition");
        await expect(db.sql`DELETE FROM managed_custody_evidence WHERE account_id=${prepared.accountId}`)
          .rejects.toThrow("explicit assurance transition");
        const encryptor = new KeyEncryptor(encodeBase64Url(randomBytes(32)));
        await expect(new SameProviderCustodyTransition(db.sql, plc, resolver, encryptor, base, verifier)
          .reviewOwner(prepared.accountId, identity.didKey)).rejects.toThrow("Independent-monitor");
        const payloadBytes = encodeManagedHandshake({ type: "hail.managed-transfer-grant", version: 1,
          did, nonce: randomUUID(), source_service_base: base, destination_service_base: "https://destination.example.com/hail",
          destination_domain: "destination.example.com", owner_recovery_key: owner.did(), source_identity_key: prepared.userIdentityKey,
          issued_at: now, expires_at: now + 600 });
        const transfer = { payloadBytes, signature: await owner.sign(managedHandshakeSignatureInput("hail.managed-transfer-grant", payloadBytes)) };
        await expect(new ManagedTransferAuthorization(db.sql, resolver, base, repository, encryptor).authorize(transfer))
          .rejects.toThrow("strict managed account authority");
        const connection = await db.sql.reserve();
        try { await expect(connection.unsafe(await Bun.file(new URL("../migrations/rollback/0057_alpha_monitoring.sql", import.meta.url)).text())).rejects.toThrow("prevent rollback"); }
        finally { await connection.unsafe("ROLLBACK"); connection.release(); }
      }
    }
    await expect(db.sql`DELETE FROM public_onboarding_evidence`).rejects.toThrow("immutable");
    await expect(db.sql`UPDATE managed_custody_evidence SET managed_profile_version='future-profile'`).rejects.toThrow();
    const connection = await db.sql.reserve();
    try { await expect(connection.unsafe(await Bun.file(new URL("../migrations/rollback/0044_public_onboarding.sql", import.meta.url)).text())).rejects.toThrow("prevent rollback"); }
    finally { await connection.unsafe("ROLLBACK"); connection.release(); }
  } finally {
    await db.close(); await admin.unsafe(`DROP SCHEMA "${schema}" CASCADE`); await admin.close();
  }
}, 30_000);
