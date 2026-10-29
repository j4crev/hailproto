import {messageThread} from "./message-threads.js";
import {sentSends} from "./sent-sends.js";
import { createHash } from "node:crypto";
import { decodePayload,encodeBase64Url,fromDiagnosticJson,inspectSignedPayload,toDiagnosticJson,type DiagnosticJson } from "@hailproto/codec";
import type { SQL } from "bun";
import { bodyFromDocument,bodyFromText,validateBodyBytes } from "../bodies/service.js";
import type { BodyRepository } from "../bodies/repository.js";
import type { EnvelopeRepository } from "../envelopes/repository.js";
import { EnvelopeAuthorizationError,type EnvelopeService } from "../envelopes/service.js";
import { UserGrantError } from "../grants/service.js";
import type { AccountApiSession } from "./repository.js";
import {connectionMessageAllowed} from "./connection-authorization.js";

import {MessageTrash} from "./message-trash.js";

const ID=/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const DID=/^did:plc:[a-z2-7]{24}$/;
const PAGE_SIZE=5;

export function messageParent(envelope:import("@hailproto/codec").HailEnvelope) {
  const parent=envelope.in_reply_to??(envelope.authorization.type==="reply"?{sender:envelope.to,message_id:envelope.authorization.reply_to}:null);
  return parent?{sender:parent.sender,messageId:parent.message_id}:null;
}

export function bodyDocument(bytes:Uint8Array) {
  const profile=validateBodyBytes(bytes);
  return profile==="spt-1"?toDiagnosticJson("hail.body.spt-1",decodePayload("hail.body.spt-1",bytes)):
    profile==="spt-2"?toDiagnosticJson("hail.body.spt-2",decodePayload("hail.body.spt-2",bytes)):
    toDiagnosticJson("hail.body.spt-3",decodePayload("hail.body.spt-3",bytes));
}

export function outboundBody(input:Record<string,unknown>):Uint8Array {
  const text=typeof input.text==="string",document=Boolean(input.body)&&typeof input.body==="object"&&!Array.isArray(input.body);
  if(text===document||text&&Buffer.byteLength(input.text as string)>65536)throw new UserGrantError(400,"Choose one bounded message body");
  if(text)return bodyFromText(input.text as string);
  const profile=(input.body as Record<string,unknown>).profile;
  if(profile!=="spt-2"&&profile!=="spt-3")throw new UserGrantError(400,"Invalid body profile");
  return profile==="spt-2"?bodyFromDocument(fromDiagnosticJson("hail.body.spt-2",input.body as DiagnosticJson)):
    bodyFromDocument(fromDiagnosticJson("hail.body.spt-3",input.body as DiagnosticJson));
}

function statusDetails(bytes:Uint8Array|null) {
  if(!bytes)return {state:"indeterminate",revision:null,reason:null,retryAt:null};
  const status=decodePayload("hail.delivery-status",bytes);
  return {state:status.state,revision:status.revision,reason:"reason" in status?status.reason:null,
    retryAt:"retry_at" in status?status.retry_at:null};
}
export class AccountMessaging {
  readonly trash:MessageTrash;
  constructor(private readonly sql:SQL,private readonly bodies:BodyRepository,private readonly envelopes:EnvelopeRepository,
    private readonly service:EnvelopeService,private readonly submitEnvelope:(sender:string,id:string)=>Promise<object>){this.trash=new MessageTrash(sql);}
  async submit(sender:string,id:string){
    try{return await this.submitEnvelope(sender,id);}catch(error){if(error instanceof EnvelopeAuthorizationError)throw new UserGrantError(409,error.message);throw error;}
  }
  private async connectionAddress(accountId:string,peer:string,id:string){
    const row=(await this.sql<{address:string}[]>`SELECT peer_address AS address FROM federated_connection_pairs WHERE account_id=${accountId} AND peer_did=${peer} LIMIT 1`)[0];
    return row?.address??null;
  }

