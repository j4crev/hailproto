import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
  createWebCryptoSigner,
  signPayload,
  type HailAddressBinding,
  type HailGrant,
  type HailSenderProfile,
} from "@hailproto/codec";
import { base58btc } from "multiformats/bases/base58";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ProviderDatabase } from "../src/db/database.js";
import { GrantRepository } from "../src/grants/repository.js";
import type { SignedGrantRevisionInput } from "../src/grants/store.js";
import { uuidV7 } from "../src/identity/uuid-v7.js";

const databaseUrl = process.env.DATABASE_URL;
const integration = databaseUrl ? describe : describe.skip;
const plcAlphabet = "abcdefghijklmnopqrstuvwxyz234567";
const evidence = { document: { id: "integration" }, data: { source: "test" }, log: [{}] };

function digest(value: Uint8Array): Uint8Array {
  return new Uint8Array(createHash("sha256").update(value).digest());
}

function uniqueDid(): string {
  const bytes = randomBytes(24);
  return `did:plc:${Array.from(bytes, (byte) => plcAlphabet[byte % plcAlphabet.length]).join("")}`;
}

async function signingKey() {
  const pair = (await crypto.subtle.generateKey("Ed25519", true, ["sign", "verify"])) as CryptoKeyPair;
  const raw = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey));
  const multicodecKey = new Uint8Array(34);
  multicodecKey.set([0xed, 0x01]);
  multicodecKey.set(raw, 2);
  return { privateKey: pair.privateKey, didKey: `did:key:${base58btc.encode(multicodecKey)}` };
}

