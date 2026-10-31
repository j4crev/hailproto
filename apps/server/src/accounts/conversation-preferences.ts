import type {SQL} from "bun";
import type {AccountApiSession} from "./repository.js";
import {ConnectionError} from "./connection-error.js";

const UUID=/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/;

// Local policy only; admission must additionally verify the exact live connection.
export async function conversationIntroductionAllowed(tx:SQL,accountId:string,connectionId:string,epoch:number){
  const rows=await tx<{allowed:boolean}[]>`SELECT COALESCE(
    (SELECT allow_introductions FROM connection_conversation_preferences WHERE account_id=${accountId} AND connection_id=${connectionId} AND epoch=${epoch}),
    (SELECT allow_introductions FROM account_conversation_preferences WHERE account_id=${accountId}),true) AS allowed`;
  return rows[0]?.allowed===true;
}

// Called inside AccountConnections' live browser-session transaction. These are
// admission preferences, not wire grants or proof of current remote consent.
export async function conversationPreferences(tx:SQL,session:AccountApiSession){
  const global=(await tx<{allow_introductions:boolean}[]>`SELECT allow_introductions FROM account_conversation_preferences
    WHERE account_id=${session.account_id}`)[0];
  const rows=await tx<{connection_id:string;epoch:string|number;peer_did:string;peer_address:string;allow_introductions:boolean|null}[]>`
    SELECT p.connection_id,p.epoch,p.peer_did,p.peer_address,c.allow_introductions
    FROM federated_connection_pairs p LEFT JOIN connection_conversation_preferences c
      ON c.account_id=p.account_id AND c.connection_id=p.connection_id AND c.epoch=p.epoch
    WHERE p.account_id=${session.account_id}
      AND hail_connection_message_allowed(${session.did},p.peer_did,p.connection_id,p.epoch)
      AND NOT hail_connection_handover_blocked(${session.did},p.peer_did)
    ORDER BY p.peer_address,p.connection_id LIMIT 201`;
  // Only an absent choice defaults on. Explicit false must survive upgrades.
  const allowIntroductions=global?.allow_introductions??true;
  return {allowIntroductions,configured:global!==undefined,truncated:rows.length>200,
    connections:rows.slice(0,200).map(row=>({connectionId:row.connection_id,epoch:Number(row.epoch),did:row.peer_did,address:row.peer_address,
      override:row.allow_introductions,effectiveAllowIntroductions:row.allow_introductions??allowIntroductions}))};
}

export async function saveConversationPreferences(tx:SQL,session:AccountApiSession,input:Record<string,unknown>){
  const keys=Object.keys(input).sort().join(",");
  if(keys==="allowIntroductions"&&typeof input.allowIntroductions==="boolean"){
    await tx`INSERT INTO account_conversation_preferences(account_id,allow_introductions)
      VALUES(${session.account_id},${input.allowIntroductions}) ON CONFLICT(account_id) DO UPDATE
      SET allow_introductions=EXCLUDED.allow_introductions,updated_at=clock_timestamp()`;
    return {saved:true};
  }
  if(keys!=="connectionId,epoch,override"||typeof input.connectionId!=="string"||!UUID.test(input.connectionId)||
    typeof input.epoch!=="number"||!Number.isSafeInteger(input.epoch)||input.epoch<1||
    (input.override!==null&&typeof input.override!=="boolean"))throw new ConnectionError(400,"Invalid conversation preference.");
  // Bind overrides to the exact lifetime. Reconnection must not resurrect an old
  // allow/deny override, and another account's connection cannot be edited.
  const pair=(await tx<{peer_did:string}[]>`SELECT peer_did FROM federated_connection_pairs
    WHERE account_id=${session.account_id} AND connection_id=${input.connectionId} AND epoch=${input.epoch}
      AND hail_connection_message_allowed(${session.did},peer_did,connection_id,epoch)
      AND NOT hail_connection_handover_blocked(${session.did},peer_did)`)[0];
  if(!pair)throw new ConnectionError(409,"This connection changed. Reload before saving its preference.");
  if(input.override===null){
    await tx`DELETE FROM connection_conversation_preferences WHERE account_id=${session.account_id}
      AND connection_id=${input.connectionId} AND epoch=${input.epoch}`;
  }else{
    await tx`INSERT INTO connection_conversation_preferences(account_id,connection_id,epoch,allow_introductions)
      VALUES(${session.account_id},${input.connectionId},${input.epoch},${input.override})
      ON CONFLICT(account_id,connection_id,epoch) DO UPDATE
      SET allow_introductions=EXCLUDED.allow_introductions,updated_at=clock_timestamp()`;
  }
  return {saved:true};
}
