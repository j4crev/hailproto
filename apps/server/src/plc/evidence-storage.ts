import { decodeDeterministic, encodeDeterministic, type HailValue } from "@hailproto/codec";
import type { SQL } from "bun";
import { evidenceHash, PUBLIC_EVIDENCE_LIMITS } from "./read-evidence.js";

// Share exact encoded witness bytes, never just a head CID. A head can stay the
// same while nullified audit branches or reader/operator declarations change.
export function splitPublicEvidence(bytes: Uint8Array) {
  const bundle = decodeDeterministic(bytes, PUBLIC_EVIDENCE_LIMITS) as Record<string, HailValue>;
  if (bundle.type !== "hail.public-plc-resolution" || bundle.version !== 1 || !Array.isArray(bundle.witnesses))
    throw new Error("Unsupported public resolution bundle");
  const payload = encodeDeterministic(bundle.witnesses, PUBLIC_EVIDENCE_LIMITS);
  const start = Buffer.from(bytes).indexOf(payload);
  if (start < 0) throw new Error("Public evidence witness encoding differs");
  return { payload, digest: evidenceHash(payload), prefix: bytes.slice(0, start), suffix: bytes.slice(start + payload.length) };
}

export interface PublicResolutionRow {
  evidence_digest: Uint8Array;
  did: string;
  operation_cid: string;
  verified_at: Date;
  bundle_bytes: Uint8Array;
  record_version: number;
  read_evidence_policy_version: string;
}

export async function retainSharedEvidence(sql: SQL, bytes: Uint8Array) {
  const parts = splitPublicEvidence(bytes);
  await sql`INSERT INTO public_plc_shared_evidence(digest,payload_bytes) VALUES(${parts.digest},${parts.payload})
    ON CONFLICT(digest) DO NOTHING`;
  const [retained] = await sql<{payload_bytes: Uint8Array}[]>`SELECT payload_bytes FROM public_plc_shared_evidence WHERE digest=${parts.digest}`;
  if (!retained || !Buffer.from(retained.payload_bytes).equals(Buffer.from(parts.payload)))
    throw new Error("Shared public evidence conflicts with exact bytes");
  return parts;
}

// Caller owns the transaction, so a rejected observation leaves no shared orphan.
export async function storePublicResolution(sql: SQL, row: PublicResolutionRow) {
  const parts = await retainSharedEvidence(sql, row.bundle_bytes);
  await sql`INSERT INTO public_plc_resolution_evidence
    (evidence_digest,did,operation_cid,verified_at,bundle_bytes,record_version,read_evidence_policy_version,
     shared_digest,bundle_prefix,bundle_suffix)
    VALUES(${row.evidence_digest},${row.did},${row.operation_cid},${row.verified_at},NULL,${row.record_version},
      ${row.read_evidence_policy_version},${parts.digest},${parts.prefix},${parts.suffix})
    ON CONFLICT(evidence_digest) DO NOTHING`;
  const [retained] = await sql<PublicResolutionRow[]>`SELECT * FROM public_plc_resolution_contents WHERE evidence_digest=${row.evidence_digest}`;
  if (!retained || retained.did !== row.did || retained.operation_cid !== row.operation_cid ||
      retained.verified_at.getTime() !== row.verified_at.getTime() || retained.record_version !== row.record_version ||
      retained.read_evidence_policy_version !== row.read_evidence_policy_version ||
      !Buffer.from(retained.bundle_bytes).equals(Buffer.from(row.bundle_bytes)))
    throw new Error("Retained public PLC resolution conflicts");
}
