import { generateKeyPairSync, sign, verify } from "node:crypto";
import { encode, rfc8949EncodeOptions, Tagged } from "cborg";
import { expect, it } from "vitest";
import { encodePayload, inspectSignedPayload, signPayload, verifySignedPayload } from "../src/index.js";
import { addressBinding } from "./fixtures.js";

for (const mutation of ["input", "getter"] as const) {
  it(`keeps verified representation immutable after Buffer ${mutation} mutation`, async () => {
    const keys = generateKeyPairSync("ed25519");
    const original = await signPayload("hail.address-binding", addressBinding, {
      keyId: addressBinding.key_id,
      async sign(bytes) { return sign(null, bytes, keys.privateKey); },
    });
    const input = Buffer.from(original);
    const verified = await verifySignedPayload("hail.address-binding", input, {
      async verify(bytes, signature) { return verify(null, bytes, keys.publicKey, signature); },
    });
    (mutation === "input" ? input : verified.representationBytes).fill(0);
    expect(Buffer.from(verified.representationBytes).equals(Buffer.from(original))).toBe(true);
  });
}

it("rejects a BOM-prefixed protected key ID rather than normalizing signed bytes", () => {
  const keys = generateKeyPairSync("ed25519");
  const encode_ = (value: unknown) => encode(value, rfc8949EncodeOptions);
  const kid = new Uint8Array([0xef, 0xbb, 0xbf, ...new TextEncoder().encode(addressBinding.key_id)]);
  const protectedBytes = encode_(new Map<number, unknown>([
    [1, -19], [3, "application/hail-address-binding+cbor"], [4, kid],
  ]));
  const payload = encodePayload("hail.address-binding", addressBinding);
  const signature = sign(null, encode_(["Signature1", protectedBytes, new Uint8Array(), payload]), keys.privateKey);
  const representation = encode_(new Tagged(18, [protectedBytes, new Map(), payload, new Uint8Array(signature)]));
  expect(() => inspectSignedPayload("hail.address-binding", representation)).toThrow();
});
