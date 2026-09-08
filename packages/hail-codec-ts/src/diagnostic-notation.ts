import { assertHailValue } from "./cbor.js";
import type { HailValue } from "./types.js";

const textEncoder = new TextEncoder();

function compareKeys(left: string, right: string): number {
  const leftBytes = textEncoder.encode(left);
  const rightBytes = textEncoder.encode(right);
  if (leftBytes.length !== rightBytes.length) {
    return leftBytes.length - rightBytes.length;
  }
  for (let index = 0; index < leftBytes.length; index += 1) {
    const difference = (leftBytes[index] as number) - (rightBytes[index] as number);
    if (difference !== 0) return difference;
  }
  return 0;
}

function byteString(value: Uint8Array): string {
  let output = "";
  for (const byte of value) output += byte.toString(16).padStart(2, "0");
  return `h'${output}'`;
}

function textString(value: string): string {
  return JSON.stringify(value).replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, (character) => {
    let escaped = "";
    for (let index = 0; index < character.length; index += 1) {
      escaped += `\\u${character.charCodeAt(index).toString(16).padStart(4, "0")}`;
    }
    return escaped;
  });
}

function formatValue(
  value: HailValue,
  depth: number,
  redactSecrets: boolean,
): string {
  if (value === null) return "null";
  if (typeof value === "boolean" || typeof value === "number") {
    return String(value);
  }
  if (typeof value === "string") return textString(value);
  if (value instanceof Uint8Array) return byteString(value);

  const indentation = "  ".repeat(depth);
  const childIndentation = "  ".repeat(depth + 1);
  if (Array.isArray(value)) {
    if (value.length === 0) return "[]";
    const entries = value.map(
      (entry) => `${childIndentation}${formatValue(entry, depth + 1, redactSecrets)}`,
    );
    return `[\n${entries.join(",\n")}\n${indentation}]`;
  }

  const entries = Object.entries(value).sort(([left], [right]) =>
    compareKeys(left, right),
  );
  if (entries.length === 0) return "{}";
  const formatted = entries.map(([key, entry]) => {
    const rendered =
      redactSecrets && key === "token"
        ? '"[REDACTED]"'
        : formatValue(entry, depth + 1, redactSecrets);
    return `${childIndentation}${textString(key)}: ${rendered}`;
  });
  return `{\n${formatted.join(",\n")}\n${indentation}}`;
}

export function toDiagnosticNotation(
  value: unknown,
  redactSecrets = true,
): string {
  assertHailValue(value);
  return formatValue(value, 0, redactSecrets);
}
