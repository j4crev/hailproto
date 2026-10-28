import type { SQL } from "bun";
import { retainSharedEvidence, splitPublicEvidence } from "./evidence-storage.js";

// Bounded, resumable representation rewrite. Each batch commits independently;
// the database guard proves exact original bytes and metadata on every update.
export async function compactPublicEvidence(sql: SQL, apply = false) {
  let cursor = new Uint8Array(), observations = 0, originalBytes = 0, observationBytes = 0, sharedBytes = 0;
  const seen = new Set<string>();
  for (;;) {
    const result = await sql.begin(async tx => {
      if (!apply) await tx`SET TRANSACTION READ ONLY`;
      await tx`SET LOCAL statement_timeout = '30s'`;
      await tx`SET LOCAL lock_timeout = '2s'`;
      const rows = await tx<{evidence_digest: Uint8Array; bundle_bytes: Uint8Array}[]>`
        SELECT evidence_digest,bundle_bytes FROM public_plc_resolution_evidence
        WHERE bundle_bytes IS NOT NULL AND evidence_digest > ${cursor} ORDER BY evidence_digest LIMIT 250`;
      for (const row of rows) {
        const parts = apply ? await retainSharedEvidence(tx as SQL, row.bundle_bytes) : splitPublicEvidence(row.bundle_bytes);
        observations++; originalBytes += row.bundle_bytes.length;
        observationBytes += parts.prefix.length + parts.suffix.length + 32;
        const key = Buffer.from(parts.digest).toString("hex");
        if (!seen.has(key)) { sharedBytes += parts.payload.length; seen.add(key); }
        if (apply) await tx`UPDATE public_plc_resolution_evidence SET bundle_bytes=NULL,
          shared_digest=${parts.digest},bundle_prefix=${parts.prefix},bundle_suffix=${parts.suffix}
          WHERE evidence_digest=${row.evidence_digest} AND bundle_bytes IS NOT NULL`;
      }
      return rows;
    });
    if (!result.length) break;
    cursor = new Uint8Array(result.at(-1)!.evidence_digest);
  }
  // Logical bytes, not physical savings: TOAST compression, rows, indexes and
  // already existing shared payloads are intentionally excluded from this estimate.
  return { applied: apply, observations, uniqueWitnessPayloads: seen.size, originalBytes, observationBytes, sharedBytes };
}
