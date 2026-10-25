import {decodeDeterministic,encodeDeterministic,type HailValue} from "@hailproto/codec";
import {ed25519PublicKeyFromDidKey} from "../identity/did-key.js";
import {canonicalizeHailServiceBase} from "../plc/resolver.js";
import type {SignedHandshake} from "./handshake.js";
import {connectionHistoryDigest,type ConnectionHistory} from "./connection-history.js";

const DID=/^did:plc:[a-z2-7]{24}$/;
const UUID=/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/;
type Row=Record<string,unknown>;
// ponytail: bounded single-request frontiers fail closed; add paged checkpoints
// if a pair's retained history outgrows the 64 KiB proposal ceiling.
export type ConnectionFrontier={
  native:{connectionId:string;epoch:1;state:"active"|"disconnected"}[];
  federated:null|{connectionId:string;epoch:number;state:"active"|"disconnected";tombstones:{connectionId:string;epoch:number}[]};
};
export interface ConnectionHandoverPlan {
  type:"hail.connection-handover-prepare";version:1;request_id:string;transfer_id:string;
  did:string;peer_did:string;source_service_base:string;destination_service_base:string;
  destination_messaging_key:string;source_generation:number;snapshot_digest:Uint8Array;connection_checkpoint_digest:Uint8Array;
  frontier:ConnectionFrontier;issued_at:number;expires_at:number;
}
export type HandoverRole="source"|"destination"|"peer-ack";
const encode=(value:unknown)=>encodeDeterministic(value as HailValue);
const same=(a:Uint8Array,b:Uint8Array)=>Buffer.from(a).equals(Buffer.from(b));
const digest=(v:unknown)=>v instanceof Uint8Array&&v.length===32;
const integer=(v:unknown,min:number)=>typeof v==="number"&&Number.isSafeInteger(v)&&v>=min;
function fields(value:unknown,keys:string[]):asserts value is Row {
  if(!value||typeof value!=="object"||Array.isArray(value)||Object.keys(value).sort().join(",")!==keys.sort().join(","))throw new Error("Invalid connection handover fields");
}
function validateFrontier(value:unknown):asserts value is ConnectionFrontier {
  fields(value,["native","federated"]);
  if(!Array.isArray(value.native)||value.native.length>1000)throw new Error("Invalid connection frontier");
  for(const row of value.native){
    fields(row,["connectionId","epoch","state"]);
    if(!UUID.test(String(row.connectionId))||row.epoch!==1||!["active","disconnected"].includes(String(row.state)))throw new Error("Invalid native connection frontier");
  }
  if(new Set(value.native.map(r=>r.connectionId)).size!==value.native.length||value.native.filter(r=>r.state==="active").length>1)throw new Error("Duplicate native connection frontier");
  if(value.federated!==null){
    fields(value.federated,["connectionId","epoch","state","tombstones"]);
    const fed=value.federated;
    if(!UUID.test(String(fed.connectionId))||!integer(fed.epoch,1)||!["active","disconnected"].includes(String(fed.state))||!Array.isArray(fed.tombstones)||fed.tombstones.length>1000)throw new Error("Invalid federated connection frontier");
    for(const row of fed.tombstones){
      fields(row,["connectionId","epoch"]);
      if(!UUID.test(String(row.connectionId))||!integer(row.epoch,0)||Number(row.epoch)>Number(fed.epoch)||fed.state==="active"&&row.connectionId===fed.connectionId)throw new Error("Invalid terminal frontier");
    }
    if(new Set(fed.tombstones.map(r=>r.connectionId)).size!==fed.tombstones.length||fed.state==="disconnected"&&!fed.tombstones.some(r=>r.connectionId===fed.connectionId))throw new Error("Incomplete terminal frontier");
  }
}
export function connectionFrontier(did:string,peer:string,native:Row[],pairs:Row[],tombstones:Row[]):ConnectionFrontier {
  const pair=pairs.find(p=>p.local_did===did&&p.peer_did===peer);
  const value:ConnectionFrontier={
    native:native.filter(r=>[r.did_a,r.did_b].includes(did)&&[r.did_a,r.did_b].includes(peer)&&["active","disconnected"].includes(String(r.state)))
      .map(r=>({connectionId:String(r.id),epoch:1 as const,state:r.state as "active"|"disconnected"})).sort((a,b)=>a.connectionId.localeCompare(b.connectionId)),
    federated:!pair||pair.state==="empty"?null:{connectionId:String(pair.connection_id),epoch:Number(pair.epoch),state:pair.state as "active"|"disconnected",
      tombstones:tombstones.filter(t=>t.pair_id===pair.id).map(t=>({connectionId:String(t.connection_id),epoch:Number(t.epoch)})).sort((a,b)=>a.connectionId.localeCompare(b.connectionId))},
  };
  validateFrontier(value);return value;
}
export function historyConnectionFrontier(history:ConnectionHistory,peer:string):ConnectionFrontier {
  return connectionFrontier(history.did,peer,history.tables.account_connections,history.tables.federated_connection_pairs,history.tables.federated_connection_tombstones);
}
export function createConnectionHandoverPlan(history:ConnectionHistory,input:{transferId:string;requestId:string;peerDid:string;
  destinationServiceBase:string;destinationMessagingKey:string;snapshotDigest:Uint8Array;issuedAt:number}):ConnectionHandoverPlan {
  const plan:ConnectionHandoverPlan={type:"hail.connection-handover-prepare",version:1,request_id:input.requestId,transfer_id:input.transferId,
    did:history.did,peer_did:input.peerDid,source_service_base:history.sourceServiceBase,destination_service_base:input.destinationServiceBase,
    destination_messaging_key:input.destinationMessagingKey,source_generation:history.sourceGeneration,snapshot_digest:input.snapshotDigest,
    connection_checkpoint_digest:connectionHistoryDigest(history),frontier:historyConnectionFrontier(history,input.peerDid),issued_at:input.issuedAt,expires_at:input.issuedAt+300};
  validatePlan(plan);return plan;
}
function validatePlan(value:unknown):asserts value is ConnectionHandoverPlan {
  fields(value,["type","version","request_id","transfer_id","did","peer_did","source_service_base","destination_service_base","destination_messaging_key",
    "source_generation","snapshot_digest","connection_checkpoint_digest","frontier","issued_at","expires_at"]);
  if(value.type!=="hail.connection-handover-prepare"||value.version!==1||!UUID.test(String(value.request_id))||!UUID.test(String(value.transfer_id))||
    !DID.test(String(value.did))||!DID.test(String(value.peer_did))||value.did===value.peer_did||!integer(value.source_generation,1)||
    !digest(value.snapshot_digest)||!digest(value.connection_checkpoint_digest)||typeof value.destination_messaging_key!=="string"||!value.destination_messaging_key.startsWith("did:key:z")||
    typeof value.source_service_base!=="string"||canonicalizeHailServiceBase(value.source_service_base)!==value.source_service_base||
    typeof value.destination_service_base!=="string"||canonicalizeHailServiceBase(value.destination_service_base)!==value.destination_service_base||value.source_service_base===value.destination_service_base||
    !integer(value.issued_at,0)||!integer(value.expires_at,0)||Number(value.expires_at)<=Number(value.issued_at)||Number(value.expires_at)-Number(value.issued_at)>300)throw new Error("Invalid connection handover plan");
  validateFrontier(value.frontier);
  if(!value.frontier.native.length&&value.frontier.federated===null)throw new Error("No retained connection exists for handover");
}
function signingInput(role:HandoverRole,payload:Uint8Array):Uint8Array<ArrayBuffer> {
  const tag=new TextEncoder().encode(`hail.connection-handover.${role}.v1\0`),bytes=new Uint8Array(tag.length+payload.length);
  bytes.set(tag);bytes.set(payload,tag.length);return bytes;
}
export async function signConnectionHandover(plan:ConnectionHandoverPlan,role:HandoverRole,key:CryptoKey):Promise<SignedHandshake> {
  validatePlan(plan);const payloadBytes=encode(plan);
  if(payloadBytes.length>65536)throw new Error("Connection handover exceeds size limit");
  return {payloadBytes,signature:new Uint8Array(await crypto.subtle.sign("Ed25519",key,signingInput(role,payloadBytes)))};
}
export async function verifyConnectionHandover(signed:SignedHandshake,role:HandoverRole,key:string,now:number):Promise<ConnectionHandoverPlan> {
  if(!signed.payloadBytes.length||signed.payloadBytes.length>65536||signed.signature.length!==64)throw new Error("Invalid connection handover representation");
  const plan=decodeDeterministic(signed.payloadBytes);validatePlan(plan);
  if(!same(encode(plan),signed.payloadBytes)||plan.issued_at>now+300||plan.expires_at<=now||
    !await crypto.subtle.verify("Ed25519",await ed25519PublicKeyFromDidKey(key),Uint8Array.from(signed.signature),signingInput(role,signed.payloadBytes)))
    throw new Error("Connection handover signature, purpose or freshness differs");
  return plan;
}
export function assertConnectionHandoverSelection(plan:ConnectionHandoverPlan,expected:{transferId:string;snapshotDigest:Uint8Array;history:ConnectionHistory;
  peerDid:string;destinationServiceBase:string;destinationMessagingKey:string}):void {
  if(plan.transfer_id!==expected.transferId||plan.did!==expected.history.did||plan.peer_did!==expected.peerDid||plan.source_service_base!==expected.history.sourceServiceBase||
    plan.destination_service_base!==expected.destinationServiceBase||plan.destination_messaging_key!==expected.destinationMessagingKey||plan.source_generation!==expected.history.sourceGeneration||
    !same(plan.snapshot_digest,expected.snapshotDigest)||!same(plan.connection_checkpoint_digest,connectionHistoryDigest(expected.history))||
    !same(encode(plan.frontier),encode(historyConnectionFrontier(expected.history,expected.peerDid))))throw new Error("Connection handover differs from the exact staged snapshot");
}
export function sameConnectionFrontier(a:ConnectionFrontier,b:ConnectionFrontier):boolean {
  // A local disconnect may tombstone at the active epoch before learning the
  // coordinator's close epoch. Compare canonical state/epoch and terminal IDs,
  // not replica-local observation epochs; the archive retains those exact rows.
  const canonical=(v:ConnectionFrontier)=>({...v,federated:v.federated?{...v.federated,tombstones:v.federated.tombstones.map(t=>t.connectionId)}:null});
  return same(encode(canonical(a)),encode(canonical(b)));
}
