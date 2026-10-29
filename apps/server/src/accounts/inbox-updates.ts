import type {SQL} from "bun";
import type {AccountApiSession} from "./repository.js";
import {UserGrantError} from "../grants/service.js";

export async function inboxUpdates(sql:SQL,session:AccountApiSession,after:string|null,from:string|null) {
  if(from!==null&&!/^did:plc:[a-z2-7]{24}$/.test(from))throw new UserGrantError(400,"Invalid sender");
  let sequence="0";
  if(after!==null){
    try {
      if(!/^[A-Za-z0-9_-]{1,1024}$/.test(after))throw new Error();
      const value=JSON.parse(Buffer.from(after,"base64url").toString("utf8"));
      if(value.version!==1||value.account!==session.account_id||value.from!==from||
        typeof value.sequence!=="string"||! /^(0|[1-9][0-9]{0,18})$/.test(value.sequence)||BigInt(value.sequence)>9223372036854775807n)throw new Error();
      sequence=value.sequence;
    }catch{throw new UserGrantError(400,"Invalid inbox wait cursor or selection");}
  }
  const rows=await sql<{message_id:string;sender_did:string;delivered_at:Date;is_read:boolean;sequence:string}[]>`
    SELECT message_id,sender_did,delivered_at,is_read,delivery_sequence::text AS sequence
    FROM delivered_messages WHERE recipient_did=${session.did} AND trashed_at IS NULL
      AND delivery_sequence>${sequence}::bigint AND (${from}::text IS NULL OR sender_did=${from})
    ORDER BY delivery_sequence LIMIT 51`;
  const page=rows.slice(0,50);
  const cursor=Buffer.from(JSON.stringify({version:1,account:session.account_id,from,sequence:page.at(-1)?.sequence??sequence})).toString("base64url");
  return {messages:page.map(row=>({messageId:row.message_id,sender:row.sender_did,deliveredAt:row.delivered_at.toISOString(),isRead:row.is_read})),cursor,hasMore:rows.length>50};
}
