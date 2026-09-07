import {
  decode as decodeCbor,
  encode as encodeCbor,
  rfc8949EncodeOptions,
} from "cborg";

import { HailCodecError } from "./errors.js";
import {
  HAIL_MAX_INTEGER,
  HAIL_MIN_INTEGER,
  type HailValue,
} from "./types.js";
import { assertCborResourceLimits } from "./scan.js";

export interface HailResourceLimits {
  readonly maximumBytes: number;
  readonly maximumDepth: number;
  readonly maximumItems: number;
  readonly maximumArrayLength: number;
  readonly maximumMapEntries: number;
  readonly maximumTextBytes: number;
  readonly maximumByteStringLength: number;
}

export const DEFAULT_HAIL_RESOURCE_LIMITS: HailResourceLimits = {
  maximumBytes: 262_144,
  maximumDepth: 32,
  maximumItems: 16_384,
  maximumArrayLength: 4_096,
  maximumMapEntries: 256,
  maximumTextBytes: 262_144,
  maximumByteStringLength: 262_144,
};

const textEncoder = new TextEncoder();

const decodeOptions = {
  allowBigInt: false,
  allowIndefinite: false,
  allowInfinity: false,
  allowNaN: false,
  allowUndefined: false,
  rejectDuplicateMapKeys: true,
  strict: true,
  useMaps: true,
} as const;

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false;
  return left.every((value, index) => value === right[index]);
}

function argumentSize(value: number): number {
  if (value < 24) return 1;
  if (value <= 0xff) return 2;
  if (value <= 0xffff) return 3;
  if (value <= 0xffffffff) return 5;
  return 9;
}

function encodedSize(value: HailValue): number {
  if (value === null || typeof value === "boolean") return 1;
  if (typeof value === "number") {
    return argumentSize(value >= 0 ? value : -1 - value);
  }
  if (typeof value === "string") {
    const length = textEncoder.encode(value).length;
    return argumentSize(length) + length;
  }
  if (value instanceof Uint8Array) {
    return argumentSize(value.length) + value.length;
  }
  if (Array.isArray(value)) {
    return (
      argumentSize(value.length) +
      value.reduce((total, entry) => total + encodedSize(entry), 0)
    );
  }
  const entries = Object.entries(value);
  return (
    argumentSize(entries.length) +
    entries.reduce((total, [key, entry]) => {
      const keyLength = textEncoder.encode(key).length;
      return total + argumentSize(keyLength) + keyLength + encodedSize(entry);
    }, 0)
  );
}

