import type {SQL} from "bun";
import type {HailEnvelopeAuthorization} from "@hailproto/codec";
import type {ConnectionFederation} from "./connection-federation.js";
import type {AccountApiSession} from "./repository.js";
import type {HailDidResolver} from "../plc/resolver.js";

export type ConnectionMessageAuthorization=Extract<HailEnvelopeAuthorization,{type:"connection"}>;
export interface ConnectionMessageTarget {connectionId:string;recipientDid:string;epoch:number;address:string;}

export async function connectionMessageAllowed(sql:SQL,owner:string,peer:string,authorization:ConnectionMessageAuthorization,lock=false){
  return (await sql<{allowed:boolean}[]>`SELECT hail_connection_message_allowed(${owner},${peer},${authorization.connection_id}::uuid,${authorization.epoch}::bigint,${lock}) AS allowed`)[0]?.allowed===true;
}

// The same permission check is used before signing/submission and final delivery.
// Remote delivery additionally asks the canonical coordinator; cached active state is insufficient.
export class ConnectionMessagingAuthority {
  constructor(private readonly sql:SQL,private readonly resolver:HailDidResolver,private readonly serviceBase:string,
    private readonly federation?:Pick<ConnectionFederation,"messageState">){}
  async targets(session:Pick<AccountApiSession,"account_id"|"did">,sql=this.sql):Promise<ConnectionMessageTarget[]>{
    const rows=await sql<{connection_id:string;recipient_did:string;epoch:number|string;address:string}[]>`
      SELECT c.id AS connection_id,a.did AS recipient_did,1::bigint AS epoch,a.canonical_address AS address
        FROM account_connections c JOIN provider_accounts a ON a.id=CASE WHEN c.account_a=${session.account_id} THEN c.account_b ELSE c.account_a END
        WHERE ${session.account_id} IN(c.account_a,c.account_b) AND hail_connection_message_allowed(${session.did},a.did,c.id,1)
      UNION ALL SELECT p.connection_id,p.peer_did,p.epoch,p.peer_address FROM federated_connection_pairs p
        WHERE p.account_id=${session.account_id} AND hail_connection_message_allowed(${session.did},p.peer_did,p.connection_id,p.epoch)
      ORDER BY address,connection_id LIMIT 201`;
    return rows.map(row=>({connectionId:row.connection_id,recipientDid:row.recipient_did,epoch:Number(row.epoch),address:row.address}));
  }
  async live(owner:string,peer:string,authorization:ConnectionMessageAuthorization){
    if(!await connectionMessageAllowed(this.sql,owner,peer,authorization))return false;
    const remote=await this.sql`SELECT id FROM federated_connection_pairs WHERE local_did=${owner} AND peer_did=${peer}
      AND connection_id=${authorization.connection_id} AND epoch=${authorization.epoch}`;
    if(remote.length){
      if(!this.federation)throw new Error("Connection coordinator verification is unavailable");
      if(!await this.federation.messageState(owner,peer,authorization.connection_id,authorization.epoch))return false;
    }else{
      const [local,other]=await Promise.all([this.resolver.resolve(owner),this.resolver.resolve(peer)]);
      if(local.did!==owner||other.did!==peer||local.serviceBase!==this.serviceBase||other.serviceBase!==this.serviceBase)
        throw new Error("Connection provider history requires migration reconciliation");
    }
    return connectionMessageAllowed(this.sql,owner,peer,authorization);
  }
}
