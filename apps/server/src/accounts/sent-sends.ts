import type {SQL} from "bun";
import {UserGrantError} from "../grants/service.js";
import {bodyDocument} from "./messaging.js";
import type {AccountApiSession} from "./repository.js";

const ID=/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const kinds=["category","connections","message"];
const PAGE_SIZE=5;

// Publication identity, never body equality, defines a send. Keep the legacy
// per-envelope APIs available for delivery diagnostics and submission retries.
export async function sentSends(sql:SQL,session:AccountApiSession,after:string|null,selection?:{id:string;kind:string}) {
  const [cursorId,cursorKind,...extra]=after?.split("/")??[];
  if(after!==null&&(!cursorId||!ID.test(cursorId)||!kinds.includes(cursorKind!)||extra.length)||
    selection&&(!ID.test(selection.id)||!kinds.includes(selection.kind)))throw new UserGrantError(400,"Invalid sent message selection");
  const rows=await sql<{id:string;kind:string;category:string|null;created_at:Date;body_bytes:Uint8Array}[]>`
    WITH sends AS (
      SELECT id,'category'::text AS kind,category,created_at,body_bytes
      FROM account_publications WHERE account_id=${session.account_id} AND sender_did=${session.did} AND sealed
        AND EXISTS (SELECT 1 FROM publication_targets target JOIN sent_envelopes envelope
          ON envelope.sender_account_id=target.account_id AND envelope.message_id=target.message_id
          WHERE target.account_id=account_publications.account_id AND target.publication_id=account_publications.id)
      UNION ALL
      SELECT id,'connections',NULL::text,created_at,body_bytes
      FROM connection_message_batches WHERE account_id=${session.account_id} AND sender_did=${session.did} AND sealed
        AND EXISTS (SELECT 1 FROM connection_message_targets target JOIN sent_envelopes envelope
          ON envelope.sender_account_id=target.account_id AND envelope.message_id=target.message_id
          WHERE target.account_id=connection_message_batches.account_id AND target.publication_id=connection_message_batches.id)
      UNION ALL
      SELECT envelope.message_id,'message',NULL::text,envelope.created_at,body.body_bytes
      FROM sent_envelopes envelope JOIN detached_bodies body
        ON body.sender_account_id=envelope.sender_account_id AND body.digest=envelope.body_digest
      WHERE envelope.sender_account_id=${session.account_id} AND envelope.sender_did=${session.did}
        AND NOT EXISTS (SELECT 1 FROM publication_targets target
          WHERE target.account_id=envelope.sender_account_id AND target.message_id=envelope.message_id)
        AND NOT EXISTS (SELECT 1 FROM connection_message_targets target
          WHERE target.account_id=envelope.sender_account_id AND target.message_id=envelope.message_id)
    )
    SELECT * FROM sends
    WHERE (${cursorId??null}::uuid IS NULL OR (id,kind)<(${cursorId??null}::uuid,${cursorKind??null}::text))
      AND (${selection?.id??null}::uuid IS NULL OR (id=${selection?.id??null}::uuid AND kind=${selection?.kind??null}))
    ORDER BY id DESC,kind DESC LIMIT ${PAGE_SIZE+1}`;
  return {messages:rows.slice(0,PAGE_SIZE).map(row=>({messageId:row.id,kind:row.kind,category:row.category,
    createdAt:row.created_at.toISOString(),body:bodyDocument(row.body_bytes)})),
    next:rows.length>PAGE_SIZE?`${rows[PAGE_SIZE-1]!.id}/${rows[PAGE_SIZE-1]!.kind}`:null};
}
