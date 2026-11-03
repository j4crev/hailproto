import type {SQL} from "bun";
import {UserGrantError} from "../grants/service.js";
import {bodyDocument} from "./messaging.js";
import type {AccountApiSession} from "./repository.js";

const ID=/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const kinds=["category","connections","message"];
const PAGE_SIZE=5;

// Publication identity, never body equality, defines a send. Keep the legacy
// per-envelope APIs available for delivery diagnostics and submission retries.
export async function sentSends(sql:SQL,session:AccountApiSession,after:string|null,selection?:{id:string;kind:string},trash=false) {
  const [cursorId,cursorKind,...extra]=after?.split("/")??[];
  if(after!==null&&(!cursorId||!ID.test(cursorId)||!kinds.includes(cursorKind!)||extra.length)||
    selection&&(!ID.test(selection.id)||!kinds.includes(selection.kind)))throw new UserGrantError(400,"Invalid sent message selection");
  const rows=await sql<{id:string;kind:string;category:string|null;created_at:Date;body_bytes:Uint8Array;trashed_at:Date|null}[]>`
    SELECT item.id,item.kind,item.category,item.created_at,item.body_bytes,d.trashed_at
    FROM account_sent_items item LEFT JOIN account_sent_dispositions d
      ON d.account_id=item.account_id AND d.kind=item.kind AND d.send_id=item.id
    WHERE item.account_id=${session.account_id} AND item.sender_did=${session.did}
      AND EXISTS(SELECT 1 FROM account_sent_members m WHERE m.account_id=item.account_id AND m.kind=item.kind AND m.send_id=item.id AND m.submitted)
      AND ((${trash}=false AND d.send_id IS NULL) OR (${trash}=true AND NOT d.deleted AND d.trashed_at>clock_timestamp()-interval '30 days'))
      AND (${cursorId??null}::uuid IS NULL OR (item.id,item.kind)<(${cursorId??null}::uuid,${cursorKind??null}::text))
      AND (${selection?.id??null}::uuid IS NULL OR (item.id=${selection?.id??null}::uuid AND item.kind=${selection?.kind??null}))
    ORDER BY item.id DESC,item.kind DESC LIMIT ${PAGE_SIZE+1}`;
  const page=rows.slice(0,PAGE_SIZE);
  const connectionIds=page.filter(row=>row.kind==="connections").map(row=>row.id);
  const messageIds=page.filter(row=>row.kind==="message").map(row=>row.id);
  // One bounded summary query for the displayed page; full recipient lists remain detail-only.
  const summaries=connectionIds.length||messageIds.length ? await sql<{id:string;kind:string;count:number;address:string|null;did:string}[]>`
    WITH recipients AS (
      SELECT target.publication_id AS id, 'connections'::text AS kind, target.recipient_did
      FROM connection_message_targets target
      JOIN sent_envelopes envelope ON envelope.sender_account_id=target.account_id AND envelope.message_id=target.message_id
      WHERE target.account_id=${session.account_id} AND envelope.sender_did=${session.did}
        AND target.publication_id IN (SELECT value::uuid FROM jsonb_array_elements_text(${JSON.stringify(connectionIds)}::text::jsonb))
      UNION ALL
      SELECT message_id, 'message', recipient_did FROM sent_envelopes
      WHERE sender_account_id=${session.account_id} AND sender_did=${session.did} AND authorization_type='connection'
        AND message_id IN (SELECT value::uuid FROM jsonb_array_elements_text(${JSON.stringify(messageIds)}::text::jsonb))
    )
    SELECT recipients.id, recipients.kind, count(*)::integer AS count, min(pair.peer_address) AS address, min(recipients.recipient_did) AS did
    FROM recipients LEFT JOIN federated_connection_pairs pair
      ON pair.account_id=${session.account_id} AND pair.peer_did=recipients.recipient_did
    GROUP BY recipients.id, recipients.kind` : [];
  const summaryById=new Map(summaries.map(row=>[`${row.kind}/${row.id}`,{count:row.count,address:row.count===1?row.address:null,did:row.count===1?row.did:null}]));
  // Only the detail request needs the full recipients.
  const recipients = selection?.kind === "connections" && rows.some(row => row.id === selection.id && row.kind === "connections")
    ? await sql<{did:string;address:string|null}[]>`
      SELECT target.recipient_did AS did, pair.peer_address AS address
      FROM connection_message_targets target
      JOIN sent_envelopes envelope ON envelope.sender_account_id=target.account_id AND envelope.message_id=target.message_id
      LEFT JOIN federated_connection_pairs pair ON pair.account_id=target.account_id AND pair.peer_did=target.recipient_did
      WHERE target.account_id=${session.account_id} AND target.publication_id=${selection.id}
        AND envelope.sender_did=${session.did}
      ORDER BY target.recipient_did`
    : undefined;
  return {messages:page.map(row=>({messageId:row.id,kind:row.kind,category:row.category,
    createdAt:row.created_at.toISOString(),trashedAt:row.trashed_at?.toISOString()??null,body:bodyDocument(row.body_bytes),...(summaryById.has(`${row.kind}/${row.id}`)?{recipientSummary:summaryById.get(`${row.kind}/${row.id}`)}:{}),...(recipients ? {recipients} : {})})),
    next:rows.length>PAGE_SIZE?`${rows[PAGE_SIZE-1]!.id}/${rows[PAGE_SIZE-1]!.kind}`:null};
}
