import {
  createHash,
  createPrivateKey,
  createPublicKey,
  sign as nodeSign,
} from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";

import { decode, encode, rfc8949EncodeOptions, Tagged } from "cborg";

import {
  encodeBase64Url,
  encodePayload,
  signPayload,
  toDiagnosticJson,
  type HailPayloadByType,
  type HailPayloadType,
  type HailSignedPayloadType,
} from "../src/index.js";
import {
  addressBinding,
  body,
  deliveryStatus,
  envelope,
  grant,
  senderProfile,
} from "../test/fixtures.js";

const outputUrl = new URL("../vectors/v0.json", import.meta.url);
const PKCS8_PREFIX = "302e020100300506032b657004220420";
const SPKI_PREFIX_BYTES = 12;

const seedsByKeyId = new Map([
  [addressBinding.key_id, sequence(0x00)],
  [senderProfile.key_id, sequence(0x20)],
  [`${deliveryStatus.from}#hail-messaging`, sequence(0x40)],
]);

function sequence(start: number): Uint8Array {
  return Uint8Array.from({ length: 32 }, (_, index) => start + index);
}

function hex(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("hex");
}

function sha256(bytes: Uint8Array): Uint8Array {
  return new Uint8Array(createHash("sha256").update(bytes).digest());
}

function privateKey(seed: Uint8Array) {
  return createPrivateKey({
    format: "der",
    key: Buffer.from(`${PKCS8_PREFIX}${hex(seed)}`, "hex"),
    type: "pkcs8",
  });
}

function signedMutation(
  representation: Uint8Array,
  mutate: (elements: unknown[]) => void,
): Uint8Array {
  const tagged = decode(representation, {
    tags: Tagged.preserve(18),
    useMaps: true,
  }) as Tagged;
  const elements = tagged.value as unknown[];
  mutate(elements);
  return encode(tagged, rfc8949EncodeOptions);
}

function protectedMutation(
  representation: Uint8Array,
  mutate: (header: Map<number, unknown>) => void,
): Uint8Array {
  return signedMutation(representation, (elements) => {
    const header = decode(elements[0] as Uint8Array, { useMaps: true }) as Map<
      number,
      unknown
    >;
    mutate(header);
    elements[0] = encode(header, rfc8949EncodeOptions);
  });
}

const positive: Array<Record<string, unknown>> = [];
const signedByType = new Map<HailSignedPayloadType, Uint8Array>();

async function addPositive<T extends HailPayloadType>(
  id: string,
  type: T,
  value: HailPayloadByType[T],
): Promise<{ payloadBytes: Uint8Array; signedBytes?: Uint8Array }> {
  const payloadBytes = encodePayload(type, value);
  const payloadDigest = sha256(payloadBytes);
  let signedBytes: Uint8Array | undefined;
  let representationDigest: Uint8Array | undefined;
  let signatureStructure: Uint8Array | undefined;

  if (type !== "hail.body.spt-1") {
    const signedValue = value as HailPayloadByType[HailSignedPayloadType];
    const keyId =
      "key_id" in signedValue
        ? signedValue.key_id
        : `${signedValue.from}#hail-messaging`;
    const seed = seedsByKeyId.get(keyId);
    if (seed === undefined) throw new Error(`missing test seed for ${keyId}`);
    const key = privateKey(seed);
    signedBytes = await signPayload(type, signedValue as never, {
      keyId,
      async sign(data) {
        return nodeSign(null, data, key);
      },
    });
    representationDigest = sha256(signedBytes);
    signedByType.set(type, signedBytes);
    const tagged = decode(signedBytes, {
      tags: Tagged.preserve(18),
      useMaps: true,
    }) as Tagged;
    const [protectedHeader, , embeddedPayload] = tagged.value as unknown[];
    signatureStructure = encode(
      ["Signature1", protectedHeader, new Uint8Array(), embeddedPayload],
      rfc8949EncodeOptions,
    );
  }

  positive.push({
    id,
    type,
    diagnostic: toDiagnosticJson(type, value, false),
    payload_hex: hex(payloadBytes),
    payload_sha256_hex: hex(payloadDigest),
    payload_sha256_base64url: encodeBase64Url(payloadDigest),
    ...(signedBytes === undefined
      ? {}
      : {
          cose_sign1_hex: hex(signedBytes),
          sig_structure_hex: hex(signatureStructure as Uint8Array),
          representation_sha256_hex: hex(representationDigest as Uint8Array),
          representation_sha256_base64url: encodeBase64Url(
            representationDigest as Uint8Array,
          ),
        }),
  });
  return signedBytes === undefined
    ? { payloadBytes }
    : { payloadBytes, signedBytes };
}

