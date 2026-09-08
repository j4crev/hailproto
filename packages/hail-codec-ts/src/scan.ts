import { HailCodecError } from "./errors.js";
import type { HailResourceLimits } from "./cbor.js";

interface ScanOptions {
  readonly allowedTags?: ReadonlySet<number>;
}

function resource(message: string): never {
  throw new HailCodecError("resource-limit", message);
}

export function assertCborResourceLimits(
  bytes: Uint8Array,
  limits: HailResourceLimits,
  options: ScanOptions = {},
): void {
  if (bytes.length > limits.maximumBytes) resource("encoded value is too large");

  let offset = 0;
  let items = 0;

  function readLength(additional: number): number {
    if (additional < 24) return additional;
    const byteCount = additional === 24 ? 1 : additional === 25 ? 2 : additional === 26 ? 4 : additional === 27 ? 8 : 0;
    if (byteCount === 0) {
      if (additional === 31) {
        throw new HailCodecError("malformed-cbor", "indefinite lengths are prohibited");
      }
      throw new HailCodecError("malformed-cbor", "invalid CBOR additional information");
    }
    if (offset + byteCount > bytes.length) {
      throw new HailCodecError("malformed-cbor", "truncated CBOR argument");
    }
    let value = 0n;
    for (let index = 0; index < byteCount; index += 1) {
      value = (value << 8n) | BigInt(bytes[offset + index] ?? 0);
    }
    offset += byteCount;
    if (value > BigInt(Number.MAX_SAFE_INTEGER)) resource("CBOR length or argument is too large");
    return Number(value);
  }

  function scan(depth: number): void {
    items += 1;
    if (items > limits.maximumItems) resource("too many CBOR items");
    if (depth > limits.maximumDepth) resource("maximum CBOR nesting depth exceeded");
    if (offset >= bytes.length) {
      throw new HailCodecError("malformed-cbor", "truncated CBOR item");
    }

    const initial = bytes[offset] as number;
    offset += 1;
    const major = initial >>> 5;
    const additional = initial & 31;

    if (major === 0 || major === 1) {
      readLength(additional);
      return;
    }

    if (major === 2 || major === 3) {
      const length = readLength(additional);
      const maximum =
        major === 2 ? limits.maximumByteStringLength : limits.maximumTextBytes;
      if (length > maximum) resource(major === 2 ? "byte string is too large" : "text string is too large");
      if (offset + length > bytes.length) {
        throw new HailCodecError("malformed-cbor", "truncated CBOR string");
      }
      offset += length;
      return;
    }

    if (major === 4) {
      const length = readLength(additional);
      if (length > limits.maximumArrayLength) resource("array is too large");
      for (let index = 0; index < length; index += 1) scan(depth + 1);
      return;
    }

    if (major === 5) {
      const length = readLength(additional);
      if (length > limits.maximumMapEntries) resource("map has too many entries");
      for (let index = 0; index < length; index += 1) {
        scan(depth + 1);
        scan(depth + 1);
      }
      return;
    }

    if (major === 6) {
      const tag = readLength(additional);
      if (!options.allowedTags?.has(tag)) {
        throw new HailCodecError("malformed-cbor", `CBOR tag ${tag} is prohibited`);
      }
      scan(depth + 1);
      return;
    }

    if (major === 7) {
      if (additional < 24) return;
      const byteCount = additional === 24 ? 1 : additional === 25 ? 2 : additional === 26 ? 4 : additional === 27 ? 8 : 0;
      if (byteCount === 0 || offset + byteCount > bytes.length) {
        throw new HailCodecError("malformed-cbor", "invalid or truncated CBOR simple value");
      }
      offset += byteCount;
      return;
    }

    throw new HailCodecError("malformed-cbor", "unknown CBOR major type");
  }

  scan(0);
  if (offset !== bytes.length) {
    throw new HailCodecError("malformed-cbor", "trailing bytes are prohibited");
  }
}
