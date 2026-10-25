import {createHash,randomUUID} from "node:crypto";
import {createWebCryptoSigner,encodeBase64Url,encodeDeterministic,signPayload,type HailValue} from "@hailproto/codec";
import {base58btc} from "multiformats/bases/base58";
import {expect,it} from "vitest";
import {uuidV7} from "../src/identity/uuid-v7.js";
import {CONNECTION_HISTORY_COLUMNS,connectionHistoryDigest,validateConnectionHistory,type ConnectionHistory} from "../src/migration/connection-history.js";
import {validateSnapshotConnections,requireConnectionHandoverComplete} from "../src/migration/connection-snapshot.js";
import {assertConnectionHandoverSelection,createConnectionHandoverPlan,signConnectionHandover,verifyConnectionHandover} from "../src/migration/connection-handover.js";

const did="did:plc:"+"a".repeat(24),peer="did:plc:"+"b".repeat(24),accountId=randomUUID();
const owner={accountId,did,sourceGeneration:1,sourceServiceBase:"https://source.example/hail"};
const hash=(v:Uint8Array)=>new Uint8Array(createHash("sha256").update(v).digest());
const hex=(v:Uint8Array)=>"\\x"+Buffer.from(v).toString("hex");
const encode=(v:unknown)=>new TextEncoder().encode(JSON.stringify(v));
const row=(table:keyof ConnectionHistory["tables"],values:Record<string,unknown>)=>({
  ...Object.fromEntries(CONNECTION_HISTORY_COLUMNS[table].split(" ").map(k=>[k,null])),...values,
});
function empty():ConnectionHistory {
  return {type:"hail.connection-history",version:1,...owner,capturedAt:"2026-10-25T00:00:00.000Z",sharePolicy:"invalidate-at-cutover",
    tables:Object.fromEntries(Object.keys(CONNECTION_HISTORY_COLUMNS).map(t=>[t,[] as Record<string,unknown>[]])) as ConnectionHistory["tables"]};
}
async function native(){
  const h=empty(),keys=await crypto.subtle.generateKey("Ed25519",true,["sign","verify"]),invitationId=uuidV7(),connectionId=uuidV7();
  const sign=(from:string)=>createWebCryptoSigner(from+"#hail-identity",keys.privateKey);
  const invitation=await signPayload("hail.connection-invitation",{type:"hail.connection-invitation",version:1,from:did,key_id:did+"#hail-identity",
    invitation_id:invitationId,token_hash:{algorithm:"sha-256",value:hash(new Uint8Array(32))},issued_at:1,expires_at:null},sign(did));
  const confirmation=await signPayload("hail.connection-confirmation",{type:"hail.connection-confirmation",version:1,from:peer,to:did,key_id:peer+"#hail-identity",
    confirmation_id:uuidV7(),invitation_id:invitationId,invitation_hash:{algorithm:"sha-256",value:hash(invitation)},issued_at:2,expires_at:300},sign(peer));
  h.tables.connection_invitations.push(row("connection_invitations",{id:invitationId,account_id:accountId,did,serving_generation:1,cose:hex(invitation),
    token_hash:hex(hash(new Uint8Array(32))),signing_evidence:{},personal:true}));
  h.tables.account_connections.push(row("account_connections",{id:connectionId,account_a:accountId,account_b:randomUUID(),did_a:did,did_b:peer,
    generation_a:1,generation_b:1,state:"active",consent_format:"joint-v1",invitation_cose:hex(invitation),confirmation_cose:hex(confirmation),evidence_a:{},evidence_b:{}}));
  return {h,invitation,confirmation,sign};
}

it("round trips native signed bytes and revoked invitation history without share secrets",async()=>{
  const {h,invitation}=await native();h.tables.connection_invitations[0]!.revoked_at=h.capturedAt;
  const restored=validateConnectionHistory(encode(h),owner);
  expect(restored.tables.account_connections[0]!.invitation_cose).toBe(hex(invitation));
  expect(restored.tables.connection_invitations[0]!.revoked_at).toBe(h.capturedAt);
  expect(connectionHistoryDigest(restored)).toEqual(connectionHistoryDigest(h));
  const changed=structuredClone(h);changed.tables.account_connections[0]!.ended_at=h.capturedAt;
  expect(connectionHistoryDigest(changed)).not.toEqual(connectionHistoryDigest(h));
  for(const secret of ["ciphertext","nonce","token","session_id","challenge","credential_id"]){
    const bad=structuredClone(h);bad.tables.connection_invitations[0]![secret]="secret";
    expect(()=>validateConnectionHistory(encode(bad),owner)).toThrow("unexpected fields");
  }
  expect(()=>validateConnectionHistory(encode(h),{...owner,accountId:randomUUID()})).toThrow("ownership");
  expect(()=>validateConnectionHistory(encode(h),{...owner,sourceGeneration:2})).toThrow("ownership");
  const other=structuredClone(h);other.tables.connection_invitations[0]!.account_id=randomUUID();
  expect(()=>validateConnectionHistory(encode(other),owner)).toThrow("another account");
});