function requireSigned(
  result: { readonly signedBytes?: Uint8Array },
  id: string,
): Uint8Array {
  if (result.signedBytes === undefined) throw new Error(`${id} must be signed`);
  return result.signedBytes;
}

const addressVector = await addPositive(
  "address-binding-basic",
  "hail.address-binding",
  addressBinding,
);
const senderProfileVector = await addPositive(
  "sender-profile-basic",
  "hail.sender-profile",
  senderProfile,
);
const bodyVector = await addPositive(
  "body-spt-1-basic",
  "hail.body.spt-1",
  body,
);

const linkedGrant = structuredClone(grant);
linkedGrant.consent_context.address_binding_hash.value = sha256(
  requireSigned(addressVector, "address-binding-basic"),
);
linkedGrant.consent_context.sender_profile_hash.value = sha256(
  requireSigned(senderProfileVector, "sender-profile-basic"),
);
const grantVector = await addPositive(
  "grant-revision-1",
  "hail.grant",
  linkedGrant,
);
const linkedGrantRevision2 = structuredClone(linkedGrant);
linkedGrantRevision2.revision = 2;
linkedGrantRevision2.previous = sha256(
  requireSigned(grantVector, "grant-revision-1"),
);
linkedGrantRevision2.updated_at += 60;
await addPositive(
  "grant-revision-2",
  "hail.grant",
  linkedGrantRevision2,
);

const linkedEnvelope = structuredClone(envelope);
linkedEnvelope.body.digest.value = sha256(bodyVector.payloadBytes);
linkedEnvelope.body.size = bodyVector.payloadBytes.length;
const envelopeVector = await addPositive(
  "envelope-basic",
  "hail.envelope",
  linkedEnvelope,
);

const linkedDeliveryStatus = structuredClone(deliveryStatus);
linkedDeliveryStatus.envelope_digest.value = sha256(envelopeVector.payloadBytes);
await addPositive(
  "delivery-status-basic",
  "hail.delivery-status",
  linkedDeliveryStatus,
);

const addressSigned = signedByType.get("hail.address-binding");
if (addressSigned === undefined) throw new Error("address-binding vector missing");

const wrongSignature = addressSigned.slice();
const finalSignatureByte = wrongSignature.length - 1;
wrongSignature[finalSignatureByte] =
  (wrongSignature[finalSignatureByte] as number) ^ 1;
const untagged = addressSigned.slice(1);
const protectedBytes = (decode(addressSigned, {
  tags: Tagged.preserve(18),
  useMaps: true,
}) as Tagged).value[0] as Uint8Array;
const duplicateProtected = new Uint8Array([
  (protectedBytes[0] as number) + 1,
  0x01,
  0x32,
  0x01,
  0x32,
  ...protectedBytes.slice(3),
]);

const negativeCbor: Array<{
  id: string;
  hex: string;
  expected_error: string;
  limits?: { maximum_byte_string_length: number };
}> = [
  ["duplicate-map-key", "a2616101616102", "malformed-cbor"],
  ["non-shortest-integer", "1801", "malformed-cbor"],
  ["wrong-map-order", "a2616201616102", "non-deterministic-cbor"],
  ["indefinite-array", "9f01ff", "malformed-cbor"],
  ["prohibited-tag", "c100", "malformed-cbor"],
  ["floating-point", "f93c00", "non-deterministic-cbor"],
  ["invalid-utf8", "61ff", "non-deterministic-cbor"],
  ["trailing-data", "0102", "malformed-cbor"],
  ["non-text-map-key", "a10102", "invalid-value"],
  ["undefined", "f7", "malformed-cbor"],
  [
    "excessive-nesting",
    `${"81".repeat(33)}00`,
    "resource-limit",
  ],
].map(([id, value, error]) => ({
  id: id as string,
  hex: value as string,
  expected_error: error as string,
}));
negativeCbor.push({
  id: "oversized-byte-string-declaration",
  hex: "450000000000",
  expected_error: "resource-limit",
  limits: { maximum_byte_string_length: 4 },
});

