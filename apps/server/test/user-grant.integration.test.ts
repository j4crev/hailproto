import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createWebCryptoSigner, encodeBase64Url, signPayload,
  inspectSignedPayload, type HailAddressBinding, type HailGrant, type HailSenderProfile } from "@hailproto/codec";
import { base58btc } from "multiformats/bases/base58";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ProviderDatabase } from "../src/db/database.js";
import { GrantRepository } from "../src/grants/repository.js";
import { GrantService } from "../src/grants/service.js";
import type { VerifiedAddress } from "../src/discovery/verifier.js";
import type { KeyEncryptor } from "../src/identity/key-encryption.js";
import { OnboardingRepository } from "../src/onboarding/repository.js";
import type { HailDidResolver } from "../src/plc/resolver.js";
import type { VerifiedSenderProfile } from "../src/profiles/store.js";
import { createUserVault, unlockUserVault } from "../../hail-user-client-ts/src/vault.js";

const integration = process.env.DATABASE_URL ? describe : describe.skip;
function didKey(key: CryptoKey): Promise<string> {
  return crypto.subtle.exportKey("raw", key).then((raw) => {
    const prefixed = new Uint8Array(34);
    prefixed.set([0xed, 0x01]);
    prefixed.set(new Uint8Array(raw), 2);
    return `did:key:${base58btc.encode(prefixed)}`;
  });
}

