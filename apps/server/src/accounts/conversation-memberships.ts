import {createHash} from "node:crypto";
import {createWebCryptoVerifier,verifySignedPayload,validateConversationRevivalBinding,type VerifiedHailObject,type HailConversation,type HailConversationRevival} from "@hailproto/codec";
import type {SQL} from "bun";
import {ed25519PublicKeyFromDidKey} from "../identity/did-key.js";
import type {PlcResolutionEvidence} from "../plc/resolver.js";
import type {AccountApiSession} from "./repository.js";
import {ConnectionError} from "./connection-error.js";
import {connectionMessageAllowed,type ConnectionMessageAuthorization} from "./connection-authorization.js";
import {conversationIntroductionAllowed} from "./conversation-preferences.js";

export interface ConversationIdentity {creator:string;conversationId:string;}
type Owner=Pick<AccountApiSession,"account_id"|"did">;
const hash=(bytes:Uint8Array)=>new Uint8Array(createHash("sha256").update(bytes).digest());
const same=(a:Uint8Array,b:Uint8Array)=>Buffer.from(a).equals(Buffer.from(b));
const idPattern=/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export function conversationIdentity(input:Record<string,unknown>):ConversationIdentity {
  if(typeof input.creator!=="string"||!/^did:plc:[a-z2-7]{24}$/.test(input.creator)||typeof input.conversationId!=="string"||!idPattern.test(input.conversationId))
    throw new ConnectionError(400,"Invalid conversation identity.");
  return {creator:input.creator,conversationId:input.conversationId};
}
async function clock(tx:SQL){return new Date((await tx<{now:Date}[]>`SELECT clock_timestamp() AS now`)[0]!.now);}

// Call admission only with a signature verified against fresh creator authority
// and an independently checked current coordinator snapshot. This function owns
// the final local policy/connection check under the account disconnect barrier.
export async function admitConversation(tx:SQL,owner:Owner,descriptor:VerifiedHailObject<HailConversation>,
  proof:{signingKey:string;evidence:PlcResolutionEvidence;connection?:ConnectionMessageAuthorization}){
  const d=descriptor.payload,identity={creator:d.from,conversationId:d.conversation_id};
  if(descriptor.type!=="hail.conversation"||!d.participants.includes(owner.did))return false;
  if(owner.did!==d.from){
    if(!proof.connection||!await connectionMessageAllowed(tx,owner.did,d.from,proof.connection,true)||
      !await conversationIntroductionAllowed(tx,owner.account_id,proof.connection.connection_id,proof.connection.epoch))return false;
  }
  await lockOwner(tx,owner);
  const digest=hash(descriptor.representationBytes);
  const previous=(await tx<{descriptor_hash:Uint8Array}[]>`SELECT descriptor_hash FROM conversation_descriptors
    WHERE creator_did=${d.from} AND conversation_id=${d.conversation_id}`)[0];
  if(previous&&!same(previous.descriptor_hash,digest))throw new ConnectionError(409,"Conversation descriptor conflicts with its original roster.");
  const now=await clock(tx);
  if(d.created_at>now.getTime()/1000+300||d.admission_until+300<now.getTime()/1000)return false;
  if(!previous){
    await tx`INSERT INTO conversation_descriptors(creator_did,conversation_id,descriptor_hash,descriptor_cose,participants,created_at,admission_until,signing_key,signing_evidence)
      VALUES(${d.from},${d.conversation_id},${digest},${descriptor.representationBytes},${tx.array(d.participants)},${new Date(d.created_at*1000)},${new Date(d.admission_until*1000)},${proof.signingKey},${JSON.stringify(proof.evidence)}::jsonb)
      ON CONFLICT(creator_did,conversation_id) DO NOTHING`;
    const winner=(await tx<{descriptor_hash:Uint8Array}[]>`SELECT descriptor_hash FROM conversation_descriptors WHERE creator_did=${d.from} AND conversation_id=${d.conversation_id}`)[0]!;
    if(!same(winner.descriptor_hash,digest))throw new ConnectionError(409,"Conversation descriptor conflict.");
  }
  await tx`INSERT INTO conversation_memberships(account_id,creator_did,conversation_id,state)
    VALUES(${owner.account_id},${d.from},${d.conversation_id},'active') ON CONFLICT DO NOTHING`;
  return (await conversationState(tx,owner,identity))?.state==="active";
}