const negativeCose = [
  { id: "untagged-sign1", bytes: untagged, error: "invalid-cose", operation: "inspect" },
  {
    id: "wrong-algorithm",
    bytes: protectedMutation(addressSigned, (header) => header.set(1, -8)),
    error: "unsupported-algorithm",
    operation: "inspect",
  },
  {
    id: "wrong-content-type",
    bytes: protectedMutation(addressSigned, (header) =>
      header.set(3, "application/hail-envelope+cbor"),
    ),
    error: "wrong-content-type",
    operation: "inspect",
  },
  {
    id: "nonempty-unprotected-header",
    bytes: signedMutation(addressSigned, (elements) => {
      elements[1] = new Map([[5, new Uint8Array([1])]]);
    }),
    error: "invalid-cose",
    operation: "inspect",
  },
  {
    id: "detached-payload",
    bytes: signedMutation(addressSigned, (elements) => {
      elements[2] = null;
    }),
    error: "invalid-cose",
    operation: "inspect",
  },
  {
    id: "short-signature",
    bytes: signedMutation(addressSigned, (elements) => {
      elements[3] = new Uint8Array(63);
    }),
    error: "invalid-cose",
    operation: "inspect",
  },
  {
    id: "duplicate-protected-label",
    bytes: signedMutation(addressSigned, (elements) => {
      elements[0] = duplicateProtected;
    }),
    error: "invalid-cose",
    operation: "inspect",
  },
  {
    id: "missing-protected-label",
    bytes: protectedMutation(addressSigned, (header) => header.delete(4)),
    error: "invalid-cose",
    operation: "inspect",
  },
  {
    id: "unknown-protected-label",
    bytes: protectedMutation(addressSigned, (header) => header.set(99, true)),
    error: "invalid-cose",
    operation: "inspect",
  },
  {
    id: "non-byte-key-id",
    bytes: protectedMutation(addressSigned, (header) =>
      header.set(4, addressBinding.key_id),
    ),
    error: "invalid-cose",
    operation: "inspect",
  },
  {
    id: "invalid-utf8-key-id",
    bytes: protectedMutation(addressSigned, (header) =>
      header.set(4, new Uint8Array([0xff])),
    ),
    error: "invalid-cose",
    operation: "inspect",
  },
  {
    id: "wrong-key-role",
    bytes: protectedMutation(addressSigned, (header) =>
      header.set(
        4,
        new TextEncoder().encode(
          "did:plc:aaaaaaaaaaaaaaaaaaaaaaaa#hail-messaging",
        ),
      ),
    ),
    error: "wrong-key-role",
    operation: "inspect",
  },
  {
    id: "malformed-embedded-payload",
    bytes: signedMutation(addressSigned, (elements) => {
      elements[2] = new Uint8Array([0x18, 0x01]);
    }),
    error: "malformed-cbor",
    operation: "inspect",
  },
  {
    id: "extra-sign1-element",
    bytes: signedMutation(addressSigned, (elements) => {
      elements.push(null);
    }),
    error: "invalid-cose",
    operation: "inspect",
  },
  {
    id: "invalid-signature",
    bytes: wrongSignature,
    error: "invalid-signature",
    operation: "verify",
  },
].map(({ bytes, ...entry }) => ({
  ...entry,
  type: "hail.address-binding",
  hex: hex(bytes),
}));

const testKeys = [...seedsByKeyId].map(([keyId, seed]) => {
  const spki = createPublicKey(privateKey(seed)).export({ format: "der", type: "spki" });
  return {
    key_id: keyId,
    seed_hex: hex(seed),
    public_key_hex: hex(new Uint8Array(spki).slice(SPKI_PREFIX_BYTES)),
  };
});

