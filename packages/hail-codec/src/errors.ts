export type HailCodecErrorCode =
  | "invalid-value"
  | "resource-limit"
  | "malformed-cbor"
  | "non-deterministic-cbor"
  | "schema-violation"
  | "invalid-cose"
  | "unsupported-algorithm"
  | "wrong-content-type"
  | "wrong-key-role"
  | "invalid-signature"
  | "invalid-diagnostic-json";

export class HailCodecError extends Error {
  readonly code: HailCodecErrorCode;
  readonly path: string | undefined;

  constructor(code: HailCodecErrorCode, message: string, path?: string) {
    super(path === undefined ? message : `${path}: ${message}`);
    this.name = "HailCodecError";
    this.code = code;
    this.path = path;
  }
}