integration("user-held authoritative Grant", () => {
  let database: ProviderDatabase;
  async function clearDisposableGrants(): Promise<void> {
    await database.sql.begin(async (tx) => {
      const ids = await tx<{ grant_id: string; local_account_id: string }[]>`
        SELECT lineage.grant_id, lineage.local_account_id FROM grant_lineages lineage
        JOIN provider_accounts account ON account.id = lineage.local_account_id
        WHERE account.canonical_address LIKE 'grantor-%@source.example.com'`;
      for (const row of ids) {
        const receivers = await tx<{ grantee_account_id: string }[]>`
          SELECT grantee_account_id FROM collocated_grant_receivers WHERE grant_id = ${row.grant_id}`;
        await tx`DELETE FROM provider_migration_fences WHERE account_id = ${row.local_account_id}`;
        await tx`DELETE FROM collocated_grant_receivers WHERE grant_id = ${row.grant_id}`;
        await tx`DELETE FROM grant_publications WHERE grant_id = ${row.grant_id}`;
        await tx`DELETE FROM grant_consent_evidence WHERE grant_id = ${row.grant_id}`;
        await tx`DELETE FROM grant_revisions WHERE grant_id = ${row.grant_id}`;
        await tx`DELETE FROM grant_lineages WHERE grant_id = ${row.grant_id}`;
        await tx`DELETE FROM provider_accounts WHERE id = ${row.local_account_id}`;
        for (const receiver of receivers) {
          await tx`DELETE FROM provider_accounts WHERE id = ${receiver.grantee_account_id}`;
        }
      }
    });
  }
  beforeAll(async () => {
    database = new ProviderDatabase(process.env.DATABASE_URL!);
    await database.migrate();
    await clearDisposableGrants();
  });
  afterAll(async () => { if (database) {
    await clearDisposableGrants();
    await database.close();
  } });

  it("creates and revokes without provider identity custody, preserves collocated roles and recovers exact CLI retries", async () => {
    const alphabet = "abcdefghijklmnopqrstuvwxyz234567";
    const freshDid = () => `did:plc:${Array.from(randomBytes(24), (value) => alphabet[value % 32]).join("")}`;
    const grantorDid = freshDid();
    const senderDid = freshDid();
    const grantorAddress = `grantor-${randomUUID()}@source.example.com`;
    const senderAddress = `sender-${randomUUID()}@target.example.com`;
    const accountId = randomUUID();
    await database.sql`INSERT INTO provider_accounts (id, tenant_id, canonical_address,
      did, onboarding_state, activated_at, activation_binding_digest, activation_verification_mode)
      VALUES (${accountId}, ${randomUUID()}, ${grantorAddress}, ${grantorDid},
        'active', now(), ${randomBytes(32)}, 'public')`;
    const vault = await createUserVault();
    vault.vault.did = grantorDid;
    const user = await unlockUserVault(JSON.parse(JSON.stringify(vault.vault)), vault.recoverySecret);
    const sender = await crypto.subtle.generateKey("Ed25519", true, ["sign", "verify"]) as CryptoKeyPair;
    const senderIdentity = await crypto.subtle.generateKey("Ed25519", true, ["sign", "verify"]) as CryptoKeyPair;
    const userDidKey = vault.vault.identity.publicDidKey;
    const senderDidKey = await didKey(sender.publicKey);
    const senderIdentityDidKey = await didKey(senderIdentity.publicKey);
    const evidence = { document: {}, data: {}, log: [] };
    const resolver: HailDidResolver = { async resolve(value) {
      if (value !== grantorDid) throw new Error("Unexpected DID");
      return { did: grantorDid, identityDidKey: userDidKey, messagingDidKey: senderDidKey,
        serviceBase: "https://source.example.com/hail", evidence };
    } };
    const now = Math.floor(Date.now() / 1000);
    const addressBinding: HailAddressBinding = { type: "hail.address-binding", version: 1,
      address: senderAddress, did: senderDid, issued_at: now, expires_at: now + 3600,
      key_id: `${senderDid}#hail-identity` };
    const signedBinding = await signPayload("hail.address-binding", addressBinding,
      createWebCryptoSigner(addressBinding.key_id, senderIdentity.privateKey));
    const bindingDigest = new Uint8Array(createHash("sha256").update(signedBinding).digest());
    const address: VerifiedAddress = { address: senderAddress, did: senderDid,
      serviceBase: "https://target.example.com/hail", messagingDidKey: senderDidKey,
      identityDidKey: senderIdentityDidKey, plcEvidence: evidence, verifiedAt: new Date(),
      binding: addressBinding, representation: signedBinding, digest: bindingDigest };
    const profile: HailSenderProfile = { type: "hail.sender-profile", version: 1,
      did: senderDid, revision: 1, display_name: "Test sender", offers_uncategorized: false,
      categories: [{ id: "updates", label: "Updates" }], updated_at: now,
      key_id: `${senderDid}#hail-messaging` };
    const signedProfile = await signPayload("hail.sender-profile", profile,
      createWebCryptoSigner(profile.key_id, sender.privateKey));
    const verifiedProfile: VerifiedSenderProfile = {
      did: senderDid, serviceBase: address.serviceBase, messagingDidKey: senderDidKey,
      profile, representation: signedProfile,
      digest: new Uint8Array(createHash("sha256").update(signedProfile).digest()),
      plcEvidence: evidence, verifiedAt: new Date(), etag: encodeBase64Url(
        new Uint8Array(createHash("sha256").update(signedProfile).digest())),
    };
    const grants = new GrantRepository(database.sql);
    let senderAvailable = true;
    let clock = Date.now();
    const service = new GrantService(new OnboardingRepository(database.sql), grants,
      { async decrypt() { throw new Error("Provider must not decrypt the user's identity"); } } as unknown as KeyEncryptor,
      resolver, { async verify() {
        if (!senderAvailable) throw new Error("Sender address offline");
        return address;
      } }, { async verify() {
        if (!senderAvailable) throw new Error("Sender profile offline");
        return verifiedProfile;
      } }, "https://source.example.com/hail", () => new Date(clock));
    const proposed = await service.prepareUserSignedGrant(grantorAddress, senderAddress,
      { scope: { type: "categories", values: ["updates"] }, expiresAt: now + 86400 });
    const representation = await user.signGrant(proposed);
    const stored = await service.acceptUserSignedGrant(grantorAddress, senderAddress, representation);
    expect(stored.payload).toEqual(proposed);
    expect((await service.acceptUserSignedGrant(grantorAddress, senderAddress, representation)).digest)
      .toEqual(stored.digest);
    expect(await database.sql`SELECT role FROM account_keys WHERE account_id = ${accountId}`)
      .toHaveLength(0);
    expect(await database.sql`SELECT grant_id FROM grant_publications WHERE grant_id = ${proposed.grant_id}`)
      .toHaveLength(1);
    const corrupted = Uint8Array.from(representation);
    corrupted[corrupted.length - 1] = corrupted[corrupted.length - 1]! ^ 1;
    await expect(service.acceptUserSignedGrant(grantorAddress, senderAddress, corrupted)).rejects.toThrow();

    const senderAccountId = randomUUID();
    await database.sql`INSERT INTO provider_accounts (id, tenant_id, canonical_address, did,
      onboarding_state, activated_at, activation_binding_digest, activation_verification_mode)
      VALUES (${senderAccountId}, ${randomUUID()}, ${senderAddress}, ${senderDid},
        'active', now(), ${randomBytes(32)}, 'public')`;
    await database.sql`INSERT INTO collocated_grant_receivers (grant_id, grantee_account_id)
      VALUES (${proposed.grant_id}, ${senderAccountId})`;

    const ceremony = await mkdtemp(join(tmpdir(), "hail-user-revoke-"));
    const vaultPath = join(ceremony, "vault.json");
    const currentPath = join(ceremony, "current.cose");
    const revokedPath = join(ceremony, "revoked.cose");
    try {
      await writeFile(vaultPath, JSON.stringify(vault.vault), { mode: 0o600 });
      await writeFile(currentPath, representation, { mode: 0o600 });
      const runClient = async (grantId = proposed.grant_id) => {
        const child = Bun.spawn(["bun", "src/cli/revoke-private-poc-grant.ts",
          vaultPath, currentPath, grantId, senderAddress, revokedPath], {
          cwd: new URL("../../hail-user-client-ts/", import.meta.url).pathname,
          stdin: "pipe", stdout: "pipe", stderr: "pipe",
        });
        child.stdin.write(`${encodeBase64Url(vault.recoverySecret)}\n`);
        child.stdin.end();
        const exit = await child.exited;
        return { exit, stderr: await new Response(child.stderr).text() };
      };
      expect((await runClient(randomUUID())).exit).not.toBe(0);
      expect(await runClient()).toMatchObject({ exit: 0 });
      const revokedBytes = new Uint8Array(await readFile(revokedPath));
      expect(await runClient()).toMatchObject({ exit: 0 });
      expect(new Uint8Array(await readFile(revokedPath))).toEqual(revokedBytes);
      await writeFile(currentPath, corrupted);
      expect((await runClient()).exit).not.toBe(0);
      expect(new Uint8Array(await readFile(revokedPath))).toEqual(revokedBytes);
      await writeFile(currentPath, representation);
      const terminal = inspectSignedPayload("hail.grant", revokedBytes).payload;
      expect(terminal).toMatchObject({ status: "revoked", revision: 2,
        previous: stored.digest, scope: proposed.scope, consent_context: proposed.consent_context });

      // Revocation must work even after expiry and without sender discovery.
      senderAvailable = false;
      clock += 2 * 86400 * 1000;
      expect(proposed.expires_at!).toBeLessThan(Math.floor(clock / 1000));
      const invalid: HailGrant[] = [
        { ...terminal, previous: randomBytes(32) },
        { ...terminal, scope: [{ type: "categories" as const, values: ["different"] }] },
        { ...terminal, grantee: freshDid() },
        { ...terminal, consent_context: { ...terminal.consent_context,
          sender_profile_hash: { algorithm: "sha-256", value: randomBytes(32) } } },
        { ...terminal, expires_at: null },
        { ...terminal, updated_at: Math.floor(clock / 1000) + 301 },
      ];
      for (const changed of invalid) {
        await expect(service.acceptUserSignedGrant(grantorAddress, senderAddress,
          await user.signGrant(changed))).rejects.toThrow();
      }
      const badSignature = Uint8Array.from(revokedBytes);
      badSignature[badSignature.length - 1] = badSignature[badSignature.length - 1]! ^ 1;
      await expect(service.acceptUserSignedGrant(grantorAddress, senderAddress, badSignature)).rejects.toThrow();

      await database.sql`INSERT INTO provider_migration_fences
        (did, account_id, transfer_id, destination_service_base, state)
        VALUES (${grantorDid}, ${accountId}, ${randomUUID()}, 'https://target.example.com/hail', 'fenced')`;
      await expect(service.acceptUserSignedGrant(grantorAddress, senderAddress, revokedBytes))
        .rejects.toThrow("migration-fenced");
      expect((await grants.findCurrentByGrantId(proposed.grant_id))?.payload.status).toBe("active");
      await database.sql`DELETE FROM provider_migration_fences WHERE account_id = ${accountId}`;

      const racing = await Promise.all([
        service.acceptUserSignedGrant(grantorAddress, senderAddress, revokedBytes),
        service.acceptUserSignedGrant(grantorAddress, senderAddress, revokedBytes),
      ]);
      expect(racing.every(row => Buffer.from(row.representation).equals(Buffer.from(revokedBytes)))).toBe(true);
      expect((await service.acceptUserSignedGrant(grantorAddress, senderAddress, revokedBytes)).representation)
        .toEqual(revokedBytes);
      expect((await grants.findCurrentByGrantId(proposed.grant_id))?.localRole).toBe("grantor");
      const received = await grants.findReceivedForSender(proposed.grant_id, senderDid);
      expect(received?.payload.status).toBe("revoked");
      expect(received?.localRole).toBe("grantee");
      expect((await grants.acceptReceivedRevision({ localAccountId: senderAccountId,
        payload: terminal, representation: revokedBytes, digest: racing[0]!.digest,
        signingPublicKey: userDidKey, signingPlcEvidence: evidence })).localRole).toBe("grantee");
      expect(await grants.findActiveAuthoritativeByDidPair(grantorDid, senderDid)).toBeNull();
      expect(await database.sql`SELECT revision FROM grant_revisions WHERE grant_id = ${proposed.grant_id}`)
        .toHaveLength(2);
      const publications = await database.sql<{ revision: number; state: string }[]>`
        SELECT revision,state FROM grant_publications WHERE grant_id = ${proposed.grant_id} ORDER BY revision`;
      expect([...publications]).toEqual([{ revision: 1, state: "pending" }, { revision: 2, state: "pending" }]);
      await expect(service.acceptUserSignedGrant(grantorAddress, senderAddress, representation)).rejects.toThrow();
      expect(await database.sql`SELECT role FROM account_keys WHERE account_id = ${accountId}`).toHaveLength(0);
    } finally {
      vault.recoverySecret.fill(0);
      await rm(ceremony, { recursive: true, force: true });
    }
  });
});
