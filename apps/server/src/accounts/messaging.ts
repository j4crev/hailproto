import { createHash } from "node:crypto";
import { decodePayload,encodeBase64Url,inspectSignedPayload,toDiagnosticJson } from "@hailproto/codec";
import type { SQL } from "bun";
import { bodyFromText } from "../bodies/service.js";
import type { BodyRepository } from "../bodies/repository.js";
import type { EnvelopeRepository } from "../envelopes/repository.js";
import type { EnvelopeService } from "../envelopes/service.js";
import { UserGrantError } from "../grants/service.js";
import type { AccountApiSession } from "./repository.js";

const ID=/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const DID=/^did:plc:[a-z2-7]{24}$/;
export class AccountMessaging {
  constructor(private readonly sql:SQL,private readonly bodies:BodyRepository,private readonly envelopes:EnvelopeRepository,
    private readonly service:EnvelopeService,readonly submit:(sender:string,id:string)=>Promise<object>){}

  async send(session:AccountApiSession,input:Record<string,unknown>) {
    if(Object.keys(input).some(k=>!["messageId","text","grantId","category","replyTo","replyUntil"].includes(k))||
      typeof input.messageId!=="string"||!ID.test(input.messageId)||typeof input.text!=="string"||
      Buffer.byteLength(input.text)>65536||((typeof input.grantId==="string") === (typeof input.replyTo==="string"))||
      (input.grantId!==undefined&&(!ID.test(input.grantId as string)||typeof input.category!=="string"))||
      (input.replyTo!==undefined&&(!ID.test(input.replyTo as string)||input.category!==undefined))||
      (input.replyUntil!==undefined&&input.replyUntil!==null&&!Number.isSafeInteger(input.replyUntil)))throw new UserGrantError(400,"Invalid send request");
    const body=bodyFromText(input.text);
    const digest=new Uint8Array(createHash("sha256").update(body).digest());
    let stored=await this.envelopes.sent(session.did,input.messageId);
    if(!stored){
      await this.bodies.publish(session.did,body);
      try{await (input.replyTo ? this.service.createReply(session.did,input.replyTo as string,encodeBase64Url(digest),input.replyUntil as number|null|undefined,input.messageId):
        this.service.create(session.did,input.grantId as string,encodeBase64Url(digest),input.category as string,input.replyUntil as number|null|undefined,input.messageId));}
      catch(error){stored=await this.envelopes.sent(session.did,input.messageId);if(!stored)throw error;}
      stored=await this.envelopes.sent(session.did,input.messageId);
    }
    const payload=inspectSignedPayload("hail.envelope",stored!).payload;
    if(!Buffer.from(payload.body.digest.value).equals(Buffer.from(digest))||
      (input.replyTo ? payload.authorization.type!=="reply"||payload.authorization.reply_to!==input.replyTo :
        payload.authorization.type!=="grant"||payload.authorization.grant_id!==input.grantId||payload.category!==(input.category||undefined))||
      (input.replyUntil===undefined||input.replyUntil===null ? payload.reply.allowed : !payload.reply.allowed||payload.reply.until!==input.replyUntil))throw new UserGrantError(409,"Message ID has another request");
    return this.submit(session.did,input.messageId);
  }

  async inbox(session:AccountApiSession,after:string|null) {
    let cursor:{id:string;sender:string}|null=null;
    if(after){try{cursor=JSON.parse(Buffer.from(after,"base64url").toString("utf8"));}catch{throw new UserGrantError(400,"Invalid cursor");}
      if(!cursor||!ID.test(cursor.id)||!DID.test(cursor.sender))throw new UserGrantError(400,"Invalid cursor");}
    const rows=await this.sql<{message_id:string;sender_did:string;delivered_at:Date}[]>`
      SELECT message_id,sender_did,delivered_at FROM delivered_messages WHERE recipient_did=${session.did}
      AND (${after}::text IS NULL OR (message_id,sender_did)>(${cursor?.id ?? null}::uuid,${cursor?.sender ?? null}::text))
      ORDER BY message_id,sender_did LIMIT 51`;
    return {messages:rows.slice(0,50).map(row=>({messageId:row.message_id,sender:row.sender_did,deliveredAt:row.delivered_at.toISOString()})),
      next:rows.length>50?Buffer.from(JSON.stringify({id:rows[49]!.message_id,sender:rows[49]!.sender_did})).toString("base64url"):null};
  }

  async read(session:AccountApiSession,sender:string,id:string) {
    if(!DID.test(sender)||!ID.test(id))throw new UserGrantError(400,"Invalid message identity");
    const rows=await this.sql<{envelope_cose:Uint8Array;body_bytes:Uint8Array;delivered_at:Date}[]>`
      SELECT envelope.envelope_cose,body.body_bytes,message.delivered_at FROM delivered_messages message
      JOIN received_envelopes envelope USING(sender_did,message_id)
      JOIN verified_body_provenance body ON body.recipient_did=message.recipient_did AND body.sender_did=message.sender_did
        AND body.digest=message.body_digest AND body.media_type=message.media_type AND body.profile=message.profile
      WHERE message.recipient_did=${session.did} AND message.sender_did=${sender} AND message.message_id=${id}`;
    if(!rows[0])return null;
    const envelope=inspectSignedPayload("hail.envelope",rows[0].envelope_cose).payload;
    return {messageId:id,sender,recipient:session.did,category:envelope.category ?? null,reply:envelope.reply,
      deliveredAt:rows[0].delivered_at.toISOString(),body:toDiagnosticJson("hail.body.spt-1",decodePayload("hail.body.spt-1",rows[0].body_bytes))};
  }

  async status(session:AccountApiSession,id:string) {
    if(!ID.test(id))throw new UserGrantError(400,"Invalid message ID");
    if(!await this.envelopes.sent(session.did,id))return null;
    const rows=await this.sql<{current_state:string;current_revision:number}[]>`SELECT current_state,current_revision FROM sent_delivery_status WHERE sender_did=${session.did} AND message_id=${id}`;
    return {messageId:id,state:rows[0]?.current_state ?? "indeterminate",revision:rows[0]?.current_revision ?? null};
  }
}
