import { HailCodecError } from "./errors.js";

const ALPHABET =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

export function encodeBase64Url(bytes: Uint8Array): string {
  let output = "";
  for (let index = 0; index < bytes.length; index += 3) {
    const first = bytes[index] ?? 0;
    const second = bytes[index + 1] ?? 0;
    const third = bytes[index + 2] ?? 0;
    const combined = (first << 16) | (second << 8) | third;
    output += ALPHABET[(combined >>> 18) & 63];
    output += ALPHABET[(combined >>> 12) & 63];
    if (index + 1 < bytes.length) output += ALPHABET[(combined >>> 6) & 63];
    if (index + 2 < bytes.length) output += ALPHABET[combined & 63];
  }
  return output;
}

export function decodeBase64Url(value: string, expectedLength?: number): Uint8Array {
  if (!/^[A-Za-z0-9_-]*$/.test(value) || value.length % 4 === 1) {
    throw new HailCodecError(
      "invalid-diagnostic-json",
      "value is not unpadded base64url",
    );
  }

  const output = new Uint8Array(Math.floor((value.length * 6) / 8));
  let accumulator = 0;
  let bits = 0;
  let outputIndex = 0;

  for (const character of value) {
    const digit = ALPHABET.indexOf(character);
    accumulator = (accumulator << 6) | digit;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      output[outputIndex] = (accumulator >>> bits) & 0xff;
      outputIndex += 1;
    }
  }

  if (bits > 0 && (accumulator & ((1 << bits) - 1)) !== 0) {
    throw new HailCodecError(
      "invalid-diagnostic-json",
      "value uses a noncanonical base64url tail",
    );
  }
  if (encodeBase64Url(output) !== value) {
    throw new HailCodecError(
      "invalid-diagnostic-json",
      "value is not canonical unpadded base64url",
    );
  }
  if (expectedLength !== undefined && output.length !== expectedLength) {
    throw new HailCodecError(
      "invalid-diagnostic-json",
      `decoded value must contain exactly ${expectedLength} bytes`,
    );
  }
  return output;
}