  async send(session:Pick<AccountApiSession,"did">,input:Record<string,unknown>) {
    const hasText=typeof input.text==="string",hasBody=Boolean(input.body)&&typeof input.body==="object"&&!Array.isArray(input.body);
    if(Object.keys(input).some(k=>!["messageId","text","body","grantId","category","replyTo","replyUntil","connectionId","connectionEpoch","recipientDid","inReplyTo"].includes(k))||
      typeof input.messageId!=="string"||!ID.test(input.messageId)||hasText===hasBody||
      (hasText&&Buffer.byteLength(input.text as string)>65536)||[input.grantId,input.replyTo,input.connectionId].filter(v=>typeof v==="string").length!==1||
      (input.grantId!==undefined&&(!ID.test(input.grantId as string)||typeof input.category!=="string"))||
      (input.replyTo!==undefined&&(!ID.test(input.replyTo as string)||input.category!==undefined))||
      (input.connectionId!==undefined&&(!ID.test(input.connectionId as string)||typeof input.recipientDid!=="string"||!DID.test(input.recipientDid)||
        !Number.isSafeInteger(input.connectionEpoch)||Number(input.connectionEpoch)<1||input.category!==undefined||input.replyUntil!==undefined&&input.replyUntil!==null))||
      (input.connectionId===undefined&&(input.recipientDid!==undefined||input.connectionEpoch!==undefined))||
      (input.replyUntil!==undefined&&input.replyUntil!==null&&!Number.isSafeInteger(input.replyUntil)))throw new UserGrantError(400,"Invalid send request");
    const parent=input.inReplyTo as {sender:string;messageId:string}|undefined;
    if(parent!==undefined&&(!parent||typeof parent!=="object"||Array.isArray(parent)||
      Object.keys(parent).sort().join(",")!=="messageId,sender"||!DID.test(parent.sender)||!ID.test(parent.messageId)||
      input.grantId!==undefined||input.replyTo!==undefined&&input.replyTo!==parent.messageId||
      input.connectionId!==undefined&&input.recipientDid!==parent.sender))
      throw new UserGrantError(400,"Invalid reply source");
    const reference=parent?{sender:parent.sender,message_id:parent.messageId}:undefined;
    const body=outboundBody(input);
    const digest=new Uint8Array(createHash("sha256").update(body).digest());
    let stored=await this.envelopes.sent(session.did,input.messageId);
    if(!stored){
      await this.bodies.publish(session.did,body);
      try{await (input.connectionId?this.service.createConnection(session.did,input.recipientDid as string,input.connectionId as string,Number(input.connectionEpoch),encodeBase64Url(digest),input.messageId,reference):
        input.replyTo ? this.service.createReply(session.did,input.replyTo as string,encodeBase64Url(digest),input.replyUntil as number|null|undefined,input.messageId,reference):
        this.service.create(session.did,input.grantId as string,encodeBase64Url(digest),input.category as string,input.replyUntil as number|null|undefined,input.messageId));}
      catch(error){stored=await this.envelopes.sent(session.did,input.messageId);if(!stored){
        if(error instanceof EnvelopeAuthorizationError)throw new UserGrantError(409,error.message);throw error;}}
      stored=await this.envelopes.sent(session.did,input.messageId);
    }
    const payload=inspectSignedPayload("hail.envelope",stored!).payload;
    if(payload.in_reply_to?.sender!==reference?.sender||payload.in_reply_to?.message_id!==reference?.message_id||
      !Buffer.from(payload.body.digest.value).equals(Buffer.from(digest))||
      (input.connectionId?payload.authorization.type!=="connection"||payload.authorization.connection_id!==input.connectionId||payload.authorization.epoch!==input.connectionEpoch||payload.to!==input.recipientDid:
       input.replyTo ? payload.authorization.type!=="reply"||payload.authorization.reply_to!==input.replyTo :
        payload.authorization.type!=="grant"||payload.authorization.grant_id!==input.grantId||payload.category!==(input.category||undefined))||
      (input.replyUntil===undefined||input.replyUntil===null ? payload.reply.allowed : !payload.reply.allowed||payload.reply.until!==input.replyUntil))throw new UserGrantError(409,"Message ID has another request");
    return this.submit(session.did,input.messageId);
  }

  async setRead(session:AccountApiSession,sender:string,id:string,isRead:boolean) {
    if(!DID.test(sender)||!ID.test(id))throw new UserGrantError(400,"Invalid message identity");
    return this.sql.begin(async tx=>{
      const accounts=await tx`SELECT id FROM provider_accounts WHERE id=${session.account_id} AND did=${session.did} AND onboarding_state='active' FOR UPDATE`;
      if(!accounts.length)throw new UserGrantError(409,"Account is unavailable");
      await tx`SELECT hail_assert_unfenced_account(${session.account_id}::uuid)`;
      const rows=await tx`UPDATE delivered_messages SET is_read=${isRead}
        WHERE recipient_did=${session.did} AND sender_did=${sender} AND message_id=${id} AND trashed_at IS NULL RETURNING message_id`;
      if(!rows.length)return null;
      return {messageId:id,isRead};
    });
  }

