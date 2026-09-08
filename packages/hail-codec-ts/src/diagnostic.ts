import { decodeBase64Url, encodeBase64Url } from "./base64url.js";
import { HailCodecError } from "./errors.js";
import { assertHailValue } from "./cbor.js";
import type { HailPayloadType, HailValue } from "./types.js";
import type { HailPayloadByType } from "./models.js";
import { validatePayload } from "./validation.js";

export type DiagnosticJson =
  | null
  | boolean
  | number
  | string
  | DiagnosticJson[]
  | { [key: string]: DiagnosticJson };

function convertToDiagnostic(value: HailValue, redactSecrets: boolean): DiagnosticJson {
  if (value instanceof Uint8Array) return encodeBase64Url(value);
  if (Array.isArray(value)) {
    return value.map((entry) => convertToDiagnostic(entry, redactSecrets));
  }
  if (value !== null && typeof value === "object") {
    const output: Record<string, DiagnosticJson> = Object.create(
      null,
    ) as Record<string, DiagnosticJson>;
    for (const [key, entry] of Object.entries(value)) {
      Object.defineProperty(output, key, {
        configurable: true,
        enumerable: true,
        value:
          redactSecrets && key === "token"
            ? "[REDACTED]"
            : convertToDiagnostic(entry, redactSecrets),
        writable: true,
      });
    }
    return output;
  }
  return value;
}

export function toDiagnosticJson<T extends HailPayloadType>(
  type: T,
  value: HailPayloadByType[T],
  redactSecrets = true,
): DiagnosticJson {
  assertHailValue(value);
  validatePayload(type, value);
  return convertToDiagnostic(value, redactSecrets);
}

function fromJson(value: DiagnosticJson, parent?: Record<string, DiagnosticJson>, key?: string): HailValue {
  if (Array.isArray(value)) return value.map((entry) => fromJson(entry));
  if (value !== null && typeof value === "object") {
    const output: Record<string, HailValue> = Object.create(null) as Record<
      string,
      HailValue
    >;
    for (const [childKey, childValue] of Object.entries(value)) {
      Object.defineProperty(output, childKey, {
        configurable: true,
        enumerable: true,
        value: fromJson(childValue, value, childKey),
        writable: true,
      });
    }
    return output;
  }
  if (typeof value === "string") {
    if (key === "token") return decodeBase64Url(value, 32);
    if (key === "previous") return decodeBase64Url(value, 32);
    if (key === "value" && parent?.algorithm === "sha-256") {
      return decodeBase64Url(value, 32);
    }
  }
  return value;
}

export function fromDiagnosticJson<T extends HailPayloadType>(
  type: T,
  value: DiagnosticJson,
): HailPayloadByType[T] {
  assertHailValue(value);
  let converted: HailValue;
  try {
    converted = fromJson(value);
  } catch (error) {
    if (error instanceof HailCodecError) throw error;
    throw new HailCodecError(
      "invalid-diagnostic-json",
      error instanceof Error ? error.message : String(error),
    );
  }
  const result: unknown = converted;
  validatePayload(type, result);
  return result;
}
