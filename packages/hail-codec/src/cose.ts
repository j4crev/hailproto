import {
  decode as decodeCbor,
  encode as encodeCbor,
  rfc8949EncodeOptions,
  Tagged,
} from "cborg";

import { decodeDeterministic } from "./cbor.js";
import type { HailResourceLimits } from "./cbor.js";
import { HailCodecError } from "./errors.js";
import {
  COSE_ALGORITHM_HEADER,
  COSE_CONTENT_TYPE_HEADER,
  COSE_ED25519_ALGORITHM,
  COSE_KEY_ID_HEADER,
  COSE_SIGN1_TAG,
  SIGNED_PROFILES,
} from "./profiles.js";
import type {
  HailSigner,
  HailSignedPayloadType,
  HailVerifier,
  InspectedHailObject,
  VerifiedHailObject,
} from "./types.js";
import type { HailPayloadByType } from "./models.js";
import { expectedKeyId, validatePayload } from "./validation.js";
import { encodePayload } from "./payload.js";
import { assertCborResourceLimits } from "./scan.js";

const textDecoder = new TextDecoder("utf-8", { fatal: true });
const textEncoder = new TextEncoder();
const EMPTY_BYTES = new Uint8Array();

const strictDecodeOptions = {
  allowBigInt: false,
  allowIndefinite: false,
  allowInfinity: false,
  allowNaN: false,
  allowUndefined: false,
  rejectDuplicateMapKeys: true,
  strict: true,
  useMaps: true,
} as const;

interface ParsedCose<T extends HailSignedPayloadType> {
  readonly keyId: string;
  readonly payload: HailPayloadByType[T];
  readonly payloadBytes: Uint8Array;
  readonly protectedBytes: Uint8Array;
  readonly representationBytes: Uint8Array;
  readonly signature: Uint8Array;
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false;
  return left.every((value, index) => value === right[index]);
}

function encodeCoseValue(value: unknown): Uint8Array {
  return encodeCbor(value, rfc8949EncodeOptions);
}

function malformed(message: string): never {
  throw new HailCodecError("invalid-cose", message);
}

function coseLimits(maximumBytes: number): HailResourceLimits {
  return {
    maximumBytes,
    maximumDepth: 8,
    maximumItems: 256,
    maximumArrayLength: 8,
    maximumMapEntries: 8,
    maximumTextBytes: 1_024,
    maximumByteStringLength: maximumBytes,
  };
}

