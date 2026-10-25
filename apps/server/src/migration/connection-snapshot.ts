import {encodeBase64Url,inspectSignedPayload} from "@hailproto/codec";
import {connectionHistoryDigest,validateConnectionHistory,type ConnectionHistory} from "./connection-history.js";

type Row=Record<string,unknown>;
export interface ConnectionSnapshot {
  version:number;accountId:string;did:string;sourceServiceBase:string;capturedAt:string;sourceGeneration?:number;
  connections?:ConnectionHistory;connectionCheckpointDigest?:string;
  tables:{sent_envelopes:Row[];received_envelopes:Row[]};
}
export function validateSnapshotConnections(manifest:ConnectionSnapshot):void {
  const extended=manifest.version===5||manifest.version===6;
  if(!extended){
    if(Object.hasOwn(manifest,"connections")||Object.hasOwn(manifest,"connectionCheckpointDigest"))throw new Error("Legacy snapshot cannot carry connection history");
  }else{
    if(!manifest.connections||typeof manifest.sourceGeneration!=="number"||!Number.isSafeInteger(manifest.sourceGeneration)||manifest.sourceGeneration<1)throw new Error("Snapshot connection history or generation is missing");
    const history=validateConnectionHistory(new TextEncoder().encode(JSON.stringify(manifest.connections)),{
      accountId:manifest.accountId,did:manifest.did,sourceGeneration:manifest.sourceGeneration,sourceServiceBase:manifest.sourceServiceBase,
    });
    if(history.capturedAt!==manifest.capturedAt||encodeBase64Url(connectionHistoryDigest(history))!==manifest.connectionCheckpointDigest)
      throw new Error("Snapshot connection checkpoint differs from retained history");
  }
  const sent=new Map(manifest.tables.sent_envelopes.map(r=>[r.message_id,r]));
  for(const row of [...manifest.tables.sent_envelopes,...manifest.tables.received_envelopes]){
    if(typeof row.envelope_cose!=="string"||!/^\\x(?:[0-9a-f]{2})+$/i.test(row.envelope_cose))throw new Error("Snapshot envelope bytes are invalid");
    const payload=inspectSignedPayload("hail.envelope",new Uint8Array(Buffer.from(row.envelope_cose.slice(2),"hex"))).payload;
    if(payload.authorization.type!=="connection")continue;
    if(!extended)throw new Error("Connection envelopes require a connection-history snapshot version");
    if(row.authorization_type!=="connection"||row.connection_id!==payload.authorization.connection_id||Number(row.connection_epoch)!==payload.authorization.epoch)
      throw new Error("Snapshot envelope connection metadata differs from signed authorization");
  }
  for(const target of manifest.connections?.tables.connection_message_targets??[]){
    const envelope=sent.get(target.message_id);
    if(target.state==="submitted"&&!envelope||envelope&&(envelope.recipient_did!==target.recipient_did||envelope.connection_id!==target.connection_id||Number(envelope.connection_epoch)!==Number(target.connection_epoch)))
      throw new Error("Snapshot connection target lost its exact submitted envelope");
  }
}

// Until live projections, source code invalidation and peer/coordinator commit are
// implemented, even a correctly staged archive must not trigger a PLC write.
export function requireConnectionHandoverComplete(manifest:Pick<ConnectionSnapshot,"connections">):void {
  if(connectionHandoverPending(manifest))
    throw new Error("Connection history is staged only; authenticated handover commit is required before cutover");
}
export function connectionHandoverPending(manifest:Pick<ConnectionSnapshot,"connections">):boolean {
  return !!manifest.connections&&Object.values(manifest.connections.tables).some(rows=>rows.length);
}