function checkValue(
  value: unknown,
  limits: HailResourceLimits,
  path: string,
  depth: number,
  count: { value: number },
  allowMaps: boolean,
): void {
  count.value += 1;
  if (count.value > limits.maximumItems) {
    throw new HailCodecError("resource-limit", "too many values", path);
  }
  if (depth > limits.maximumDepth) {
    throw new HailCodecError("resource-limit", "maximum nesting depth exceeded", path);
  }

  if (value === null || typeof value === "boolean") return;

  if (typeof value === "number") {
    if (
      !Number.isSafeInteger(value) ||
      value < HAIL_MIN_INTEGER ||
      value > HAIL_MAX_INTEGER ||
      Object.is(value, -0)
    ) {
      throw new HailCodecError(
        "invalid-value",
        "numbers must be safe, non-negative-zero integers",
        path,
      );
    }
    return;
  }

  if (typeof value === "string") {
    if (!value.isWellFormed()) {
      throw new HailCodecError("invalid-value", "text contains an unpaired surrogate", path);
    }
    if (textEncoder.encode(value).length > limits.maximumTextBytes) {
      throw new HailCodecError("resource-limit", "text string is too large", path);
    }
    return;
  }

  if (value instanceof Uint8Array) {
    if (value.length > limits.maximumByteStringLength) {
      throw new HailCodecError("resource-limit", "byte string is too large", path);
    }
    return;
  }

  if (Array.isArray(value)) {
    if (value.length > limits.maximumArrayLength) {
      throw new HailCodecError("resource-limit", "array is too large", path);
    }
    const ownKeys = Reflect.ownKeys(value);
    if (ownKeys.some((key) => typeof key !== "string" || (key !== "length" && !/^(0|[1-9][0-9]*)$/.test(key)))) {
      throw new HailCodecError("invalid-value", "arrays may contain only indexed elements", path);
    }
    for (let index = 0; index < value.length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, index);
      if (descriptor === undefined) {
        throw new HailCodecError("invalid-value", "sparse arrays are prohibited", `${path}[${index}]`);
      }
      if (!("value" in descriptor) || !descriptor.enumerable) {
        throw new HailCodecError("invalid-value", "array entries must be enumerable data properties", `${path}[${index}]`);
      }
      checkValue(descriptor.value, limits, `${path}[${index}]`, depth + 1, count, allowMaps);
    }
    return;
  }

  if (value instanceof Map) {
    if (!allowMaps) {
      throw new HailCodecError("invalid-value", "native Map values are not accepted", path);
    }
    if (value.size > limits.maximumMapEntries) {
      throw new HailCodecError("resource-limit", "map has too many entries", path);
    }
    for (const [key, entry] of value.entries()) {
      if (typeof key !== "string") {
        throw new HailCodecError("invalid-value", "map keys must be text", path);
      }
      if (!key.isWellFormed() || textEncoder.encode(key).length > limits.maximumTextBytes) {
        throw new HailCodecError("resource-limit", "map key is invalid or too large", path);
      }
      checkValue(entry, limits, `${path}.${key}`, depth + 1, count, allowMaps);
    }
    return;
  }

  if (typeof value === "object") {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new HailCodecError(
        "invalid-value",
        "only plain objects are Hail maps",
        path,
      );
    }
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const ownKeys = Reflect.ownKeys(descriptors);
    if (ownKeys.some((key) => typeof key === "symbol")) {
      throw new HailCodecError("invalid-value", "symbol map keys are prohibited", path);
    }
    const entries = Object.entries(descriptors);
    if (entries.length > limits.maximumMapEntries) {
      throw new HailCodecError("resource-limit", "map has too many entries", path);
    }
    for (const [key, descriptor] of entries) {
      if (!key.isWellFormed() || textEncoder.encode(key).length > limits.maximumTextBytes) {
        throw new HailCodecError("resource-limit", "map key is invalid or too large", `${path}.${key}`);
      }
      if (!descriptor.enumerable || !("value" in descriptor)) {
        throw new HailCodecError(
          "invalid-value",
          "map members must be enumerable data properties",
          `${path}.${key}`,
        );
      }
      checkValue(descriptor.value, limits, `${path}.${key}`, depth + 1, count, allowMaps);
    }
    return;
  }

  throw new HailCodecError("invalid-value", "unsupported Hail value", path);
}

export function assertHailValue(
  value: unknown,
  limits: HailResourceLimits = DEFAULT_HAIL_RESOURCE_LIMITS,
): asserts value is HailValue {
  checkValue(value, limits, "$", 0, { value: 0 }, false);
  if (encodedSize(value as HailValue) > limits.maximumBytes) {
    throw new HailCodecError("resource-limit", "encoded value is too large", "$");
  }
}

export function encodeDeterministic(
  value: unknown,
  limits: HailResourceLimits = DEFAULT_HAIL_RESOURCE_LIMITS,
): Uint8Array {
  assertHailValue(value, limits);
  const encoded = encodeCbor(value, rfc8949EncodeOptions);
  if (encoded.length > limits.maximumBytes) {
    throw new HailCodecError("resource-limit", "encoded value is too large");
  }
  return encoded;
}

function mapsToObjects(value: unknown): HailValue {
  if (value instanceof Uint8Array) return value;
  if (Array.isArray(value)) return value.map(mapsToObjects);
  if (value instanceof Map) {
    const output: Record<string, HailValue> = Object.create(null) as Record<
      string,
      HailValue
    >;
    for (const [key, entry] of value.entries()) {
      if (typeof key !== "string") {
        throw new HailCodecError("invalid-value", "map keys must be text");
      }
      Object.defineProperty(output, key, {
        configurable: true,
        enumerable: true,
        value: mapsToObjects(entry),
        writable: true,
      });
    }
    return output;
  }
  return value as HailValue;
}

export function decodeDeterministic(
  bytes: Uint8Array,
  limits: HailResourceLimits = DEFAULT_HAIL_RESOURCE_LIMITS,
): HailValue {
  assertCborResourceLimits(bytes, limits);

  let decoded: unknown;
  try {
    decoded = decodeCbor(bytes, decodeOptions);
  } catch (cause) {
    throw new HailCodecError(
      "malformed-cbor",
      cause instanceof Error ? cause.message : "CBOR decoding failed",
    );
  }

  checkValue(decoded, limits, "$", 0, { value: 0 }, true);
  const reencoded = encodeCbor(decoded, rfc8949EncodeOptions);
  if (!equalBytes(bytes, reencoded)) {
    throw new HailCodecError(
      "non-deterministic-cbor",
      "input is not its deterministic RFC 8949 encoding",
    );
  }
  return mapsToObjects(decoded);
}
