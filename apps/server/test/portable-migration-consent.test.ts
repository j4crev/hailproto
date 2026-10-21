import { randomBytes, randomUUID } from "node:crypto";
import { P256Keypair } from "@atproto/crypto";
import { base58btc } from "multiformats/bases/base58";
import { describe, expect, it } from "vitest";
import { signPortableMigrationConsent, verifyPortableMigrationConsent,
  type PortableMigrationConsent } from "../src/migration/consent.js";

async function didKey() {
  const pair = (await crypto.subtle.generateKey("Ed25519", true, ["sign", "verify"])) as CryptoKeyPair;
  const bytes = new Uint8Array(34);
  bytes.set([0xed, 0x01]);
  bytes.set(new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey)), 2);
  return { privateKey: pair.privateKey, didKey: `did:key:${base58btc.encode(bytes)}` };
}

describe("user-controlled portable migration consent", () => {
  it("signs exact snapshot and destination commitments without giving the provider a user private key", async () => {
    const [user, destination] = await Promise.all([didKey(), didKey()]);
    const recovery = await P256Keypair.create({ exportable: true });
    const targetRotation = await P256Keypair.create({ exportable: true });
    const now = Math.floor(Date.now() / 1000);
    const payload: PortableMigrationConsent = {
      type: "hail.portable-migration-consent", version: 1,
      did: `did:plc:${"a".repeat(24)}`, transfer_id: randomUUID(),
      snapshot_digest: Uint8Array.from(randomBytes(32)),
      plc_operation_sha256: Uint8Array.from(randomBytes(32)),
      source_service_base: "https://old.example.com/hail",
      destination_service_base: "https://new.example.com/hail",
      destination_address: "alice@user.example.com",
      destination_rotation_key: targetRotation.did(), destination_messaging_key: destination.didKey,
      user_recovery_key: recovery.did(), user_identity_key: user.didKey,
      created_at: now, expires_at: now + 3600,
    };
    const signed = await signPortableMigrationConsent(payload, user.privateKey);
    expect(await verifyPortableMigrationConsent(signed, user.didKey, now)).toEqual(payload);
    await expect(verifyPortableMigrationConsent(signed, user.didKey, now + 3601)).rejects.toThrow("stale");
    await expect(verifyPortableMigrationConsent(signed, destination.didKey, now)).rejects.toThrow("mismatched");
    const changed = { ...signed, signature: Uint8Array.from(signed.signature) };
    changed.signature[0] = changed.signature[0]! ^ 1;
    await expect(verifyPortableMigrationConsent(changed, user.didKey, now)).rejects.toThrow("signature is invalid");
  });
});