  async inbox(session:AccountApiSession,after:string|null) {
    let cursor:{id:string;sender:string}|null=null;
    if(after){try{cursor=JSON.parse(Buffer.from(after,"base64url").toString("utf8"));}catch{throw new UserGrantError(400,"Invalid cursor");}
      if(!cursor||!ID.test(cursor.id)||!DID.test(cursor.sender))throw new UserGrantError(400,"Invalid cursor");}
    const rows=await this.sql<{message_id:string;sender_did:string;is_read:boolean;delivered_at:Date}[]>`
      SELECT is_read,message_id,sender_did,delivered_at FROM delivered_messages WHERE recipient_did=${session.did} AND trashed_at IS NULL
      AND (${after}::text IS NULL OR (message_id,sender_did)>(${cursor?.id ?? null}::uuid,${cursor?.sender ?? null}::text))
      ORDER BY message_id,sender_did LIMIT 51`;
    return {messages:rows.slice(0,50).map(row=>({isRead:row.is_read,messageId:row.message_id,sender:row.sender_did,deliveredAt:row.delivered_at.toISOString()})),
      next:rows.length>50?Buffer.from(JSON.stringify({id:rows[49]!.message_id,sender:rows[49]!.sender_did})).toString("base64url"):null};
  }

  async inboxFeed(session:AccountApiSession,after:string|null,channel:"all"|"subscriptions"|"connections"="all",trash=false) {
    let cursor:{id:string;sender:string}|null=null;
    if(after){try{cursor=JSON.parse(Buffer.from(after,"base64url").toString("utf8"));}catch{throw new UserGrantError(400,"Invalid cursor");}
      if(!cursor||!ID.test(cursor.id)||!DID.test(cursor.sender))throw new UserGrantError(400,"Invalid cursor");}
    const rows=await this.sql<{message_id:string;sender_did:string;is_read:boolean;delivered_at:Date;envelope_cose:Uint8Array;
      body_bytes:Uint8Array;sender_address:string|null;trashed_at:Date|null}[]>`
      SELECT message.is_read,message.trashed_at,message.message_id,message.sender_did,message.delivered_at,envelope.envelope_cose,body.body_bytes,
        presentation.grantee_address AS sender_address
      FROM delivered_messages message JOIN received_envelopes envelope USING(sender_did,message_id)
      JOIN verified_body_contents body ON body.recipient_did=message.recipient_did AND body.sender_did=message.sender_did
        AND body.digest=message.body_digest AND body.media_type=message.media_type AND body.profile=message.profile
      LEFT JOIN LATERAL (
        SELECT consent.grantee_address FROM grant_lineages lineage JOIN grant_consent_evidence consent USING(grant_id)
        WHERE lineage.local_account_id=${session.account_id} AND lineage.local_role='grantor'
          AND lineage.grantee_did=message.sender_did ORDER BY consent.revision DESC LIMIT 1
      ) presentation ON true
       WHERE message.recipient_did=${session.did}
         AND ((${trash}=false AND message.trashed_at IS NULL) OR (${trash}=true AND message.trashed_at>clock_timestamp()-interval '30 days'))
         AND (${channel}='all' OR (${channel}='connections')=(envelope.authorization_type='connection'))
        AND (${after}::text IS NULL OR (message.message_id,message.sender_did)<(${cursor?.id??null}::uuid,${cursor?.sender??null}::text))
      ORDER BY message.message_id DESC,message.sender_did DESC LIMIT ${PAGE_SIZE+1}`;
    return {messages:await Promise.all(rows.slice(0,PAGE_SIZE).map(async row=>{const envelope=inspectSignedPayload("hail.envelope",row.envelope_cose).payload;
      return {isRead:row.is_read,messageId:row.message_id,sender:row.sender_did,senderAddress:envelope.authorization.type==="connection"?await this.connectionAddress(session.account_id,row.sender_did,envelope.authorization.connection_id):row.sender_address,recipient:session.did,
        trashedAt:row.trashed_at?.toISOString()??null,category:envelope.category??null,inReplyTo:messageParent(envelope),kind:envelope.authorization.type==="connection"?"connection":"subscription",deliveredAt:row.delivered_at.toISOString(),body:bodyDocument(row.body_bytes)};})),
      next:rows.length>PAGE_SIZE?Buffer.from(JSON.stringify({id:rows[PAGE_SIZE-1]!.message_id,
        sender:rows[PAGE_SIZE-1]!.sender_did})).toString("base64url"):null};
  }

  sentSends(session:AccountApiSession,after:string|null,selection?:{id:string;kind:string}) {
    return sentSends(this.sql,session,after,selection);
  }

