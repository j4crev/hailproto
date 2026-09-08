import {
  generateKeyPairSync,
  sign as nodeSign,
  verify as nodeVerify,
  type KeyObject,
} from "node:crypto";

import { describe, expect, it } from "vitest";
import { decode, encode, rfc8949EncodeOptions, Tagged } from "cborg";

import {
  HailCodecError,
  createWebCryptoSigner,
  createWebCryptoVerifier,
  inspectSignedPayload,
  signPayload,
  verifySignedPayload,
  type HailSigner,
  type HailVerifier,
  type VerifiedHailObject,
} from "../src/index.js";
import { addressBinding, identityDid } from "./fixtures.js";

function signer(privateKey: KeyObject, keyId: string): HailSigner {
  return {
    keyId,
    async sign(data) {
      return nodeSign(null, data, privateKey);
    },
  };
}

function verifier(publicKey: KeyObject): HailVerifier {
  return {
    async verify(data, signature) {
      return nodeVerify(null, data, publicKey, signature);
    },
  };
}

describe("Hail COSE_Sign1", () => {
  it("signs, inspects, and verifies an address binding", async () => {
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const representation = await signPayload(
      "hail.address-binding",
      addressBinding,
      signer(privateKey, `${identityDid}#hail-identity`),
    );

    expect(representation[0]).toBe(0xd2);
    const inspected = inspectSignedPayload("hail.address-binding", representation);
    expect(inspected.payload).toEqual(addressBinding);
    // Inspection deliberately cannot satisfy an API that requires authenticated data.
    // @ts-expect-error inspected payloads are not nominally verified
    const authenticated: VerifiedHailObject = inspected;
    expect(authenticated.payload).toEqual(addressBinding);
    const verified = await verifySignedPayload(
      "hail.address-binding",
      representation,
      verifier(publicKey),
    );
    expect(verified.keyId).toBe(`${identityDid}#hail-identity`);

    representation.fill(0);
    verified.payloadBytes.fill(0);
    verified.payload.address = "mallory@example.com";
    expect(verified.representationBytes[0]).toBe(0xd2);
    expect(verified.payload.address).toBe("alice@example.com");
    expect(verified.payloadBytes.some((byte) => byte !== 0)).toBe(true);
  });

  it("rejects the wrong key role before signing", async () => {
    const { privateKey } = generateKeyPairSync("ed25519");
    await expect(
      signPayload(
        "hail.address-binding",
        addressBinding,
        signer(privateKey, `${identityDid}#hail-messaging`),
      ),
    ).rejects.toMatchObject({ code: "wrong-key-role" });
  });

  it("rejects a signature from a different key", async () => {
    const first = generateKeyPairSync("ed25519");
    const second = generateKeyPairSync("ed25519");
    const representation = await signPayload(
      "hail.address-binding",
      addressBinding,
      signer(first.privateKey, `${identityDid}#hail-identity`),
    );
    await expect(
      verifySignedPayload(
        "hail.address-binding",
        representation,
        verifier(second.publicKey),
      ),
    ).rejects.toBeInstanceOf(HailCodecError);
  });

  it("rejects an object under the wrong expected profile", async () => {
    const { privateKey } = generateKeyPairSync("ed25519");
    const representation = await signPayload(
      "hail.address-binding",
      addressBinding,
      signer(privateKey, `${identityDid}#hail-identity`),
    );
    expect(() => inspectSignedPayload("hail.envelope", representation)).toThrowError(
      HailCodecError,
    );
  });

  it("rejects deprecated polymorphic EdDSA (-8)", async () => {
    const { privateKey } = generateKeyPairSync("ed25519");
    const representation = await signPayload(
      "hail.address-binding",
      addressBinding,
      signer(privateKey, `${identityDid}#hail-identity`),
    );
    const tagged = decode(representation, {
      tags: Tagged.preserve(18),
      useMaps: true,
    }) as Tagged;
    const elements = tagged.value as unknown[];
    const protectedHeader = decode(elements[0] as Uint8Array, {
      useMaps: true,
    }) as Map<number, unknown>;
    protectedHeader.set(1, -8);
    elements[0] = encode(protectedHeader, rfc8949EncodeOptions);
    const deprecated = encode(tagged, rfc8949EncodeOptions);

    expect(() => inspectSignedPayload("hail.address-binding", deprecated)).toThrowError(
      /Ed25519 \(-19\)/,
    );
  });

  it("rejects excessive nesting in the outer COSE structure before decoding", () => {
    const deeplyNested = new Uint8Array([...new Uint8Array(33).fill(0x81), 0x00]);
    expect(() =>
      inspectSignedPayload("hail.address-binding", deeplyNested),
    ).toThrow(/nesting depth/);
  });

  it("rejects excessive nesting in protected headers before decoding", () => {
    const protectedHeader = new Uint8Array([
      ...new Uint8Array(9).fill(0x81),
      0x00,
    ]);
    const representation = encode(
      new Tagged(18, [
        protectedHeader,
        new Map(),
        new Uint8Array(),
        new Uint8Array(64),
      ]),
      rfc8949EncodeOptions,
    );
    try {
      inspectSignedPayload("hail.address-binding", representation);
      throw new Error("expected protected header rejection");
    } catch (error) {
      expect(error).toMatchObject({ code: "resource-limit" });
    }
  });

  it("supports the portable Web Crypto adapters", async () => {
    const keys = (await crypto.subtle.generateKey("Ed25519", false, [
      "sign",
      "verify",
    ])) as CryptoKeyPair;
    const keyId = `${identityDid}#hail-identity`;
    const representation = await signPayload(
      "hail.address-binding",
      addressBinding,
      createWebCryptoSigner(keyId, keys.privateKey),
    );
    const verified = await verifySignedPayload(
      "hail.address-binding",
      representation,
      createWebCryptoVerifier(async () => keys.publicKey),
    );
    expect(verified.payload.address).toBe("alice@example.com");
  });
});
