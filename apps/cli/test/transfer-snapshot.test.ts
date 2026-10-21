import { createHash } from "node:crypto";
import { encodeBase64Url } from "@hailproto/codec";
import { base58btc } from "multiformats/bases/base58";
import { expect, it } from "vitest";
import { verifyTransferSnapshot } from "../src/transfer-cutover.js";

it("verifies retained v2 and new v3 snapshots under distinct signature domains", async () => {
  const keys = await crypto.subtle.generateKey("Ed25519", true, ["sign", "verify"]);
  const raw = new Uint8Array(34);
  raw.set([0xed, 0x01]);
  raw.set(new Uint8Array(await crypto.subtle.exportKey("raw", keys.publicKey)), 2);
  const sourceMessagingPublicKey = `did:key:${base58btc.encode(raw)}`;
  const snapshot = async (version: 2 | 3) => {
    const manifest = new TextEncoder().encode(JSON.stringify({ version }));
    const digest = new Uint8Array(createHash("sha256").update(manifest).digest());
    const prefix = new TextEncoder().encode(`hail-migration-snapshot-v${version}\0`);
    const input = new Uint8Array(prefix.length + digest.length);
    input.set(prefix);
    input.set(digest, prefix.length);
    const signature = new Uint8Array(await crypto.subtle.sign("Ed25519", keys.privateKey, input));
    return { type: "hail.portable-migration-transfer", version,
      manifest: encodeBase64Url(manifest), digest: encodeBase64Url(digest),
      signature: encodeBase64Url(signature), sourceMessagingPublicKey };
  };
  expect((await verifyTransferSnapshot(await snapshot(2))).manifest.version).toBe(2);
  expect((await verifyTransferSnapshot(await snapshot(3))).manifest.version).toBe(3);
  const mismatched = await snapshot(2);
  mismatched.version = 3;
  await expect(verifyTransferSnapshot(mismatched)).rejects.toThrow("versions differ");
});