function parseCose<T extends HailSignedPayloadType>(
  type: T,
  representation: Uint8Array,
): ParsedCose<T> {
  const profile = SIGNED_PROFILES[type];
  if (
    profile.maximumRepresentationBytes !== undefined &&
    representation.length > profile.maximumRepresentationBytes
  ) {
    throw new HailCodecError("resource-limit", "signed representation is too large");
  }
  const representationBytes = representation.slice();
  assertCborResourceLimits(
    representationBytes,
    coseLimits(profile.maximumRepresentationBytes ?? 262_144),
    { allowedTags: new Set([COSE_SIGN1_TAG]) },
  );

  let tagged: unknown;
  try {
    tagged = decodeCbor(representationBytes, {
      ...strictDecodeOptions,
      tags: Tagged.preserve(COSE_SIGN1_TAG),
    });
  } catch (error) {
    throw new HailCodecError(
      "invalid-cose",
      `malformed COSE_Sign1: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  if (!(tagged instanceof Tagged) || tagged.tag !== COSE_SIGN1_TAG) {
    malformed("tag 18 is required");
  }
  if (!equalBytes(encodeCoseValue(tagged), representationBytes)) {
    throw new HailCodecError(
      "non-deterministic-cbor",
      "COSE_Sign1 is not deterministically encoded",
    );
  }
  if (!Array.isArray(tagged.value) || tagged.value.length !== 4) {
    malformed("COSE_Sign1 must contain exactly four elements");
  }

  const [protectedBytes, unprotected, payloadBytes, signature] = tagged.value as unknown[];
  if (!(protectedBytes instanceof Uint8Array)) malformed("protected header must be bytes");
  if (!(unprotected instanceof Map) || unprotected.size !== 0) {
    malformed("unprotected header must be an empty map");
  }
  if (!(payloadBytes instanceof Uint8Array)) malformed("embedded payload must be bytes");
  if (!(signature instanceof Uint8Array) || signature.length !== 64) {
    malformed("signature must be exactly 64 bytes");
  }

  let protectedHeader: unknown;
  assertCborResourceLimits(protectedBytes, coseLimits(1_024));
  try {
    protectedHeader = decodeCbor(protectedBytes, strictDecodeOptions);
  } catch (error) {
    malformed(
      `malformed protected header: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!(protectedHeader instanceof Map) || protectedHeader.size !== 3) {
    malformed("protected header must contain exactly alg, content type, and kid");
  }
  if (!equalBytes(encodeCoseValue(protectedHeader), protectedBytes)) {
    throw new HailCodecError(
      "non-deterministic-cbor",
      "protected header is not deterministically encoded",
    );
  }
  if (protectedHeader.get(COSE_ALGORITHM_HEADER) !== COSE_ED25519_ALGORITHM) {
    throw new HailCodecError(
      "unsupported-algorithm",
      "protected alg must be RFC 9864 Ed25519 (-19)",
    );
  }
  if (protectedHeader.get(COSE_CONTENT_TYPE_HEADER) !== profile.contentType) {
    throw new HailCodecError(
      "wrong-content-type",
      `protected content type must be ${profile.contentType}`,
    );
  }
  const kid = protectedHeader.get(COSE_KEY_ID_HEADER);
  if (!(kid instanceof Uint8Array)) malformed("protected kid must be bytes");

  let keyId: string;
  try {
    keyId = textDecoder.decode(kid);
  } catch {
    malformed("protected kid must contain valid UTF-8");
  }

  const payload: unknown = decodeDeterministic(payloadBytes, {
    maximumBytes: profile.maximumRepresentationBytes ?? 262_144,
    maximumDepth: 32,
    maximumItems: 16_384,
    maximumArrayLength: 4_096,
    maximumMapEntries: 256,
    maximumTextBytes: 262_144,
    maximumByteStringLength: 262_144,
  });
  validatePayload(type, payload);
  if (keyId !== expectedKeyId(type, payload)) {
    throw new HailCodecError(
      "wrong-key-role",
      "protected kid does not match the payload signer and required key role",
    );
  }
  if ("key_id" in payload && payload.key_id !== keyId) {
    throw new HailCodecError(
      "wrong-key-role",
      "protected kid does not match payload key_id",
    );
  }

  return {
    keyId,
    payload,
    payloadBytes,
    protectedBytes,
    representationBytes,
    signature,
  };
}

function inspectedResult<T extends HailSignedPayloadType>(
  type: T,
  parsed: ParsedCose<T>,
): InspectedHailObject<HailPayloadByType[T]> {
  return Object.freeze({
    type,
    keyId: parsed.keyId,
    get payload() {
      return structuredClone(parsed.payload);
    },
    get payloadBytes() {
      return parsed.payloadBytes.slice();
    },
    get representationBytes() {
      return parsed.representationBytes.slice();
    },
  });
}

function signatureStructure(protectedBytes: Uint8Array, payloadBytes: Uint8Array): Uint8Array {
  return encodeCoseValue(["Signature1", protectedBytes, EMPTY_BYTES, payloadBytes]);
}

export async function signPayload<T extends HailSignedPayloadType>(
  type: T,
  payload: HailPayloadByType[T],
  signer: HailSigner,
): Promise<Uint8Array> {
  validatePayload(type, payload);
  if (signer.keyId !== expectedKeyId(type, payload)) {
    throw new HailCodecError(
      "wrong-key-role",
      "signer key ID does not match the payload signer and required key role",
    );
  }

  const profile = SIGNED_PROFILES[type];
  const payloadBytes = encodePayload(type, payload);
  const protectedHeader = new Map<number, number | string | Uint8Array>([
    [COSE_ALGORITHM_HEADER, COSE_ED25519_ALGORITHM],
    [COSE_CONTENT_TYPE_HEADER, profile.contentType],
    [COSE_KEY_ID_HEADER, textEncoder.encode(signer.keyId)],
  ]);
  const protectedBytes = encodeCoseValue(protectedHeader);
  const signature = await signer.sign(signatureStructure(protectedBytes, payloadBytes));
  if (!(signature instanceof Uint8Array) || signature.length !== 64) {
    malformed("signer must return exactly 64 signature bytes");
  }

  const representation = encodeCoseValue(
    new Tagged(COSE_SIGN1_TAG, [protectedBytes, new Map(), payloadBytes, signature]),
  );
  if (
    profile.maximumRepresentationBytes !== undefined &&
    representation.length > profile.maximumRepresentationBytes
  ) {
    throw new HailCodecError("resource-limit", "signed representation is too large");
  }
  return representation;
}

export function inspectSignedPayload<T extends HailSignedPayloadType>(
  type: T,
  representation: Uint8Array,
): InspectedHailObject<HailPayloadByType[T]> {
  const parsed = parseCose(type, representation);
  return inspectedResult(type, parsed);
}

export async function verifySignedPayload<T extends HailSignedPayloadType>(
  type: T,
  representation: Uint8Array,
  verifier: HailVerifier,
): Promise<VerifiedHailObject<HailPayloadByType[T]>> {
  const parsed = parseCose(type, representation);
  const valid = await verifier.verify(
    signatureStructure(parsed.protectedBytes, parsed.payloadBytes),
    parsed.signature,
    parsed.keyId,
  );
  if (!valid) throw new HailCodecError("invalid-signature", "signature verification failed");
  return inspectedResult(type, parsed) as VerifiedHailObject<
    HailPayloadByType[T]
  >;
}