export async function lockOwner(tx:SQL,owner:Owner){
  if(!(await tx`SELECT id FROM provider_accounts WHERE id=${owner.account_id} AND did=${owner.did}
    AND onboarding_state='active' AND activation_verification_mode='public' AND closed_at IS NULL FOR UPDATE`).length)
    throw new ConnectionError(409,"Current account is unavailable.");
  await tx`SELECT hail_assert_unfenced_account(${owner.account_id}::uuid)`;
}

export async function conversationState(tx:SQL,owner:Owner,identity:ConversationIdentity){
  const row=(await tx<{state:string;expires_at:Date;participants:string[];descriptor_hash:Uint8Array;can_revive:boolean}[]>`
    SELECT CASE WHEN m.state='left' THEN 'left' WHEN m.expires_at<=clock_timestamp() THEN 'expired' ELSE 'active' END AS state,
      m.expires_at,d.participants,d.descriptor_hash,m.creator_did=${owner.did} AS can_revive
    FROM conversation_memberships m JOIN conversation_descriptors d USING(creator_did,conversation_id)
    WHERE m.account_id=${owner.account_id} AND m.creator_did=${identity.creator} AND m.conversation_id=${identity.conversationId}`)[0];
  return row?{...identity,state:row.state as "active"|"expired"|"left",expiresAt:row.expires_at.toISOString(),participants:row.participants,
    canRevive:row.can_revive,descriptorHash:row.descriptor_hash}:null;
}

export async function conversationMessageAllowed(tx:SQL,ownerDid:string,senderDid:string,identity:ConversationIdentity,descriptorHash:Uint8Array,lock=false){
  const owner=(await tx<{id:string}[]>`SELECT id FROM provider_accounts WHERE did=${ownerDid} AND onboarding_state='active'
    AND activation_verification_mode='public' AND closed_at IS NULL`)[0];
  if(!owner||ownerDid===senderDid)return false;
  if(lock)await lockOwner(tx,{account_id:owner.id,did:ownerDid});
  const rows=await tx`SELECT 1 FROM conversation_memberships m JOIN conversation_descriptors d USING(creator_did,conversation_id)
    WHERE m.account_id=${owner.id} AND m.creator_did=${identity.creator} AND m.conversation_id=${identity.conversationId}
      AND d.descriptor_hash=${descriptorHash} AND ${senderDid}=ANY(d.participants) AND ${ownerDid}=ANY(d.participants)
      AND m.state='active' AND m.expires_at>clock_timestamp()
      AND NOT EXISTS(SELECT 1 FROM provider_migration_fences WHERE account_id=${owner.id})`;
  return rows.length>0;
}

export async function changeConversationMembership(tx:SQL,owner:Owner,identity:ConversationIdentity,action:"open"|"leave"|"rejoin"|"revive"){
  await lockOwner(tx,owner);
  const current=await conversationState(tx,owner,identity);
  if(!current)throw new ConnectionError(404,"Conversation unavailable.");
  if(action==="rejoin"&&current.state!=="left")throw new ConnectionError(409,"Only a conversation you left can be rejoined. Expired participation requires creator revival.");
  if(action==="revive"&&(owner.did!==identity.creator||current.state!=="expired"))throw new ConnectionError(403,"Only the creator can revive expired participation.");
  if(action==="leave")await tx`UPDATE conversation_memberships SET state='left',left_at=COALESCE(left_at,clock_timestamp())
    WHERE account_id=${owner.account_id} AND creator_did=${identity.creator} AND conversation_id=${identity.conversationId}`;
  else if(action==="rejoin"||action==="revive"||current.state==="active"){
    // Opening expired history cannot renew permission. Explicit rejoin can;
    // ordinary incoming delivery and bulk mark-read never call this method.
    await tx`UPDATE conversation_memberships SET state='active',left_at=NULL,last_activity_at=clock_timestamp(),expires_at=clock_timestamp()+interval '24 months'
      WHERE account_id=${owner.account_id} AND creator_did=${identity.creator} AND conversation_id=${identity.conversationId}
        AND (${action} IN ('rejoin','revive') OR last_activity_at IS NULL OR last_activity_at<clock_timestamp()-interval '1 hour')`;
  }
  return conversationState(tx,owner,identity);
}

