import { randomBytes, randomUUID } from "node:crypto";
import { SQL } from "bun";
import { encodeBase64Url } from "@hailproto/codec";
import { expect, it } from "vitest";
import { ProviderDatabase } from "../src/db/database.js";
import { KeyEncryptor } from "../src/identity/key-encryption.js";
import { OnboardingRepository } from "../src/onboarding/repository.js";
import { VerifiedPublicPlcResolver } from "../src/plc/public-resolver.js";
import { retainPublicSigningAuthority } from "../src/plc/signing-authority.js";
import { SenderProfileService } from "../src/profiles/service.js";
import { publicPlcFixture, publicPlcReaders } from "./public-plc-fixture.js";

it.skipIf(!process.env.DATABASE_URL)(
  "retains exact binding/profile/status authority and rolls back a stale profile commit",
  async () => {
    const admin = new SQL(process.env.DATABASE_URL!);
    const schema = `signing_authority_${randomUUID().replaceAll("-", "")}`;
    await admin.unsafe(`CREATE SCHEMA "${schema}"`);
    const url = new URL(process.env.DATABASE_URL!);
    url.searchParams.set("options", `-csearch_path=${schema}`);
    const db = new ProviderDatabase(url.toString());
    try {
      await db.migrate();
      const base = "https://local.example.com/hail";
      const fixture = await publicPlcFixture(base);
      const readers = publicPlcReaders([fixture]);
      const resolver = new VerifiedPublicPlcResolver(
        db.sql,
        readers,
        ["provider"],
        ["https://local.example.com"],
      );
      const accountId = randomUUID();
      await db.sql`
        INSERT INTO provider_accounts (
          id, tenant_id, canonical_address, did, onboarding_state,
          activated_at, activation_binding_digest, activation_verification_mode
        ) VALUES (
          ${accountId}, ${randomUUID()}, 'alice@local.example.com', ${fixture.did},
          'active', now(), ${new Uint8Array(32)}, 'public'
        )
      `;
      const encryptor = new KeyEncryptor(encodeBase64Url(randomBytes(32)));
      const privateKey = new Uint8Array(
        await crypto.subtle.exportKey("pkcs8", fixture.messaging.pair.privateKey),
      );
      const encrypted = await encryptor.encrypt(
        accountId,
        "hail-messaging",
        "ed25519",
        fixture.messaging.didKey,
        privateKey,
      );
      await db.sql`
        INSERT INTO account_keys (
          account_id, role, algorithm, public_key, encrypted_private_key,
          encryption_nonce, encryption_version, kek_id
        ) VALUES (
          ${accountId}, 'hail-messaging', 'ed25519', ${fixture.messaging.didKey},
          ${encrypted.ciphertext}, ${encrypted.nonce}, ${encrypted.encryptionVersion}, ${encrypted.kekId}
        )
      `;

      const repository = new OnboardingRepository(db.sql);
      const profiles = new SenderProfileService(repository, encryptor, resolver, base);
      const profile = await profiles.createOrReuse("alice@local.example.com", {
        display_name: "Alice",
        offers_uncategorized: false,
        categories: [],
      });
      expect(await db.sql`
        SELECT action_type FROM public_signing_authority_evidence
        WHERE action_type = 'sender-profile' AND representation_digest = ${profile.digest}
      `).toHaveLength(1);

      const staleResolver = new VerifiedPublicPlcResolver(
        db.sql,
        readers,
        ["provider"],
        ["https://local.example.com"],
        () => new Date(Date.now() - 60_000),
      );
      const staleProfiles = new SenderProfileService(repository, encryptor, staleResolver, base);
      await expect(staleProfiles.createOrReuse("alice@local.example.com", {
        display_name: "Changed",
        offers_uncategorized: false,
        categories: [],
      })).rejects.toThrow("stale");
      expect(await db.sql`SELECT revision FROM sender_profiles WHERE account_id = ${accountId}`).toHaveLength(1);

      const current = await resolver.resolve(fixture.did);
      for (const input of [
        { actionType: "address-binding" as const, role: "hail-identity" as const,
          key: fixture.identity.didKey, representation: new Uint8Array([1]) },
        { actionType: "delivery-status" as const, role: "hail-messaging" as const,
          key: fixture.messaging.didKey, representation: new Uint8Array([2]) },
      ]) {
        await db.sql.begin((tx) => retainPublicSigningAuthority(tx, {
          ...input,
          localAccountId: accountId,
          did: fixture.did,
          serviceBase: base,
          evidence: current.evidence,
        }));
      }
      await retainPublicSigningAuthority(db.sql, {
        actionType: "delivery-status",
        localAccountId: accountId,
        did: fixture.did,
        role: "hail-messaging",
        key: fixture.messaging.didKey,
        serviceBase: base,
        representation: new Uint8Array([2]),
        evidence: (await resolver.resolve(fixture.did)).evidence,
      });
      await expect(retainPublicSigningAuthority(db.sql, {
        actionType: "delivery-status",
        localAccountId: accountId,
        did: fixture.did,
        role: "hail-messaging",
        key: fixture.identity.didKey,
        serviceBase: base,
        representation: new Uint8Array([3]),
        evidence: current.evidence,
      })).rejects.toThrow("roles/service");
      const links = await db.sql<{ action_type: string }[]>`
        SELECT action_type FROM public_signing_authority_evidence ORDER BY action_type
      `;
      expect(links.map((row) => row.action_type)).toEqual([
        "address-binding",
        "delivery-status",
        "sender-profile",
      ]);
      await expect(db.sql`DELETE FROM public_signing_authority_evidence`).rejects.toThrow("immutable");
      const connection = await db.sql.reserve();
      try {
        await expect(connection.unsafe(
          await Bun.file(new URL("../migrations/rollback/0043_public_signing_authority.sql", import.meta.url)).text(),
        )).rejects.toThrow("prevent rollback");
      } finally {
        await connection.unsafe("ROLLBACK");
        connection.release();
      }
    } finally {
      await db.close();
      await admin.unsafe(`DROP SCHEMA "${schema}" CASCADE`);
      await admin.close();
    }
  },
  30_000,
);