function digestDomain(
  id: string,
  sourceVector: string,
  sourceField: "payload_hex" | "cose_sign1_hex",
  sourceBytes: Uint8Array,
  targetVector: string,
  targetPath: string,
) {
  const value = sha256(sourceBytes);
  return {
    id,
    source_vector: sourceVector,
    source_field: sourceField,
    target_vector: targetVector,
    target_path: targetPath,
    sha256_hex: hex(value),
    sha256_base64url: encodeBase64Url(value),
  };
}

const digestDomains = [
  digestDomain(
    "address-binding-representation",
    "address-binding-basic",
    "cose_sign1_hex",
    requireSigned(addressVector, "address-binding-basic"),
    "grant-revision-1",
    "consent_context.address_binding_hash.value",
  ),
  digestDomain(
    "sender-profile-representation",
    "sender-profile-basic",
    "cose_sign1_hex",
    requireSigned(senderProfileVector, "sender-profile-basic"),
    "grant-revision-1",
    "consent_context.sender_profile_hash.value",
  ),
  digestDomain(
    "grant-revision-representation",
    "grant-revision-1",
    "cose_sign1_hex",
    requireSigned(grantVector, "grant-revision-1"),
    "grant-revision-2",
    "previous",
  ),
  digestDomain(
    "body-content",
    "body-spt-1-basic",
    "payload_hex",
    bodyVector.payloadBytes,
    "envelope-basic",
    "body.digest.value",
  ),
  digestDomain(
    "envelope-payload",
    "envelope-basic",
    "payload_hex",
    envelopeVector.payloadBytes,
    "delivery-status-basic",
    "envelope_digest.value",
  ),
];

const missingPrevious = structuredClone(linkedGrantRevision2) as unknown as Record<
  string,
  unknown
>;
delete missingPrevious.previous;
const textDigestEnvelope = structuredClone(linkedEnvelope);
(textDigestEnvelope.body.digest as unknown as { value: unknown }).value =
  encodeBase64Url(linkedEnvelope.body.digest.value);
const unknownAddressMember = {
  ...addressBinding,
  unknown: true,
};
const negativePayload = [
  {
    id: "grant-previous-absent",
    type: "hail.grant",
    hex: hex(encode(missingPrevious, rfc8949EncodeOptions)),
    expected_error: "schema-violation",
  },
  {
    id: "envelope-digest-as-text",
    type: "hail.envelope",
    hex: hex(encode(textDigestEnvelope, rfc8949EncodeOptions)),
    expected_error: "schema-violation",
  },
  {
    id: "address-binding-unknown-member",
    type: "hail.address-binding",
    hex: hex(encode(unknownAddressMember, rfc8949EncodeOptions)),
    expected_error: "schema-violation",
  },
];

const token = envelope.body.access?.token;
if (token === undefined) throw new Error("envelope token missing");
const addressRepresentationDigest = sha256(addressSigned);
const bodyBytes = encodePayload("hail.body.spt-1", body);
const bodyDigest = sha256(bodyBytes);
const addressDigestText = encodeBase64Url(addressRepresentationDigest);
const tokenText = encodeBase64Url(token);

const manifest = {
  format: "hail-conformance-vectors-1",
  generated_by: "@hailproto/codec@0.0.0",
  signature_profile: "COSE_Sign1 / RFC 9864 Ed25519 (-19)",
  test_keys: testKeys,
  positive,
  digest_domains: digestDomains,
  text_boundaries: {
    digest_hex: hex(addressRepresentationDigest),
    digest_base64url: addressDigestText,
    digest_url_segment: addressDigestText,
    strong_etag: `"${addressDigestText}"`,
    bearer_token_hex: hex(token),
    bearer_token_base64url: tokenText,
    authorization_header: `Bearer ${tokenText}`,
    body_content_digest_hex: hex(bodyDigest),
    content_digest_header: `sha-256=:${Buffer.from(bodyDigest).toString("base64")}:`,
  },
  negative_cbor: negativeCbor,
  negative_payload: negativePayload,
  negative_cose: negativeCose,
};

await mkdir(new URL("../vectors/", import.meta.url), { recursive: true });
await writeFile(outputUrl, `${JSON.stringify(manifest, null, 2)}\n`);
