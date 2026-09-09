import {
  createHash,
  createPrivateKey,
  createPublicKey,
  sign as nodeSign,
  verify as nodeVerify,
  type KeyObject,
} from "node:crypto";
import { readFileSync } from "node:fs";

import { decode as decodeCbor, Tagged } from "cborg";
import { describe, expect, it } from "vitest";

import {
  decodeBase64Url,
  decodeDeterministic,
  decodePayload,
  DEFAULT_HAIL_RESOURCE_LIMITS,
  encodeBase64Url,
  encodePayload,
  fromDiagnosticJson,
  HailCodecError,
  inspectSignedPayload,
  signPayload,
  verifySignedPayload,
  type DiagnosticJson,
  type HailPayloadType,
  type HailSignedPayloadType,
} from "../src/index.js";

interface TestKeyVector {
  readonly key_id: string;
  readonly seed_hex: string;
  readonly public_key_hex: string;
}

interface PositiveVector {
  readonly id: string;
  readonly type: HailPayloadType;
  readonly diagnostic: DiagnosticJson;
  readonly payload_hex: string;
  readonly payload_sha256_hex: string;
  readonly payload_sha256_base64url: string;
  readonly cose_sign1_hex?: string;
  readonly sig_structure_hex?: string;
  readonly representation_sha256_hex?: string;
  readonly representation_sha256_base64url?: string;
}

interface NegativeVector {
  readonly id: string;
  readonly hex: string;
  readonly expected_error: string;
  readonly limits?: { readonly maximum_byte_string_length: number };
}

interface DigestDomainVector {
  readonly id: string;
  readonly source_vector: string;
  readonly source_field: "payload_hex" | "cose_sign1_hex";
  readonly target_vector: string;
  readonly target_path: string;
  readonly sha256_hex: string;
  readonly sha256_base64url: string;
}

interface NegativePayloadVector {
  readonly id: string;
  readonly type: HailPayloadType;
  readonly hex: string;
  readonly expected_error: string;
}

interface NegativeCoseVector {
  readonly id: string;
  readonly type: HailSignedPayloadType;
  readonly hex: string;
  readonly error: string;
  readonly operation: "inspect" | "verify";
}

interface VectorManifest {
  readonly format: string;
  readonly test_keys: readonly TestKeyVector[];
  readonly positive: readonly PositiveVector[];
  readonly digest_domains: readonly DigestDomainVector[];
  readonly text_boundaries: {
    readonly digest_hex: string;
    readonly digest_base64url: string;
    readonly digest_url_segment: string;
    readonly strong_etag: string;
    readonly bearer_token_hex: string;
    readonly bearer_token_base64url: string;
    readonly authorization_header: string;
    readonly body_content_digest_hex: string;
    readonly content_digest_header: string;
  };
  readonly negative_cbor: readonly NegativeVector[];
  readonly negative_payload: readonly NegativePayloadVector[];
  readonly negative_cose: readonly NegativeCoseVector[];
}

const manifest = JSON.parse(
  readFileSync(new URL("../vectors/v0.json", import.meta.url), "utf8"),
) as VectorManifest;
const PKCS8_PREFIX = "302e020100300506032b657004220420";
const SPKI_PREFIX = "302a300506032b6570032100";

function bytes(value: string): Uint8Array {
  return new Uint8Array(Buffer.from(value, "hex"));
}

function digest(value: Uint8Array): Uint8Array {
  return new Uint8Array(createHash("sha256").update(value).digest());
}

function privateKey(vector: TestKeyVector): KeyObject {
  return createPrivateKey({
    format: "der",
    key: Buffer.from(`${PKCS8_PREFIX}${vector.seed_hex}`, "hex"),
    type: "pkcs8",
  });
}

function publicKey(vector: TestKeyVector): KeyObject {
  return createPublicKey({
    format: "der",
    key: Buffer.from(`${SPKI_PREFIX}${vector.public_key_hex}`, "hex"),
    type: "spki",
  });
}

