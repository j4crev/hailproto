import {inspectSignedPayload} from "@hailproto/codec";
import type {SQL} from "bun";
import type {AccountApiSession} from "./repository.js";
import {bodyDocument, messageParent} from "./messaging.js";

type Reference={sender:string;messageId:string};
type Row={sender_did:string;message_id:string;recipient_did:string;envelope_cose:Uint8Array;body_bytes:Uint8Array};
const key=(r:Reference)=>r.sender+"/"+r.messageId;

type PreviewBody={blocks?:{style?:string;children?:{text?:string}[]}[]};
export function threadBodyPreview(body:PreviewBody):string {
  const blocks=(body.blocks??[]).filter(block=>block.children?.length);
  const content=blocks[0]?.style==="h1"?blocks.slice(1):blocks;
  const text=content.map(block=>block.children!.map(span=>span.text??"").join("").replace(/\s+/g," ").trim()).find(Boolean)??"";
  const characters=Array.from(text);
  return characters.length>240?characters.slice(0,239).join("")+"…":text;
}

// Traverse only this account's visible messages with this exact peer. A shared
// publication is never a thread identity. Missing parents need not be fetched.
export async function messageThread(sql:SQL,session:AccountApiSession,root:Reference,peer:string) {
  const visited=new Map<string,Row>();
  let frontier:Reference[]=[root],truncated=false;
  for(let depth=0;frontier.length&&depth<50;depth++){
    const rows=await sql<Row[]>`
      WITH messages AS NOT MATERIALIZED (
        SELECT e.sender_did,e.message_id,e.recipient_did,e.envelope_cose,b.body_bytes,
          COALESCE(e.parent_sender,CASE WHEN e.authorization_type='reply' THEN e.recipient_did END) AS parent_sender,
          COALESCE(e.parent_message_id,e.reply_to_message_id) AS parent_id
        FROM sent_envelopes e JOIN detached_bodies b
          ON b.sender_account_id=e.sender_account_id AND b.digest=e.body_digest
        WHERE e.sender_account_id=${session.account_id} AND e.sender_did=${session.did} AND e.recipient_did=${peer}
        UNION ALL
        SELECT e.sender_did,e.message_id,e.recipient_did,e.envelope_cose,b.body_bytes,
          COALESCE(e.parent_sender,CASE WHEN e.authorization_type='reply' THEN e.recipient_did END),
          COALESCE(e.parent_message_id,e.reply_to_message_id)
        FROM received_envelopes e JOIN delivered_messages d USING(sender_did,message_id)
        JOIN verified_body_contents b ON b.recipient_did=d.recipient_did AND b.sender_did=d.sender_did
          AND b.digest=d.body_digest AND b.media_type=d.media_type AND b.profile=d.profile
        WHERE e.local_account_id=${session.account_id} AND e.recipient_did=${session.did}
          AND e.sender_did=${peer} AND d.trashed_at IS NULL
      ), frontier AS (
        SELECT value->>'sender' AS sender,(value->>'messageId')::uuid AS id
        FROM jsonb_array_elements(${JSON.stringify(frontier)}::text::jsonb)
      )
      SELECT m.sender_did,m.message_id,m.recipient_did,m.envelope_cose,m.body_bytes
      FROM messages m WHERE EXISTS (
        SELECT 1 FROM frontier f WHERE (m.sender_did=f.sender AND m.message_id=f.id)
          OR (m.parent_sender=f.sender AND m.parent_id=f.id))
        AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(${JSON.stringify([...visited.values()].map(r=>({sender:r.sender_did,messageId:r.message_id})))}::text::jsonb) v
          WHERE m.sender_did=v->>'sender' AND m.message_id=(v->>'messageId')::uuid)
      ORDER BY (m.sender_did=${root.sender} AND m.message_id=${root.messageId}::uuid) DESC,m.message_id,m.sender_did LIMIT 51
    `;
    if(rows.length>50){truncated=true;}
    const next=new Map<string,Reference>();
    for(const row of rows.slice(0,50)){
      const ref={sender:row.sender_did,messageId:row.message_id};
      if(visited.has(key(ref)))continue;
      if(visited.size===50){truncated=true;break;}
      visited.set(key(ref),row);
      next.set(key(ref),ref); // discover children
      const parent=messageParent(inspectSignedPayload("hail.envelope",row.envelope_cose).payload);
      if(parent&&!visited.has(key(parent)))next.set(key(parent),parent);
    }
    frontier=[...next.values()];
    if(truncated)break;
  }
  if(frontier.length)truncated=true;
  const messages=[...visited.values()].map(row=>{
    const envelope=inspectSignedPayload("hail.envelope",row.envelope_cose).payload;
    const body=bodyDocument(row.body_bytes) as PreviewBody;
    const parent=messageParent(envelope);
    const preview=threadBodyPreview(body);
    return {sender:row.sender_did,messageId:row.message_id,sent:row.sender_did===session.did,
      createdAt:new Date(envelope.created_at*1000).toISOString(),preview,inReplyTo:parent,
      parentAvailable:parent?visited.has(key(parent)):false};
  }).sort((a,b)=>a.createdAt.localeCompare(b.createdAt)||a.messageId.localeCompare(b.messageId)||a.sender.localeCompare(b.sender));
  return {messages,truncated};
}
