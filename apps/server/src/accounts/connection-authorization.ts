import type {SQL} from "bun";
import type {HailEnvelopeAuthorization} from "@hailproto/codec";
import type {ConnectionFederation} from "./connection-federation.js";
import type {AccountApiSession} from "./repository.js";
import type {HailDidResolver} from "../plc/resolver.js";

export type ConnectionMessageAuthorization=Extract<HailEnvelopeAuthorization,{type:"connection"}>;
export interface ConnectionMessageTarget {connectionId:string;recipientDid:string;epoch:number;address:string;}

export async function connectionMessageAllowed(sql:SQL,owner:string,peer:string,authorization:ConnectionMessageAuthorization,lock=false,acceptWhilePaused=false){
  const row=(await sql<{allowed:boolean}[]>`SELECT hail_connection_message_permission(${owner},${peer},${authorization.connection_id}::uuid,${authorization.epoch}::bigint,${lock}) AS allowed`)[0];
  if(row?.allowed!==true)return false;
  // This query must follow lock acquisition, not share a SELECT whose expression
  // evaluation could observe the barrier before waiting for the account lock.
  if(!acceptWhilePaused&&(await sql<{paused:boolean}[]>`SELECT hail_connection_handover_blocked(${owner},${peer}) AS paused`)[0]?.paused)
    throw new Error('Connection authorization is paused for account handover');
  return true;
}

// The same permission check is used before signing/submission and final delivery.
// Every placement asks the canonical coordinator; cached active state is insufficient.
export class ConnectionMessagingAuthority {
  constructor(private readonly sql:SQL,private readonly resolver:HailDidResolver,private readonly serviceBase:string,
    private readonly federation?:Pick<ConnectionFederation,"messageState">){}
  async targets(session:Pick<AccountApiSession,"account_id"|"did">,sql=this.sql):Promise<ConnectionMessageTarget[]>{
    const rows=await sql<{connection_id:string;recipient_did:string;epoch:number|string;address:string}[]>`
      SELECT p.connection_id,p.peer_did AS recipient_did,p.epoch,p.peer_address AS address FROM federated_connection_pairs p
        WHERE p.account_id=${session.account_id} AND hail_connection_message_allowed(${session.did},p.peer_did,p.connection_id,p.epoch)
      ORDER BY address,connection_id LIMIT 201`;
    return rows.map(row=>({connectionId:row.connection_id,recipientDid:row.recipient_did,epoch:Number(row.epoch),address:row.address}));
  }
  async live(owner:string,peer:string,authorization:ConnectionMessageAuthorization){
    if(!await connectionMessageAllowed(this.sql,owner,peer,authorization))return false;
    if(!this.federation)throw new Error("Connection coordinator verification is unavailable");
    if(!await this.federation.messageState(owner,peer,authorization.connection_id,authorization.epoch))return false;
    return connectionMessageAllowed(this.sql,owner,peer,authorization);
  }
}