it("rejects consent substitution and incomplete disconnect history",async()=>{
  const {h,invitation,confirmation,sign}=await native(),bad=structuredClone(h);
  bad.tables.account_connections[0]!.did_b="did:plc:"+"c".repeat(24);
  expect(()=>validateConnectionHistory(encode(bad),owner)).toThrow("consent linkage");
  h.tables.account_connections[0]!.state="disconnected";
  expect(()=>validateConnectionHistory(encode(h),owner)).toThrow("disconnect history");
  h.tables.account_connections[0]!.ended_at=h.capturedAt;h.tables.account_connections[0]!.ended_by=accountId;
  expect(validateConnectionHistory(encode(h),owner).tables.account_connections[0]!.state).toBe("disconnected");
  const c=h.tables.account_connections[0]!;c.consent_format="grants-v1";
  for(const side of ["a","b"]){
    const from=side==="a"?did:peer,to=side==="a"?peer:did,grantId=uuidV7();c["grant_id_"+side]=grantId;
    c["grant_"+side+"_cose"]=hex(await signPayload("hail.connection-grant",{type:"hail.connection-grant",version:1,
      grant_id:grantId,connection_id:c.id as string,revision:1,previous:null,grantor:from,grantee:to,status:"active",
      issued_at:2,updated_at:2,expires_at:null,key_id:from+"#hail-identity",consent_context:{grantee_address:"peer@peer.example.com",
        address_binding_hash:{algorithm:"sha-256",value:new Uint8Array(32)},invitation_hash:{algorithm:"sha-256",value:hash(invitation)},
        confirmation_hash:{algorithm:"sha-256",value:hash(confirmation)}}},sign(from)));
  }
  expect(validateConnectionHistory(encode(h),owner).tables.account_connections[0]!.consent_format).toBe("grants-v1");
  c.grant_id_a=uuidV7();expect(()=>validateConnectionHistory(encode(h),owner)).toThrow("Grant linkage");
});

it("keeps terminal federated epochs, rejects reopening and unfinished network work",()=>{
  const h=empty(),pairId=randomUUID(),connectionId=randomUUID();
  h.tables.federated_connection_pairs.push(row("federated_connection_pairs",{id:pairId,account_id:accountId,serving_generation:1,local_did:did,peer_did:peer,
    peer_service_base:"https://peer.example/hail",coordinator_service_base:owner.sourceServiceBase,epoch:"2",state:"disconnected",connection_id:connectionId}));
  h.tables.federated_connection_tombstones.push(row("federated_connection_tombstones",{account_id:accountId,pair_id:pairId,connection_id:connectionId,epoch:"2"}));
  h.tables.federated_connection_events.push(row("federated_connection_events",{id:randomUUID(),account_id:accountId,pair_id:pairId,connection_id:connectionId,epoch:"2",state:"disconnected"}));
  expect(validateConnectionHistory(encode(h),owner).tables.federated_connection_pairs[0]!.epoch).toBe("2");
  const reopened=structuredClone(h);reopened.tables.federated_connection_pairs[0]!.state="active";
  reopened.tables.federated_connection_events[0]!.state="active";
  expect(()=>validateConnectionHistory(encode(reopened),owner)).toThrow("terminal history");
  const missingEvent=structuredClone(h);missingEvent.tables.federated_connection_events=[];
  expect(()=>validateConnectionHistory(encode(missingEvent),owner)).toThrow("lost current coordinator event");
  const lost=structuredClone(h);lost.tables.federated_connection_tombstones=[];
  expect(()=>validateConnectionHistory(encode(lost),owner)).toThrow("lost terminal tombstone");
  h.tables.federated_connection_disconnects.push(row("federated_connection_disconnects",{id:randomUUID(),account_id:accountId,pair_id:pairId,connection_id:connectionId,epoch:1}));
  expect(()=>validateConnectionHistory(encode(h),owner)).toThrow("unfinished disconnect");
});

it("preserves private message audience and terminal outcome without retargeting",()=>{
  const h=empty(),id=randomUUID(),connectionId=randomUUID(),body=encode({version:1,profile:"spt-1",blocks:[{type:"paragraph",text:"private"}]}),
    audience=[{connectionId,recipientDid:peer,epoch:1,address:"peer@peer.example"}];
  h.tables.connection_message_batches.push(row("connection_message_batches",{id,account_id:accountId,sender_did:did,serving_generation:1,sealed:true,
    body_bytes:hex(body),manifest:hex(encodeDeterministic(audience as unknown as HailValue)),request_digest:hex(hash(encodeDeterministic({connections:[connectionId],body})))}));
  h.tables.connection_message_targets.push(row("connection_message_targets",{account_id:accountId,publication_id:id,connection_id:connectionId,connection_epoch:1,
    recipient_did:peer,message_id:randomUUID(),state:"cancelled"}));
  expect(validateConnectionHistory(encode(h),owner).tables.connection_message_targets[0]!.state).toBe("cancelled");
  const changed=structuredClone(h);changed.tables.connection_message_targets[0]!.connection_epoch=3;
  expect(()=>validateConnectionHistory(encode(changed),owner)).toThrow("audience or body");
  h.tables.connection_message_targets[0]!.state="pending";
  expect(()=>validateConnectionHistory(encode(h),owner)).toThrow("unfinished or orphaned");
});

