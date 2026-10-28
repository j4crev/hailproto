import { isDeepStrictEqual } from "node:util";
import { normalizeOp, type ExportedOp } from "@did-plc/lib";

// Summarize an operation against its declared parent, including recovery branches.
// Comparing only with the last poll would misattribute intermediate changes.
export function operationDetail(entry: ExportedOp, audit: readonly ExportedOp[], currentCid: string, expectedCid: string, observedAt: Date) {
  const parent = audit.find(candidate => candidate.cid === entry.operation.prev);
  const before = parent && parent.operation.type !== "plc_tombstone" ? normalizeOp(parent.operation) : null;
  const after = entry.operation.type !== "plc_tombstone" ? normalizeOp(entry.operation) : null;
  const changes: { field: string; before: unknown; after: unknown }[] = [];
  if (before && after) {
    for (const field of ["rotationKeys", "alsoKnownAs"] as const)
      if (!isDeepStrictEqual(before[field], after[field])) changes.push({ field, before: before[field], after: after[field] });
    for (const group of ["verificationMethods", "services"] as const)
      for (const key of new Set([...Object.keys(before[group]), ...Object.keys(after[group])]))
        if (!isDeepStrictEqual(before[group][key], after[group][key]))
          changes.push({ field: `${group}.${key}`, before: before[group][key] ?? null, after: after[group][key] ?? null });
  }
  return { operationCid: entry.cid, expectedCid, currentCid, operationType: entry.operation.type,
    operationRecordedAt: entry.createdAt, observedAt: observedAt.toISOString(),
    status: entry.nullified ? "nullified" : entry.cid === currentCid ? "current" : "superseded",
    comparisonAvailable: Boolean(before && after), changes };
}
