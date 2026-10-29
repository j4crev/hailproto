import type {SQL} from "bun";
import type {AccountApiSession} from "./repository.js";
import type {AccountMessaging} from "./messaging.js";
import {UserGrantError} from "../grants/service.js";
const DID=/^did:plc:[a-z2-7]{24}$/;

export async function conversations(sql:SQL,session:AccountApiSession,messaging:AccountMessaging,peer:string|null,action:string,after:string|null,trash:boolean) {
  if(peer!==null&&!DID.test(peer))throw new UserGrantError(400,"Invalid peer");
  if(action!=="list"&&action!=="show"){
    if(!peer||!["mark-read","mark-unread","trash","restore"].includes(action))throw new UserGrantError(400,"Invalid conversation action");
    return sql.begin(async tx=>{
      await tx`SELECT id FROM provider_accounts WHERE id=${session.account_id} FOR UPDATE`;
      await tx`SELECT hail_assert_unfenced_account(${session.account_id}::uuid)`;
      if(action==="trash"){
        const settings=await tx<{trash_enabled:boolean}[]>`SELECT trash_enabled FROM account_message_preferences WHERE account_id=${session.account_id}`;
        if(settings[0]?.trash_enabled===false)throw new UserGrantError(409,"Trash is disabled; conversation was not deleted");
      }
      const rows=action==="trash"?await tx`UPDATE delivered_messages SET trashed_at=COALESCE(trashed_at,clock_timestamp()) WHERE recipient_did=${session.did} AND sender_did=${peer} RETURNING message_id`:
        action==="restore"?await tx`UPDATE delivered_messages SET trashed_at=NULL WHERE recipient_did=${session.did} AND sender_did=${peer} AND trashed_at>clock_timestamp()-interval '30 days' RETURNING message_id`:
        await tx`UPDATE delivered_messages SET is_read=${action==="mark-read"} WHERE recipient_did=${session.did} AND sender_did=${peer} AND trashed_at IS NULL RETURNING message_id`;
      return {peer,action,affected:rows.length};
    });
  }
  if(action==="list"){
    if(after!==null&&!DID.test(after))throw new UserGrantError(400,"Invalid conversation cursor");
    const rows=await sql<{peer:string;unread:number;last_activity:Date}[]>`
      WITH messages AS (
        SELECT sender_did AS peer,delivered_at AS at,(NOT is_read)::integer AS unread FROM delivered_messages
        WHERE recipient_did=${session.did} AND ((${trash}=false AND trashed_at IS NULL) OR (${trash}=true AND trashed_at>clock_timestamp()-interval '30 days'))
        UNION ALL SELECT recipient_did,created_at,0 FROM sent_envelopes WHERE sender_account_id=${session.account_id} AND ${trash}=false
      ) SELECT peer,sum(unread)::integer AS unread,max(at) AS last_activity FROM messages
      WHERE (${after}::text IS NULL OR peer>${after}) GROUP BY peer ORDER BY peer LIMIT 51`;
    return {conversations:rows.slice(0,50).map(r=>({peer:r.peer,unread:r.unread,lastActivity:r.last_activity.toISOString()})),next:rows.length>50?rows[49]!.peer:null};
  }
  let cursor:{id:string;sender:string}|null=null;
  if(after){try{cursor=JSON.parse(Buffer.from(after,"base64url").toString());if(!cursor||!DID.test(cursor.sender)||! /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(cursor.id))throw new Error();}catch{throw new UserGrantError(400,"Invalid conversation cursor");}}
  const rows=await sql<{sender:string;id:string}[]>`
    WITH messages AS (
      SELECT sender_did AS sender,message_id AS id FROM delivered_messages WHERE recipient_did=${session.did} AND sender_did=${peer} AND trashed_at IS NULL
      UNION SELECT sender_did,message_id FROM sent_envelopes WHERE sender_account_id=${session.account_id} AND recipient_did=${peer}
    ) SELECT sender,id FROM messages WHERE (${after}::text IS NULL OR (id,sender)<(${cursor?.id??null}::uuid,${cursor?.sender??null}::text)) ORDER BY id DESC,sender DESC LIMIT 6`;
  return {peer,messages:await Promise.all(rows.slice(0,5).map(r=>r.sender===session.did?messaging.sentMessage(session,r.id):messaging.read(session,r.sender,r.id))),
    next:rows.length>5?Buffer.from(JSON.stringify(rows[4])).toString("base64url"):null,contentTrust:"untrusted"};
}
