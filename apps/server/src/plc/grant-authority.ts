import type { SQL } from "bun";
import type { GrantConsentEvidence,SignedGrantRevisionInput } from "../grants/store.js";
import { requireFreshPublicAuthority } from "./authority.js";
import type { PlcResolutionEvidence } from "./resolver.js";

export async function retainPublicGrantAuthority(sql:SQL,revision:SignedGrantRevisionInput,consent?:GrantConsentEvidence):Promise<void>{
  const checks:{purpose:string;evidence:PlcResolutionEvidence|undefined;did:string;role?:"hail-identity"|"hail-messaging";key?:string;serviceBase?:string}[]=[
    {purpose:"signer",evidence:revision.signingPlcEvidence,did:revision.payload.grantor,role:"hail-identity",key:revision.signingPublicKey,
      ...(revision.expectedServiceBase?{serviceBase:revision.expectedServiceBase}:{})}];
  if(revision.localRole==="grantee")checks.push({purpose:"recipient",evidence:revision.recipientEvidence,did:revision.payload.grantee,
    ...(revision.recipientServiceBase?{serviceBase:revision.recipientServiceBase}:{})});
  if(consent)checks.push(
    {purpose:"consent-binding",evidence:consent.address.plcEvidence,did:revision.payload.grantee,role:"hail-identity",key:consent.address.identityDidKey,serviceBase:consent.address.serviceBase},
    {purpose:"consent-profile",evidence:consent.senderProfile.plcEvidence,did:revision.payload.grantee,role:"hail-messaging",key:consent.senderProfile.messagingDidKey,serviceBase:consent.senderProfile.serviceBase});
  if(!checks.some(check=>check.evidence?.verification?.profile==="strict-public-v1"))return;
  if(checks.some(check=>check.evidence?.verification?.profile!=="strict-public-v1")||revision.localRole==="grantee"&&!revision.recipientServiceBase)throw new Error("Public Grant commit requires complete unmixed authority evidence");
  const now=(await sql<{instant:Date}[]>`SELECT clock_timestamp() AS instant`)[0]!.instant;
  for(const check of checks){
    const digest=await requireFreshPublicAuthority(sql,check.evidence!,check,now);
    await sql`INSERT INTO public_grant_authority_evidence(grant_id,revision,local_account_id,local_role,purpose,authority_did,representation_digest,evidence_digest,committed_at)
      VALUES(${revision.payload.grant_id},${revision.payload.revision},${revision.localAccountId},${revision.localRole},${check.purpose},${check.did},${revision.digest},${digest!},${now})`;
  }
}
