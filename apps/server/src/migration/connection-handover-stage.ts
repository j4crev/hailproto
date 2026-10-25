import type {SQL} from "bun";
import {createHash} from "node:crypto";
import {decodeBase64Url,decodeDeterministic,encodeBase64Url} from "@hailproto/codec";
import type {HailDidResolver} from "../plc/resolver.js";
import {requireFreshPublicAuthority} from "../plc/authority.js";
import {assertConnectionHandoverSelection,verifyConnectionHandover,type ConnectionHandoverPlan} from "./connection-handover.js";
import {validateTransferManifest} from "./transfer.js";
import {validateManagedTransferManifest} from "./managed-snapshot.js";
import {decodeSignedRecord} from "./wire.js";

const same=(a:Uint8Array,b:Uint8Array)=>Buffer.from(a).equals(Buffer.from(b));
export class ConnectionHandoverStage {
  constructor(private readonly sql:SQL,private readonly resolver:HailDidResolver,private readonly destinationServiceBase:string,
    private readonly now=()=>Math.floor(Date.now()/1000)){}

  async accept(input:unknown){
    if(!input||typeof input!=="object"||Array.isArray(input)||Object.keys(input).sort().join(",")!=="destinationSignature,preparation,proposal")throw new Error("Invalid handover staging fields");
    const wire=input as Record<string,unknown>,proposal=decodeSignedRecord(wire.proposal,65536),ack=decodeSignedRecord(wire.preparation,65536);
    if(typeof wire.destinationSignature!=="string")throw new Error("Destination proof is required");
    const destinationSignature=decodeBase64Url(wire.destinationSignature);
    if(destinationSignature.length!==64||encodeBase64Url(destinationSignature)!==wire.destinationSignature||!same(proposal.payloadBytes,ack.payloadBytes))throw new Error("Handover preparation bytes differ");
    const untrusted=decodeDeterministic(proposal.payloadBytes) as unknown as ConnectionHandoverPlan;
    if(!untrusted||typeof untrusted.transfer_id!=="string"||!/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/.test(untrusted.transfer_id))throw new Error("Invalid handover transfer");
    return this.sql.begin(async tx=>{
      const pending=(await tx<{state:string;custody_profile:string;did:string;manifest_bytes:Uint8Array;manifest_digest:Uint8Array;source_messaging_public_key:string}[]>`
        SELECT state,custody_profile,did,manifest_bytes,manifest_digest,source_messaging_public_key FROM pending_migration_imports WHERE transfer_id=${untrusted.transfer_id} FOR UPDATE`)[0];
      if(!pending||pending.state!=="staged")throw new Error("Handover preparation requires an inert staged import");
      const manifest=pending.custody_profile==="managed"?validateManagedTransferManifest(pending.manifest_bytes):validateTransferManifest(pending.manifest_bytes);
      if(!manifest.connections||manifest.did!==pending.did||manifest.destinationServiceBase!==this.destinationServiceBase||manifest.transferId!==untrusted.transfer_id||
        !same(new Uint8Array(createHash("sha256").update(pending.manifest_bytes).digest()),pending.manifest_digest))throw new Error("Handover snapshot differs from prepared destination");
      const source=await this.resolver.resolve(manifest.did);
      if(source.did!==manifest.did||source.serviceBase!==manifest.sourceServiceBase||source.messagingDidKey!==pending.source_messaging_public_key)throw new Error("Current source authority differs from handover preparation");
      await requireFreshPublicAuthority(tx as SQL,source.evidence,{did:source.did,role:"hail-messaging",key:source.messagingDidKey,serviceBase:source.serviceBase},new Date(this.now()*1000));
      const plan=await verifyConnectionHandover(proposal,"source",source.messagingDidKey,this.now());
      assertConnectionHandoverSelection(plan,{transferId:manifest.transferId,snapshotDigest:new Uint8Array(pending.manifest_digest),history:manifest.connections,
        peerDid:plan.peer_did,destinationServiceBase:manifest.destinationServiceBase,destinationMessagingKey:manifest.destinationMessagingPublicKey});
      await verifyConnectionHandover({...proposal,signature:destinationSignature},"destination",manifest.destinationMessagingPublicKey,this.now());
      const peer=await this.resolver.resolve(plan.peer_did);
      const historicalPair=manifest.connections.tables.federated_connection_pairs.find(p=>p.peer_did===peer.did);
      if(peer.did!==plan.peer_did||peer.serviceBase!==(historicalPair?.peer_service_base??manifest.sourceServiceBase))throw new Error("Handover peer authority differs");
      await requireFreshPublicAuthority(tx as SQL,peer.evidence,{did:peer.did,role:"hail-messaging",key:peer.messagingDidKey,serviceBase:peer.serviceBase},new Date(this.now()*1000));
      await verifyConnectionHandover(ack,"peer-ack",peer.messagingDidKey,this.now());
      const prior=(await tx<{payload_bytes:Uint8Array;source_signature:Uint8Array;destination_signature:Uint8Array;peer_signature:Uint8Array;peer_messaging_public_key:string}[]>`
        SELECT payload_bytes,source_signature,destination_signature,peer_signature,peer_messaging_public_key FROM connection_handover_preparations
        WHERE transfer_id=${plan.transfer_id} AND peer_did=${plan.peer_did} AND request_id=${plan.request_id}`)[0];
      if(prior){
        if(!same(prior.payload_bytes,proposal.payloadBytes)||!same(prior.source_signature,proposal.signature)||!same(prior.destination_signature,destinationSignature)||!same(prior.peer_signature,ack.signature)||prior.peer_messaging_public_key!==peer.messagingDidKey)
          throw new Error("Handover preparation retry changed exact evidence");
      }else await tx`INSERT INTO connection_handover_preparations(transfer_id,peer_did,request_id,snapshot_digest,payload_bytes,source_signature,
        destination_signature,peer_signature,peer_messaging_public_key,peer_authority) VALUES(${plan.transfer_id},${plan.peer_did},${plan.request_id},${pending.manifest_digest},
        ${proposal.payloadBytes},${proposal.signature},${destinationSignature},${ack.signature},${peer.messagingDidKey},${JSON.stringify(peer.evidence)}::jsonb)`;
      return {type:"hail.connection-handover-prepared",version:1,transferId:plan.transfer_id,peerDid:plan.peer_did,requestId:plan.request_id,phase:"prepared",cutoverAuthorized:false};
    });
  }
}
