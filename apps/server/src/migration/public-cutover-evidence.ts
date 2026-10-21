import { isDeepStrictEqual } from "node:util";
import { cidForCbor } from "@atproto/common";
import { def,validateOperationLog } from "@did-plc/lib";
import { decodeDeterministic, type HailValue } from "@hailproto/codec";
import type { SQL } from "bun";
import { PLC_READ_EVIDENCE_POLICY_VERSION } from "../identity/managed-profile.js";
import { verifyMonitorAttestation } from "./monitor-attestation.js";
import { PUBLIC_EVIDENCE_LIMITS, evidenceHash, encodePublicEvidence } from "../plc/read-evidence.js";
export { PUBLIC_EVIDENCE_LIMITS, evidenceHash } from "../plc/read-evidence.js";

const same = (a: Uint8Array, b: Uint8Array) => Buffer.from(a).equals(Buffer.from(b));

export function encodePublicCutoverEvidence(value: HailValue): Uint8Array {
  return encodePublicEvidence(value);
}

// This proves retained correlation/integrity, never current read authority.
// New activation must still run the live gate and its freshness checks.
export async function requirePublicCutoverEvidence(sql: SQL, expected: {
  transferId: string; did: string; manifestDigest: Uint8Array; operationBytes: Uint8Array;
  monitorPublicKey?: string | undefined; digest?: Uint8Array | undefined; activatedAt?: Date | null;
}) {
  const rows = await sql<{ evidence_digest: Uint8Array; did: string; operation_cid: string;
    manifest_digest: Uint8Array; signed_operation_bytes: Uint8Array; monitor_attestation_digest: Uint8Array;
    verified_at: Date; bundle_bytes: Uint8Array; activated_at: Date | null }[]>`
    SELECT e.*, s.activated_at FROM public_cutover_evidence e JOIN public_cutover_evidence_selection s
      USING (transfer_id, evidence_digest) WHERE s.transfer_id = ${expected.transferId} FOR UPDATE OF s`;
  const row = rows[0];
  if (!row || row.did !== expected.did || !same(row.manifest_digest, expected.manifestDigest) ||
    !same(row.signed_operation_bytes, expected.operationBytes) || !same(evidenceHash(row.bundle_bytes), row.evidence_digest) ||
    expected.digest && !same(row.evidence_digest, expected.digest) ||
    expected.activatedAt !== undefined && row.activated_at?.getTime() !== expected.activatedAt?.getTime()) {
    throw new Error("Full public cutover evidence is absent, changed or selected for another activation");
  }
  const bundle = decodeDeterministic(row.bundle_bytes, PUBLIC_EVIDENCE_LIMITS) as Record<string, HailValue>;
  const monitor = bundle.monitor as Record<string, HailValue>,bootstrap=bundle.bootstrap as Record<string,HailValue>,
    canonical=bundle.canonical_readback as Record<string,HailValue>,
    witnesses=bundle.witnesses as Record<string,HailValue>[];
  if (bundle.type !== "hail.public-cutover-evidence" || bundle.version !== 1 || bundle.policy !== PLC_READ_EVIDENCE_POLICY_VERSION ||
    bundle.transfer_id !== expected.transferId || bundle.did !== expected.did || bundle.operation_cid !== row.operation_cid ||
    bundle.verified_at !== row.verified_at.toISOString() || !(bundle.manifest_digest instanceof Uint8Array) ||
    !same(bundle.manifest_digest, expected.manifestDigest) || !(bundle.signed_operation_bytes instanceof Uint8Array) ||
    !same(bundle.signed_operation_bytes, expected.operationBytes) || !monitor || typeof monitor.public_key !== "string" ||
    expected.monitorPublicKey !== undefined && monitor.public_key !== expected.monitorPublicKey ||
    !(monitor.payload instanceof Uint8Array) || !(monitor.signature instanceof Uint8Array) ||canonical?.origin!=="https://plc.directory"||
    !Array.isArray(canonical.log)||!Array.isArray(witnesses)||witnesses.length!==1||
    !same(evidenceHash(monitor.payload), row.monitor_attestation_digest)) throw new Error("Retained public evidence bundle correlation is invalid");
  const canonicalLog=canonical.log.map(operation=>def.compatibleOpOrTombstone.parse(operation));
  const canonicalState=def.documentData.parse(canonical.state),replayed=await validateOperationLog(expected.did,canonicalLog),
    canonicalCids=await Promise.all(canonicalLog.map(operation=>cidForCbor(operation).then(cid=>cid.toString())));
  if(!replayed)throw new Error("Retained canonical PLC readback log is invalid");
  if(canonicalCids.at(-1)!==row.operation_cid)throw new Error("Retained canonical PLC readback head is invalid");
  if(typeof bootstrap?.operation_cid!=="string"||!canonicalCids.includes(bootstrap.operation_cid))
    throw new Error("Retained canonical PLC readback omits the bootstrap");
  if(!isDeepStrictEqual(replayed,canonicalState))throw new Error("Retained canonical PLC readback state is invalid");
  if(!isDeepStrictEqual(canonicalState,def.documentData.parse(witnesses[0]!.state)))
    throw new Error("Retained canonical PLC readback disagrees with its witness");
  const report = await verifyMonitorAttestation({ payloadBytes: monitor.payload, signature: monitor.signature },
    monitor.public_key as string, Math.floor(row.verified_at.getTime() / 1000), 300);
  if (report.version !== 2 || report.did !== expected.did || report.transfer_id !== expected.transferId ||
    report.operation_cid !== row.operation_cid) throw new Error("Retained public monitor evidence belongs to another cutover");
  return row;
}
