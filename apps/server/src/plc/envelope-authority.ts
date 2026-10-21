import type { SQL } from "bun";
import type { EnvelopeDecision } from "../envelopes/repository.js";
import { evidenceHash } from "./read-evidence.js";
import { requireFreshPublicAuthority } from "./authority.js";

// Bind the exact accepted representation to both current decisions in the
// acceptance transaction. Archived resolutions cannot be refreshed into authority.
export async function retainPublicEnvelopeAuthority(sql: SQL, input: EnvelopeDecision, now: number): Promise<void> {
  const sender=input.evidence.verification,recipient=input.recipientEvidence?.verification;
  if(!sender&&!recipient)return;
  if(!sender||!recipient||!input.recipientServiceBase)throw new Error("Public envelope acceptance needs both sender and recipient authority evidence");
  const subjects=[{did:input.payload.from,evidence:input.evidence},{did:input.payload.to,evidence:input.recipientEvidence!}];
  for(const subject of subjects){
    const digest=await requireFreshPublicAuthority(sql,subject.evidence,{did:subject.did,
      ...(subject.did===input.payload.from?{role:"hail-messaging" as const,key:input.signingPublicKey}:{serviceBase:input.recipientServiceBase})},new Date(now*1000));
    await sql`INSERT INTO public_envelope_authority_evidence(sender_did,message_id,authority_did,recipient_did,local_account_id,
      representation_digest,evidence_digest,accepted_at)
      VALUES(${input.payload.from},${input.payload.message_id},${subject.did},${input.payload.to},${input.localAccountId},
        ${evidenceHash(input.representation)},${digest},${new Date(now*1000)})`;
  }
}
