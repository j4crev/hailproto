import { randomBytes, randomUUID } from "node:crypto";
import { cidForCbor } from "@atproto/common";
import { formatDidDoc, PlcClientError, type Operation } from "@did-plc/lib";
import { encodeBase64Url, inspectSignedPayload, type HailAddressBinding } from "@hailproto/codec";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createUserVault, unlockUserVault } from "../../hail-user-client-ts/src/vault.js";
import type { ProviderDatabase } from "../src/db/database.js";
import { KeyEncryptor } from "../src/identity/key-encryption.js";
import { ActivationService } from "../src/onboarding/activation.js";
import { PrivatePocOnboarding } from "../src/onboarding/private-poc.js";
import { OnboardingRepository } from "../src/onboarding/repository.js";
import type { PlcDirectoryClient } from "../src/plc/client.js";

const integration = process.env.DATABASE_URL ? describe : describe.skip;
const base = "https://source.example.com/hail";

integration("private POC user-key onboarding", () => {
  let db: ProviderDatabase;
  beforeAll(async () => {
    const { ProviderDatabase } = await import("../src/db/database.js");
    db = new ProviderDatabase(process.env.DATABASE_URL!);
    await db.migrate();
  });
  afterAll(async () => { if (db) await db.close(); });

  it("registers an exact user-top-signed private PLC DID without ever storing the user identity key", async () => {
    const generated = await createUserVault();
    const unlocked = await unlockUserVault(JSON.parse(JSON.stringify(generated.vault)), generated.recoverySecret);
    const address = `portable-${randomUUID()}@source.example.com`;
    let published: { did: string; operation: Operation } | undefined;
    let sends = 0;
    const plc: PlcDirectoryClient = {
      health: async () => ({ status: "ok" }),
      async getOperationLog(did) {
        if (did !== published?.did) throw new PlcClientError(404, null, "Absent DID");
        return [published.operation];
      },
      async getDocumentData(did) {
        if (did !== published?.did) throw new Error("Absent DID");
        return { did, rotationKeys: published.operation.rotationKeys,
          verificationMethods: published.operation.verificationMethods,
          alsoKnownAs: published.operation.alsoKnownAs, services: published.operation.services };
      },
      async getDocument(did) { return formatDidDoc(await this.getDocumentData(did)); },
      async getAuditableLog(did) {
        if (did !== published?.did) throw new Error("Absent DID");
        return [{ did, operation: published.operation,
          cid: (await cidForCbor(published.operation)).toString(),
          nullified: false, createdAt: new Date().toISOString() }];
      },
      async sendOperation(did, operation) {
        sends += 1;
        published = { did, operation };
        if (sends === 1) throw new Error("Private PLC persisted genesis but lost the response");
      },
    };
    const encryptor = new KeyEncryptor(encodeBase64Url(randomBytes(32)));
    const service = new PrivatePocOnboarding(db.sql, plc, encryptor,
      "http://plc.fixture:2582", base);
    await expect(service.prepare(address, generated.vault.recovery.publicDidKey,
      generated.vault.identity.publicDidKey, false)).rejects.toThrow("backup");
    const prepared = await service.prepare(address, generated.vault.recovery.publicDidKey,
      generated.vault.identity.publicDidKey, true);
    expect(await service.prepare(address, generated.vault.recovery.publicDidKey,
      generated.vault.identity.publicDidKey, true)).toEqual(prepared);
    expect(prepared.userIdentityKey).toBe(generated.vault.identity.publicDidKey);
    expect(prepared.userRecoveryKey).toBe(generated.vault.recovery.publicDidKey);
    expect(await db.sql`SELECT role FROM account_keys WHERE account_id = ${prepared.accountId}`)
      .toHaveLength(2);
    const signed = await unlocked.signPlcOperation({ type: "plc_operation", prev: null,
      rotationKeys: [prepared.userRecoveryKey, prepared.providerRotationKey],
      verificationMethods: { "hail-identity": prepared.userIdentityKey,
        "hail-messaging": prepared.providerMessagingKey },
      alsoKnownAs: [], services: { hail: { type: "HailMessaging", endpoint: base } },
    });
    await unlocked.bindDid(signed.did, signed.operation);
    const now = Math.floor(Date.now() / 1000);
    const binding: HailAddressBinding = { type: "hail.address-binding", version: 1,
      address, did: signed.did, issued_at: now, expires_at: now + 90 * 86400,
      key_id: `${signed.did}#hail-identity` };
    const cose = await unlocked.signAddressBinding(binding);
    const bytes = new TextEncoder().encode(JSON.stringify(signed.operation));
    await expect(service.register(prepared.accountId, bytes, Uint8Array.of(1)))
      .rejects.toThrow();
    const staged = await service.register(prepared.accountId, bytes, cose);
    expect(staged).toEqual({ did: signed.did, state: "address-staged" });
    expect(sends).toBe(1);
    expect(await service.register(prepared.accountId, bytes, cose)).toEqual(staged);
    const custody = await db.sql<{ monitor_verification_mode: string;
      user_identity_public_key: string }[]>`
      SELECT monitor_verification_mode, user_identity_public_key
      FROM portable_custody_evidence WHERE account_id = ${prepared.accountId}`;
    expect(custody[0]).toMatchObject({ monitor_verification_mode: "poc-local",
      user_identity_public_key: prepared.userIdentityKey });
    const roles = await db.sql<{ role: string }[]>`SELECT role FROM account_keys
      WHERE account_id = ${prepared.accountId}`;
    expect(roles.map((row) => row.role).sort()).toEqual(["hail-messaging", "plc-rotation"]);
    const repository = new OnboardingRepository(db.sql);
    const stagedBinding = await repository.getBindingForAccount(prepared.accountId);
    await new ActivationService(repository, { async verify() {
      return { address, did: signed.did, serviceBase: base,
        messagingDidKey: prepared.providerMessagingKey, identityDidKey: prepared.userIdentityKey,
        plcEvidence: { document: await plc.getDocument(signed.did),
          data: await plc.getDocumentData(signed.did), log: await plc.getOperationLog(signed.did) },
        verifiedAt: new Date(), binding: inspectSignedPayload("hail.address-binding", cose).payload,
        representation: cose, digest: stagedBinding.digest };
    } }, base, "public").activate(prepared.accountId);
    const account = await repository.getAccount(prepared.accountId);
    expect(account.state).toBe("active");
    expect(account.activationVerificationMode).toBe("public");
    generated.recoverySecret.fill(0);
  });
});