  async sent(session:AccountApiSession,after:string|null) {
    if(after!==null&&!ID.test(after))throw new UserGrantError(400,"Invalid cursor");
    const rows=await this.sql<{message_id:string;recipient_did:string;created_at:Date;current_state:string|null;current_revision:number|null}[]>`
      SELECT envelope.message_id,envelope.recipient_did,envelope.created_at,status.current_state,status.current_revision
      FROM sent_envelopes envelope LEFT JOIN sent_delivery_status status
        ON status.sender_did=envelope.sender_did AND status.message_id=envelope.message_id
      WHERE envelope.sender_did=${session.did} AND (${after}::uuid IS NULL OR envelope.message_id<${after}::uuid)
      ORDER BY envelope.message_id DESC LIMIT 51`;
    return {messages:rows.slice(0,50).map(row=>({messageId:row.message_id,recipient:row.recipient_did,
      createdAt:row.created_at.toISOString(),state:row.current_state??"indeterminate",revision:row.current_revision})),
      next:rows.length>50?rows[49]!.message_id:null};
  }

  async sentFeed(session:AccountApiSession,after:string|null) {
    if(after!==null&&!ID.test(after))throw new UserGrantError(400,"Invalid cursor");
    const rows=await this.sql<{message_id:string;recipient_did:string;created_at:Date;envelope_cose:Uint8Array;
      body_bytes:Uint8Array;payload_bytes:Uint8Array|null;recipient_address:string|null}[]>`
      SELECT envelope.message_id,envelope.recipient_did,envelope.created_at,envelope.envelope_cose,body.body_bytes,
        status.payload_bytes,presentation.grantee_address AS recipient_address
      FROM sent_envelopes envelope JOIN detached_bodies body
        ON body.sender_account_id=envelope.sender_account_id AND body.digest=envelope.body_digest
      LEFT JOIN sent_delivery_status status ON status.sender_did=envelope.sender_did AND status.message_id=envelope.message_id
      LEFT JOIN LATERAL (
        SELECT consent.grantee_address FROM grant_lineages lineage JOIN grant_consent_evidence consent USING(grant_id)
        WHERE lineage.local_account_id=${session.account_id} AND lineage.local_role='grantor'
          AND lineage.grantee_did=envelope.recipient_did ORDER BY consent.revision DESC LIMIT 1
      ) presentation ON true
      WHERE envelope.sender_did=${session.did} AND (${after}::uuid IS NULL OR envelope.message_id<${after}::uuid)
      ORDER BY envelope.message_id DESC LIMIT ${PAGE_SIZE+1}`;
    return {messages:await Promise.all(rows.slice(0,PAGE_SIZE).map(async row=>{const envelope=inspectSignedPayload("hail.envelope",row.envelope_cose).payload;
      return {messageId:row.message_id,sender:session.did,recipient:row.recipient_did,recipientAddress:envelope.authorization.type==="connection"?await this.connectionAddress(session.account_id,row.recipient_did,envelope.authorization.connection_id):row.recipient_address,
        createdAt:row.created_at.toISOString(),category:envelope.category??null,inReplyTo:messageParent(envelope),kind:envelope.authorization.type==="connection"?"connection":"subscription",...statusDetails(row.payload_bytes),body:bodyDocument(row.body_bytes)};})),
      next:rows.length>PAGE_SIZE?rows[PAGE_SIZE-1]!.message_id:null};
  }

  async sentMessage(session:AccountApiSession,id:string) {
    if(!ID.test(id))throw new UserGrantError(400,"Invalid message ID");
    const rows=await this.sql<{recipient_did:string;created_at:Date;envelope_cose:Uint8Array;body_bytes:Uint8Array;
      payload_bytes:Uint8Array|null;recipient_address:string|null}[]>`
      SELECT envelope.recipient_did,envelope.created_at,envelope.envelope_cose,body.body_bytes,
        status.payload_bytes,presentation.grantee_address AS recipient_address
      FROM sent_envelopes envelope JOIN detached_bodies body
        ON body.sender_account_id=envelope.sender_account_id AND body.digest=envelope.body_digest
      LEFT JOIN sent_delivery_status status ON status.sender_did=envelope.sender_did AND status.message_id=envelope.message_id
      LEFT JOIN LATERAL (
        SELECT consent.grantee_address FROM grant_lineages lineage JOIN grant_consent_evidence consent USING(grant_id)
        WHERE lineage.local_account_id=${session.account_id} AND lineage.local_role='grantor'
          AND lineage.grantee_did=envelope.recipient_did ORDER BY consent.revision DESC LIMIT 1
      ) presentation ON true
      WHERE envelope.sender_did=${session.did} AND envelope.message_id=${id}`;
    if(!rows[0])return null;
    const row=rows[0],envelope=inspectSignedPayload("hail.envelope",row.envelope_cose).payload;
    return {messageId:id,sender:session.did,recipient:row.recipient_did,recipientAddress:envelope.authorization.type==="connection"?await this.connectionAddress(session.account_id,row.recipient_did,envelope.authorization.connection_id):row.recipient_address,
      createdAt:row.created_at.toISOString(),category:envelope.category??null,inReplyTo:messageParent(envelope),kind:envelope.authorization.type==="connection"?"connection":"subscription",...statusDetails(row.payload_bytes),body:bodyDocument(row.body_bytes)};
  }