function errorCode(action: () => unknown): string | undefined {
  try {
    action();
  } catch (error) {
    if (error instanceof HailCodecError) return error.code;
    throw error;
  }
  return undefined;
}

function valueAtPath(value: DiagnosticJson, path: string): DiagnosticJson {
  let current: DiagnosticJson = value;
  for (const segment of path.split(".")) {
    if (current === null || Array.isArray(current) || typeof current !== "object") {
      throw new Error(`invalid target path ${path}`);
    }
    const next: DiagnosticJson | undefined = current[segment];
    if (next === undefined) throw new Error(`missing target path ${path}`);
    current = next;
  }
  return current;
}

describe("v0 conformance vectors", () => {
  it("uses the recognized manifest format", () => {
    expect(manifest.format).toBe("hail-conformance-vectors-1");
    expect(manifest.positive).toHaveLength(7);
  });

  for (const vector of manifest.positive) {
    it(`matches positive vector: ${vector.id}`, async () => {
      const payload = fromDiagnosticJson(vector.type, vector.diagnostic);
      const payloadBytes = encodePayload(vector.type, payload as never);
      expect(Buffer.from(payloadBytes).toString("hex")).toBe(vector.payload_hex);

      const payloadDigest = digest(payloadBytes);
      expect(Buffer.from(payloadDigest).toString("hex")).toBe(
        vector.payload_sha256_hex,
      );
      expect(encodeBase64Url(payloadDigest)).toBe(
        vector.payload_sha256_base64url,
      );

      if (vector.type === "hail.body.spt-1") {
        expect(vector.cose_sign1_hex).toBeUndefined();
        return;
      }

      expect(vector.cose_sign1_hex).toBeDefined();
      expect(vector.sig_structure_hex).toBeDefined();
      const representation = bytes(vector.cose_sign1_hex as string);
      const inspected = inspectSignedPayload(vector.type, representation);
      const keyVector = manifest.test_keys.find(
        (entry) => entry.key_id === inspected.keyId,
      );
      expect(keyVector).toBeDefined();
      if (keyVector === undefined) return;

      const generated = await signPayload(vector.type, payload as never, {
        keyId: keyVector.key_id,
        async sign(data) {
          return nodeSign(null, data, privateKey(keyVector));
        },
      });
      expect(Buffer.from(generated).toString("hex")).toBe(
        vector.cose_sign1_hex,
      );

      const tagged = decodeCbor(representation, {
        tags: Tagged.preserve(18),
        useMaps: true,
      }) as Tagged;
      const signature = (tagged.value as unknown[])[3] as Uint8Array;
      expect(
        nodeVerify(
          null,
          bytes(vector.sig_structure_hex as string),
          publicKey(keyVector),
          signature,
        ),
      ).toBe(true);

      const verified = await verifySignedPayload(
        vector.type,
        representation,
        {
          async verify(data, signature) {
            return nodeVerify(null, data, publicKey(keyVector), signature);
          },
        },
      );
      expect(Buffer.from(verified.payloadBytes).toString("hex")).toBe(
        vector.payload_hex,
      );

      const representationDigest = digest(representation);
      expect(Buffer.from(representationDigest).toString("hex")).toBe(
        vector.representation_sha256_hex,
      );
      expect(encodeBase64Url(representationDigest)).toBe(
        vector.representation_sha256_base64url,
      );
    });
  }

  for (const vector of manifest.digest_domains) {
    it(`matches digest domain: ${vector.id}`, () => {
      const source = manifest.positive.find(
        (entry) => entry.id === vector.source_vector,
      );
      const target = manifest.positive.find(
        (entry) => entry.id === vector.target_vector,
      );
      if (source === undefined || target === undefined) {
        throw new Error(`missing digest-domain vector ${vector.id}`);
      }
      const sourceHex = source[vector.source_field];
      if (sourceHex === undefined) {
        throw new Error(`missing source bytes for ${vector.id}`);
      }
      const value = digest(bytes(sourceHex));
      expect(Buffer.from(value).toString("hex")).toBe(vector.sha256_hex);
      expect(encodeBase64Url(value)).toBe(vector.sha256_base64url);
      expect(valueAtPath(target.diagnostic, vector.target_path)).toBe(
        vector.sha256_base64url,
      );
    });
  }

  for (const vector of manifest.negative_cbor) {
    it(`rejects CBOR vector: ${vector.id}`, () => {
      const limits =
        vector.limits === undefined
          ? DEFAULT_HAIL_RESOURCE_LIMITS
          : {
              ...DEFAULT_HAIL_RESOURCE_LIMITS,
              maximumByteStringLength:
                vector.limits.maximum_byte_string_length,
            };
      expect(
        errorCode(() => decodeDeterministic(bytes(vector.hex), limits)),
      ).toBe(vector.expected_error);
    });
  }

  for (const vector of manifest.negative_payload) {
    it(`rejects payload vector: ${vector.id}`, () => {
      expect(
        errorCode(() => decodePayload(vector.type, bytes(vector.hex))),
      ).toBe(vector.expected_error);
    });
  }

  for (const vector of manifest.negative_cose) {
    it(`rejects COSE vector: ${vector.id}`, async () => {
      const representation = bytes(vector.hex);
      if (vector.operation === "inspect") {
        expect(
          errorCode(() => inspectSignedPayload(vector.type, representation)),
        ).toBe(vector.error);
        return;
      }

      const keyVector = manifest.test_keys[0];
      if (keyVector === undefined) throw new Error("test key vector missing");
      await expect(
        verifySignedPayload(vector.type, representation, {
          async verify(data, signature) {
            return nodeVerify(null, data, publicKey(keyVector), signature);
          },
        }),
      ).rejects.toMatchObject({ code: vector.error });
    });
  }

  it("matches bearer-token text boundary vectors", () => {
    const token = bytes(manifest.text_boundaries.bearer_token_hex);
    expect(encodeBase64Url(token)).toBe(
      manifest.text_boundaries.bearer_token_base64url,
    );
    expect(
      decodeBase64Url(manifest.text_boundaries.bearer_token_base64url, 32),
    ).toEqual(token);
    expect(manifest.text_boundaries.authorization_header).toBe(
      `Bearer ${manifest.text_boundaries.bearer_token_base64url}`,
    );
  });

  it("matches digest HTTP boundary vectors", () => {
    const digestBytes = bytes(manifest.text_boundaries.digest_hex);
    expect(encodeBase64Url(digestBytes)).toBe(
      manifest.text_boundaries.digest_base64url,
    );
    expect(manifest.text_boundaries.digest_url_segment).toBe(
      manifest.text_boundaries.digest_base64url,
    );
    expect(manifest.text_boundaries.strong_etag).toBe(
      `"${manifest.text_boundaries.digest_base64url}"`,
    );

    const addressVector = manifest.positive.find(
      (entry) => entry.id === "address-binding-basic",
    );
    if (addressVector?.cose_sign1_hex === undefined) {
      throw new Error("address-binding representation missing");
    }
    expect(digest(bytes(addressVector.cose_sign1_hex))).toEqual(digestBytes);

    const bodyDigest = bytes(manifest.text_boundaries.body_content_digest_hex);
    expect(manifest.text_boundaries.content_digest_header).toBe(
      `sha-256=:${Buffer.from(bodyDigest).toString("base64")}:`,
    );
    const bodyVector = manifest.positive.find(
      (entry) => entry.id === "body-spt-1-basic",
    );
    if (bodyVector === undefined) throw new Error("body vector missing");
    expect(digest(bytes(bodyVector.payload_hex))).toEqual(bodyDigest);
  });
});
