import { gzipSync } from "node:zlib";
import { readFile } from "node:fs/promises";

interface PositiveVector {
  readonly id: string;
  readonly diagnostic: unknown;
  readonly payload_hex: string;
  readonly cose_sign1_hex?: string;
}

interface Manifest {
  readonly positive: readonly PositiveVector[];
}

const manifest = JSON.parse(
  await readFile(new URL("../vectors/v0.json", import.meta.url), "utf8"),
) as Manifest;

const rows = manifest.positive.map((vector) => {
  const payload = Buffer.from(vector.payload_hex, "hex");
  const diagnostic = Buffer.from(JSON.stringify(vector.diagnostic), "utf8");
  const signed =
    vector.cose_sign1_hex === undefined
      ? undefined
      : Buffer.from(vector.cose_sign1_hex, "hex");
  return {
    vector: vector.id,
    cbor_bytes: payload.length,
    diagnostic_json_bytes: diagnostic.length,
    cbor_vs_diagnostic_json_percent: Number(
      ((payload.length / diagnostic.length) * 100).toFixed(1),
    ),
    gzip_cbor_bytes: gzipSync(payload).length,
    cose_sign1_bytes: signed?.length ?? "n/a",
  };
});

console.table(rows);
