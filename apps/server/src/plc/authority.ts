import { decodeBase64Url,decodeDeterministic,type HailValue } from "@hailproto/codec";
import type { SQL } from "bun";
import { PUBLIC_EVIDENCE_LIMITS,evidenceHash } from "./read-evidence.js";
import { canonicalizeHailServiceBase,type PlcResolutionEvidence } from "./resolver.js";

export function assertPublicAuthorityFresh(evidence:PlcResolutionEvidence,now:Date):void {
  const ref=evidence.verification;if(!ref)return;
  const instant=Date.parse(ref.verifiedAt);
  if(ref.profile!=="strict-public-v1"||!Number.isFinite(instant)||Math.abs(now.getTime()-instant)>30_000)throw new Error("Public authority evidence is stale or invalid");
}

export async function requireFreshPublicAuthority(sql:SQL,evidence:PlcResolutionEvidence,expected:{did:string;role?:"hail-identity"|"hail-messaging";key?:string;serviceBase?:string},now:Date):Promise<Uint8Array|undefined>{
  const ref=evidence.verification;if(!ref)return;
  assertPublicAuthorityFresh(evidence,now);
  const digest=decodeBase64Url(ref.digest,32);
  const row=(await sql<{did:string;operation_cid:string;verified_at:Date;bundle_bytes:Uint8Array}[]>`
    SELECT did,operation_cid,verified_at,bundle_bytes FROM public_plc_resolution_evidence WHERE evidence_digest=${digest}`)[0];
  if(!row||row.did!==expected.did||row.operation_cid!==ref.operationCid||row.verified_at.toISOString()!==ref.verifiedAt||
    !Buffer.from(evidenceHash(row.bundle_bytes)).equals(Buffer.from(digest)))throw new Error("Public authority evidence is missing or mismatched");
  const bundle=decodeDeterministic(row.bundle_bytes,PUBLIC_EVIDENCE_LIMITS) as Record<string,HailValue>,witnesses=bundle.witnesses as Record<string,any>[];
  if(bundle.type!=="hail.public-plc-resolution"||bundle.version!==1||bundle.policy!=="strict-public-v1"||bundle.did!==expected.did||
    bundle.operation_cid!==ref.operationCid||bundle.verified_at!==ref.verifiedAt||!Array.isArray(witnesses)||witnesses.length<1||witnesses.length>2||
    witnesses.some(witness=>expected.role&&witness.state.verificationMethods[expected.role]!==expected.key||
      expected.serviceBase&&canonicalizeHailServiceBase(witness.state.services.hail.endpoint)!==expected.serviceBase))throw new Error("Public authority decision does not match retained roles/service");
  return digest;
}