export async function reviveConversation(tx:SQL,owner:Owner,request:VerifiedHailObject<HailConversationRevival>,connection:ConnectionMessageAuthorization){
  const r=request.payload,identity={creator:r.from,conversationId:r.conversation_id};
  if(request.type!=="hail.conversation-revival"||r.to!==owner.did)throw new ConnectionError(403);
  // Acquire pair locks in canonical account order before the local grant lock.
  const connected=await connectionMessageAllowed(tx,owner.did,r.from,connection,true);
  await lockOwner(tx,owner);
  const d=(await tx<{descriptor_cose:Uint8Array;signing_key:string}[]>`SELECT d.descriptor_cose,d.signing_key
    FROM conversation_descriptors d JOIN conversation_memberships m USING(creator_did,conversation_id)
    WHERE m.account_id=${owner.account_id} AND d.creator_did=${r.from} AND d.conversation_id=${r.conversation_id}`)[0];
  if(!d)throw new ConnectionError(404,"Unknown conversation cannot be revived.");
  const verified=await verifySignedPayload("hail.conversation",new Uint8Array(d.descriptor_cose),createWebCryptoVerifier(async()=>ed25519PublicKeyFromDidKey(d.signing_key)));
  validateConversationRevivalBinding(verified,request);
  const digest=hash(request.representationBytes);
  const prior=(await tx<{request_hash:Uint8Array;outcome:string}[]>`SELECT request_hash,outcome FROM conversation_revival_receipts
    WHERE account_id=${owner.account_id} AND creator_did=${r.from} AND request_id=${r.request_id}`)[0];
  if(prior){if(!same(prior.request_hash,digest))throw new ConnectionError(409,"Revival request ID conflict.");return {outcome:prior.outcome};}
  const now=(await clock(tx)).getTime()/1000;
  if(r.issued_at>now+300||r.expires_at+300<now)throw new ConnectionError(410,"Revival request expired or is not yet valid.");
  const state=(await conversationState(tx,owner,identity))!;
  const permitted=connected&&await conversationIntroductionAllowed(tx,owner.account_id,connection.connection_id,connection.epoch);
  const outcome=state.state==="left"?"left":state.state==="active"?"active":permitted?"renewed":"denied";
  if(outcome==="renewed")await tx`UPDATE conversation_memberships SET expires_at=clock_timestamp()+interval '24 months',last_activity_at=NULL
    WHERE account_id=${owner.account_id} AND creator_did=${r.from} AND conversation_id=${r.conversation_id}`;
  await tx`INSERT INTO conversation_revival_receipts(account_id,creator_did,conversation_id,request_id,request_hash,expires_at,outcome)
    VALUES(${owner.account_id},${r.from},${r.conversation_id},${r.request_id},${digest},${new Date((r.expires_at+300)*1000)},${outcome})`;
  return {outcome};
}