  async read(session:AccountApiSession,sender:string,id:string) {
    if(!DID.test(sender)||!ID.test(id))throw new UserGrantError(400,"Invalid message identity");
    const rows=await this.sql<{envelope_cose:Uint8Array;body_bytes:Uint8Array;is_read:boolean;trashed_at:Date|null;delivered_at:Date;sender_address:string|null;reply_unused:boolean}[]>`
      SELECT message.is_read,message.trashed_at,envelope.envelope_cose,body.body_bytes,message.delivered_at,presentation.grantee_address AS sender_address,
        NOT EXISTS (SELECT 1 FROM sent_envelopes reply LEFT JOIN sent_delivery_status status
          ON status.sender_did=reply.sender_did AND status.message_id=reply.message_id
          WHERE reply.sender_did=${session.did} AND reply.authorization_type='reply' AND reply.reply_to_message_id=${id} AND reply.recipient_did=${sender}
            AND COALESCE(status.current_state,'indeterminate') NOT IN ('failed','cancelled')) AS reply_unused
      FROM delivered_messages message
      JOIN received_envelopes envelope USING(sender_did,message_id)
      JOIN verified_body_contents body ON body.recipient_did=message.recipient_did AND body.sender_did=message.sender_did
        AND body.digest=message.body_digest AND body.media_type=message.media_type AND body.profile=message.profile
      LEFT JOIN LATERAL (
        SELECT consent.grantee_address FROM grant_lineages lineage JOIN grant_consent_evidence consent USING(grant_id)
        WHERE lineage.local_account_id=${session.account_id} AND lineage.local_role='grantor'
          AND lineage.grantee_did=message.sender_did ORDER BY consent.revision DESC LIMIT 1
      ) presentation ON true
      WHERE message.recipient_did=${session.did} AND (message.trashed_at IS NULL OR message.trashed_at>clock_timestamp()-interval '30 days') AND message.sender_did=${sender} AND message.message_id=${id}`;
    if(!rows[0])return null;
    const envelope=inspectSignedPayload("hail.envelope",rows[0].envelope_cose).payload;
    const connection=envelope.authorization.type==="connection"?{id:envelope.authorization.connection_id,epoch:envelope.authorization.epoch,
      active:await connectionMessageAllowed(this.sql,session.did,sender,envelope.authorization)}:null;
    return {trashedAt:rows[0].trashed_at?.toISOString()??null,isRead:rows[0].is_read,messageId:id,sender,senderAddress:envelope.authorization.type==="connection"?await this.connectionAddress(session.account_id,sender,envelope.authorization.connection_id):rows[0].sender_address,recipient:session.did,category:envelope.category ?? null,reply:envelope.reply,
      inReplyTo:messageParent(envelope),kind:connection?"connection":"subscription",connection,
      replyAvailable:rows[0].trashed_at===null&&envelope.reply.allowed&&envelope.reply.until+300>=Math.floor(Date.now()/1000)&&rows[0].reply_unused,
      deliveredAt:rows[0].delivered_at.toISOString(),body:bodyDocument(rows[0].body_bytes)};
  }

  async thread(session:AccountApiSession,sender:string,id:string) {
    if(!DID.test(sender)||!ID.test(id))throw new UserGrantError(400,"Invalid message identity");
    const root=sender===session.did?await this.sentMessage(session,id):await this.read(session,sender,id);
    if(!root||"trashedAt" in root&&root.trashedAt)return null;
    return messageThread(this.sql,session,{sender,messageId:id},sender===session.did?root.recipient:sender);
  }

  async status(session:AccountApiSession,id:string) {
    if(!ID.test(id))throw new UserGrantError(400,"Invalid message ID");
    if(!await this.envelopes.sent(session.did,id))return null;
    const rows=await this.sql<{current_state:string;current_revision:number}[]>`SELECT current_state,current_revision FROM sent_delivery_status WHERE sender_did=${session.did} AND message_id=${id}`;
    return {messageId:id,state:rows[0]?.current_state ?? "indeterminate",revision:rows[0]?.current_revision ?? null};
  }
}