integration("GrantRepository PostgreSQL integration", () => {
  const accountIds = [randomUUID(), randomUUID()];
  const tenantIds = [randomUUID(), randomUUID()];
  const grantIds: string[] = [];
  const grantorDid = uniqueDid();
  const granteeDid = uniqueDid();
  const granteeAddress = `grantee-${randomUUID()}@example.com`;
  const serviceBase = `https://${randomUUID()}.example.com/hail`;
  const now = Math.floor(Date.now() / 1_000);
  let database: ProviderDatabase;
  let repository: GrantRepository;

  beforeAll(async () => {
    const { ProviderDatabase } = await import("../src/db/database.js");
    database = new ProviderDatabase(databaseUrl!);
    await database.migrate();
    repository = new GrantRepository(database.sql);
    for (let index = 0; index < accountIds.length; index += 1) {
      await database.sql`
        INSERT INTO provider_accounts (
          id, tenant_id, canonical_address, did, onboarding_state, activated_at,
          activation_binding_digest, activation_verification_mode
        ) VALUES (
          ${accountIds[index]!}, ${tenantIds[index]!},
          ${`integration-${accountIds[index]}@example.com`},
          ${index === 0 ? grantorDid : granteeDid}, 'active', now(),
          ${new Uint8Array(32).fill(index + 1)}, 'public'
        )
      `;
    }
  });

  afterAll(async () => {
    if (!database) return;
    if (grantIds.length > 0) {
      await database.sql`DELETE FROM grant_publications WHERE grant_id IN ${database.sql(grantIds)}`;
      await database.sql`DELETE FROM grant_consent_evidence WHERE grant_id IN ${database.sql(grantIds)}`;
      await database.sql`DELETE FROM grant_revisions WHERE grant_id IN ${database.sql(grantIds)}`;
      await database.sql`DELETE FROM grant_lineages WHERE grant_id IN ${database.sql(grantIds)}`;
    }
    await database.sql`DELETE FROM provider_accounts WHERE id IN ${database.sql(accountIds)}`;
    await database.close();
  });

  it("persists authoritative and received grant lifecycles with ordered publication", async () => {
    const [grantorKey, granteeIdentityKey, granteeMessagingKey] = await Promise.all([
      signingKey(),
      signingKey(),
      signingKey(),
    ]);
    const binding: HailAddressBinding = {
      type: "hail.address-binding",
      version: 1,
      address: granteeAddress,
      did: granteeDid,
      issued_at: now,
      expires_at: now + 86_400,
      key_id: `${granteeDid}#hail-identity`,
    };
    const bindingBytes = await signPayload(
      "hail.address-binding",
      binding,
      createWebCryptoSigner(binding.key_id, granteeIdentityKey.privateKey),
    );
    const profile: HailSenderProfile = {
      type: "hail.sender-profile",
      version: 1,
      did: granteeDid,
      revision: 1,
      display_name: "Integration Grantee",
      offers_uncategorized: false,
      categories: [{ id: "receipts", label: "Receipts" }],
      updated_at: now,
      key_id: `${granteeDid}#hail-messaging`,
    };
    const profileBytes = await signPayload(
      "hail.sender-profile",
      profile,
      createWebCryptoSigner(profile.key_id, granteeMessagingKey.privateKey),
    );
    const bindingDigest = digest(bindingBytes);
    const profileDigest = digest(profileBytes);
    const consent = {
      address: {
        address: granteeAddress,
        did: granteeDid,
        serviceBase,
        messagingDidKey: granteeMessagingKey.didKey,
        identityDidKey: granteeIdentityKey.didKey,
        plcEvidence: evidence,
        verifiedAt: new Date(),
        binding,
        representation: bindingBytes,
        digest: bindingDigest,
      },
      senderProfile: {
        did: granteeDid,
        serviceBase,
        messagingDidKey: granteeMessagingKey.didKey,
        profile,
        representation: profileBytes,
        digest: profileDigest,
        etag: "integration-profile",
        plcEvidence: evidence,
        verifiedAt: new Date(),
      },
    };

    async function signedGrant(
      grantId: string,
      localAccountId: string,
      localRole: "grantor" | "grantee",
      overrides: Partial<HailGrant> = {},
    ): Promise<SignedGrantRevisionInput> {
      const payload: HailGrant = {
        type: "hail.grant",
        version: 1,
        grant_id: grantId,
        revision: 1,
        previous: null,
        grantor: grantorDid,
        grantee: granteeDid,
        scope: [{ type: "categories", values: ["receipts"] }],
        status: "active",
        issued_at: now,
        updated_at: now,
        expires_at: null,
        consent_context: {
          grantee_address: granteeAddress,
          address_binding_hash: { algorithm: "sha-256", value: bindingDigest },
          sender_profile_hash: { algorithm: "sha-256", value: profileDigest },
        },
        key_id: `${grantorDid}#hail-identity`,
        ...overrides,
      };
      const representation = await signPayload(
        "hail.grant",
        payload,
        createWebCryptoSigner(payload.key_id, grantorKey.privateKey),
      );
      return {
        localAccountId,
        localRole,
        payload,
        representation,
        digest: digest(representation),
        signingPublicKey: grantorKey.didKey,
        signingPlcEvidence: evidence,
      };
    }

    const authoritativeId = uuidV7();
    grantIds.push(authoritativeId);
    const authoritative1 = await signedGrant(authoritativeId, accountIds[0]!, "grantor");
    await repository.insertAuthoritativeRevision1({
      revision: authoritative1,
      consent,
      destinationServiceBase: serviceBase,
    });
    const stored1 = await repository.findCurrentByGrantId(authoritativeId);
    expect(stored1).toMatchObject({ localRole: "grantor", payload: authoritative1.payload });
    expect(stored1?.representation).toEqual(authoritative1.representation);
    const persisted = await database.sql<{ evidence_count: number; publication_count: number }[]>`
      SELECT
        (SELECT count(*)::int FROM grant_consent_evidence WHERE grant_id = ${authoritativeId}) AS evidence_count,
        (SELECT count(*)::int FROM grant_publications WHERE grant_id = ${authoritativeId}) AS publication_count
    `;
    expect(persisted[0]).toEqual({ evidence_count: 1, publication_count: 1 });

    const duplicateId = uuidV7(Date.now() + 1);
    grantIds.push(duplicateId);
    const duplicate = await signedGrant(duplicateId, accountIds[0]!, "grantor");
    await expect(
      repository.insertAuthoritativeRevision1({
        revision: duplicate,
        consent,
        destinationServiceBase: serviceBase,
      }),
    ).rejects.toThrow();
    const duplicateRows = await database.sql<{ count: number }[]>`
      SELECT (
        (SELECT count(*) FROM grant_lineages WHERE grant_id = ${duplicateId}) +
        (SELECT count(*) FROM grant_revisions WHERE grant_id = ${duplicateId}) +
        (SELECT count(*) FROM grant_consent_evidence WHERE grant_id = ${duplicateId}) +
        (SELECT count(*) FROM grant_publications WHERE grant_id = ${duplicateId})
      )::int AS count
    `;
    expect(duplicateRows[0]?.count).toBe(0);

    const authoritative2 = await signedGrant(authoritativeId, accountIds[0]!, "grantor", {
      revision: 2,
      previous: authoritative1.digest,
      status: "revoked",
      updated_at: now + 1,
    });
    await repository.appendAuthoritativeRevocation({
      revision: authoritative2,
      expectedCurrentRevision: 1,
      expectedCurrentDigest: authoritative1.digest,
    });
    expect((await repository.findCurrentByGrantId(authoritativeId))?.payload.status).toBe("revoked");

    const claim1 = await repository.claimDuePublication(30_000, new Date(Date.now() + 1_000));
    expect(claim1?.grant.payload).toMatchObject({ grant_id: authoritativeId, revision: 1 });
    await expect(
      repository.claimDuePublication(30_000, new Date(Date.now() + 1_000)),
    ).resolves.toBeNull();
    await repository.acknowledgePublication({
      grantId: authoritativeId,
      revision: 1,
      leaseToken: claim1!.leaseToken,
      httpStatus: 201,
      etag: '"revision-1"',
    });
    const claim2 = await repository.claimDuePublication(30_000, new Date(Date.now() + 1_000));
    expect(claim2?.grant.payload).toMatchObject({ grant_id: authoritativeId, revision: 2 });
    await repository.acknowledgePublication({
      grantId: authoritativeId,
      revision: 2,
      leaseToken: claim2!.leaseToken,
      httpStatus: 204,
      etag: '"revision-2"',
    });

    const receivedId = uuidV7(Date.now() + 2);
    grantIds.push(receivedId);
    const received1 = await signedGrant(receivedId, accountIds[1]!, "grantee");
    const accepted1 = await repository.acceptReceivedRevision(received1);
    const retried1 = await repository.acceptReceivedRevision(received1);
    expect(accepted1.representation).toEqual(received1.representation);
    expect(retried1.representation).toEqual(received1.representation);

    const conflicting1 = await signedGrant(receivedId, accountIds[1]!, "grantee", {
      scope: [{ type: "categories", values: ["security-alerts"] }],
    });
    await expect(repository.acceptReceivedRevision(conflicting1)).rejects.toThrow(
      "conflicts with previously received exact bytes",
    );

    const received2 = await signedGrant(receivedId, accountIds[1]!, "grantee", {
      revision: 2,
      previous: received1.digest,
      status: "revoked",
      updated_at: now + 1,
    });
    const accepted2 = await repository.acceptReceivedRevision(received2);
    const retried2 = await repository.acceptReceivedRevision(received2);
    expect(accepted2.payload.status).toBe("revoked");
    expect(retried2.representation).toEqual(received2.representation);

    const postRevocation = await signedGrant(receivedId, accountIds[1]!, "grantee", {
      revision: 3,
      previous: received2.digest,
      status: "revoked",
      updated_at: now + 2,
    });
    await expect(repository.acceptReceivedRevision(postRevocation)).rejects.toThrow(
      "does not advance the current lineage",
    );
  }, 30_000);
});