// Replay receipts are useful only through the signed request window (including
// clock tolerance). Never prune permission while saved envelopes/outbox reference
// it: those compact rows make old readable conversations explicitly revivable.
export async function pruneConversationState(sql:SQL){
  const owners=await sql<{account_id:string;did:string}[]>`SELECT DISTINCT m.account_id,a.did FROM conversation_memberships m
    JOIN provider_accounts a ON a.id=m.account_id WHERE a.onboarding_state='active' AND a.closed_at IS NULL
      AND NOT EXISTS(SELECT 1 FROM provider_migration_fences f WHERE f.account_id=a.id)
      AND (EXISTS(SELECT 1 FROM conversation_revival_receipts r WHERE r.account_id=m.account_id AND r.expires_at<clock_timestamp()) OR
        ((m.expires_at<clock_timestamp() OR m.state='left')
          AND EXISTS(SELECT 1 FROM conversation_descriptors d WHERE d.creator_did=m.creator_did AND d.conversation_id=m.conversation_id AND d.admission_until<clock_timestamp()-interval '5 minutes')
          AND NOT EXISTS(SELECT 1 FROM conversation_revival_receipts r WHERE r.account_id=m.account_id AND r.creator_did=m.creator_did AND r.conversation_id=m.conversation_id)
          AND NOT EXISTS(SELECT 1 FROM conversation_revival_batches b WHERE b.account_id=m.account_id AND b.creator_did=m.creator_did AND b.conversation_id=m.conversation_id)
          AND NOT EXISTS(SELECT 1 FROM sent_envelopes e WHERE e.sender_account_id=m.account_id AND e.conversation_creator=m.creator_did AND e.conversation_id=m.conversation_id)
          AND NOT EXISTS(SELECT 1 FROM received_envelopes e WHERE e.local_account_id=m.account_id AND e.conversation_creator=m.creator_did AND e.conversation_id=m.conversation_id)
          AND NOT EXISTS(SELECT 1 FROM connection_message_batches b WHERE b.account_id=m.account_id AND b.conversation_context IS NOT NULL))) LIMIT 20`;
  for(const owner of owners)await sql.begin(async tx=>{
    await lockOwner(tx,owner);
    await tx`DELETE FROM conversation_revival_receipts WHERE (account_id,creator_did,request_id) IN(
      SELECT account_id,creator_did,request_id FROM conversation_revival_receipts WHERE account_id=${owner.account_id} AND expires_at<clock_timestamp() LIMIT 500)`;
    await tx`DELETE FROM conversation_memberships m USING conversation_descriptors d
      WHERE m.account_id=${owner.account_id} AND m.creator_did=d.creator_did AND m.conversation_id=d.conversation_id
        AND (m.state='left' OR m.expires_at<clock_timestamp()) AND d.admission_until<clock_timestamp()-interval '5 minutes'
        AND NOT EXISTS(SELECT 1 FROM conversation_revival_receipts r WHERE r.account_id=m.account_id AND r.creator_did=m.creator_did AND r.conversation_id=m.conversation_id)
        AND NOT EXISTS(SELECT 1 FROM conversation_revival_batches b WHERE b.account_id=m.account_id AND b.creator_did=m.creator_did AND b.conversation_id=m.conversation_id)
        AND NOT EXISTS(SELECT 1 FROM sent_envelopes e WHERE e.sender_account_id=m.account_id AND e.conversation_creator=m.creator_did AND e.conversation_id=m.conversation_id)
        AND NOT EXISTS(SELECT 1 FROM received_envelopes e WHERE e.local_account_id=m.account_id AND e.conversation_creator=m.creator_did AND e.conversation_id=m.conversation_id)
        AND NOT EXISTS(SELECT 1 FROM connection_message_batches b WHERE b.account_id=m.account_id AND b.conversation_context IS NOT NULL)`;
  });
  await sql`DELETE FROM conversation_descriptors d WHERE (d.creator_did,d.conversation_id) IN(
    SELECT creator_did,conversation_id FROM conversation_descriptors c WHERE c.admission_until<clock_timestamp()-interval '5 minutes'
      AND NOT EXISTS(SELECT 1 FROM conversation_memberships m WHERE m.creator_did=c.creator_did AND m.conversation_id=c.conversation_id)
      AND NOT EXISTS(SELECT 1 FROM sent_envelopes e WHERE e.conversation_creator=c.creator_did AND e.conversation_id=c.conversation_id)
      AND NOT EXISTS(SELECT 1 FROM received_envelopes e WHERE e.conversation_creator=c.creator_did AND e.conversation_id=c.conversation_id) LIMIT 100)`;
}