it("retains referenced historical authority bundles, rejecting missing or altered evidence",async()=>{
  const {h}=await native(),bundle=encodeDeterministic({type:"hail.public-plc-resolution",version:1}),digest=hash(bundle);
  h.tables.connection_invitations[0]!.signing_evidence={verification:{digest:Buffer.from(digest).toString("base64url")}};
  expect(()=>validateConnectionHistory(encode(h),owner)).toThrow("lost historical public authority");
  h.tables.public_plc_resolution_evidence.push(row("public_plc_resolution_evidence",{evidence_digest:hex(digest),bundle_bytes:hex(bundle),did}));
  expect(validateConnectionHistory(encode(h),owner).tables.public_plc_resolution_evidence).toHaveLength(1);
  h.tables.public_plc_resolution_evidence[0]!.bundle_bytes="\\x01";
  expect(()=>validateConnectionHistory(encode(h),owner)).toThrow("authority evidence digest");
});

it("binds the connection checkpoint to the new snapshot domain without enabling cutover",async()=>{
  const {h}=await native(),snapshot={version:5,...owner,capturedAt:h.capturedAt,connections:h,connectionCheckpointDigest:encodeBase64Url(connectionHistoryDigest(h)),
    tables:{sent_envelopes:[],received_envelopes:[]}};
  expect(()=>validateSnapshotConnections(snapshot)).not.toThrow();
  expect(()=>requireConnectionHandoverComplete(snapshot)).toThrow('staged only');
  expect(()=>validateSnapshotConnections({...snapshot,version:3})).toThrow('Legacy snapshot');
  const {connections:_history,...withoutHistory}=snapshot;
  expect(()=>validateSnapshotConnections(withoutHistory)).toThrow('missing');
  expect(()=>validateSnapshotConnections({...snapshot,connectionCheckpointDigest:encodeBase64Url(new Uint8Array(32))})).toThrow('checkpoint differs');
  expect(()=>validateSnapshotConnections({...snapshot,capturedAt:'2026-10-26T00:00:00.000Z'})).toThrow('checkpoint differs');
  expect(()=>requireConnectionHandoverComplete({connections:empty()})).not.toThrow();
});

it("requires separate source, destination and peer signature purposes on the exact handover",async()=>{
  const {h}=await native(),keys=await crypto.subtle.generateKey('Ed25519',true,['sign','verify']),raw=new Uint8Array(34);
  raw.set([0xed,1]);raw.set(new Uint8Array(await crypto.subtle.exportKey('raw',keys.publicKey)),2);
  const publicKey='did:key:'+base58btc.encode(raw),selection={transferId:randomUUID(),peerDid:peer,destinationServiceBase:'https://destination.example/hail',
    destinationMessagingKey:publicKey,snapshotDigest:new Uint8Array(32),history:h};
  const plan=createConnectionHandoverPlan(h,{...selection,requestId:uuidV7(),issuedAt:100});
  for(const role of ['source','destination','peer-ack'] as const){
    const signed=await signConnectionHandover(plan,role,keys.privateKey);
    expect(await verifyConnectionHandover(signed,role,publicKey,101)).toEqual(plan);
    await expect(verifyConnectionHandover(signed,role==='source'?'destination':'source',publicKey,101)).rejects.toThrow('purpose');
    await expect(verifyConnectionHandover(signed,role,publicKey,400)).rejects.toThrow('freshness');
    signed.signature[0]!^=1;
    await expect(verifyConnectionHandover(signed,role,publicKey,101)).rejects.toThrow('signature');
  }
  expect(()=>assertConnectionHandoverSelection(plan,selection)).not.toThrow();
  expect(()=>assertConnectionHandoverSelection({...plan,transfer_id:randomUUID()},selection)).toThrow('exact staged snapshot');
  expect(()=>assertConnectionHandoverSelection({...plan,snapshot_digest:hash(new Uint8Array([1]))},selection)).toThrow('exact staged snapshot');
  expect(()=>assertConnectionHandoverSelection({...plan,destination_messaging_key:'did:key:zOther'},selection)).toThrow('exact staged snapshot');
  const changed=structuredClone(plan);changed.frontier.native[0]!.state='disconnected';
  expect(()=>assertConnectionHandoverSelection(changed,selection)).toThrow('exact staged snapshot');
});
