// Explicit fixture maintenance only. Public fixed keys; NEVER use with real accounts.
import {createPrivateKey,createPublicKey,createHash} from 'node:crypto';
import {writeFile} from 'node:fs/promises';
import {base58btc} from 'multiformats/bases/base58';
import {P256Keypair} from '@atproto/crypto';
import {encodeDeterministic,decodeDeterministic,encodeBase64Url,type HailValue} from '@hailproto/codec';
import {signHandshake} from '../src/migration/handshake.js';
import {encodeManagedHandshake,managedHandshakeSignatureInput,signManagedProviderHandshake} from '../src/migration/managed-handshake.js';
import {signPortableMigrationConsent} from '../src/migration/consent.js';
import {signActivationReceipt} from '../src/migration/activation-receipt.js';
import {signConnectionHandover,signConnectionHandoverAbort,signConnectionHandoverTransition,signConnectionHandoverResult,connectionActivationDigest} from '../src/migration/connection-handover.js';
import {connectionCancellationInput} from '../src/migration/connection-cancellation.js';
import {encodeSignedRecord} from '../src/migration/wire.js';
const hash=(v:Uint8Array)=>new Uint8Array(createHash('sha256').update(v).digest());
const hex=(v:Uint8Array)=>Buffer.from(v).toString('hex');
const cb=(v:any)=>encodeDeterministic(v as HailValue);
const did='did:plc:'+'a'.repeat(24),peer='did:plc:'+'b'.repeat(24),id=(n:number)=>'01954144-8097-7a9d-a7a8-'+n.toString(16).padStart(12,'0');
const now=1793443200,source='https://source.example.com/hail',destination='https://target.example.com/hail';
async function ed(n:number){
  const seed=Buffer.alloc(32,n),der=Buffer.concat([Buffer.from('302e020100300506032b657004220420','hex'),seed]);
  const node=createPrivateKey({key:der,type:'pkcs8',format:'der'}),raw=createPublicKey(node).export({type:'spki',format:'der'}).subarray(-32);
  return {privateKey:await crypto.subtle.importKey('pkcs8',der,'Ed25519',false,['sign']),algorithm:'Ed25519',publicKeyHex:raw.toString('hex'),
    didKey:'did:key:'+base58btc.encode(new Uint8Array([0xed,1,...raw]))};
}
const identity=await ed(1),sender=await ed(2),target=await ed(3),targetIdentity=await ed(4),other=await ed(5);
const recovery=await P256Keypair.import(new Uint8Array(32).fill(6)),rotation=await P256Keypair.import(new Uint8Array(32).fill(7));
const owner={algorithm:'ES256',publicKeyHex:hex(recovery.publicKeyBytes()),didKey:recovery.did()};
const records:any[]=[];
function diagnostic(value:any):any{return value instanceof Uint8Array?{$bytes:hex(value)}:Array.isArray(value)?value.map(diagnostic):value&&typeof value==='object'?Object.fromEntries(Object.entries(value).map(([k,v])=>[k,diagnostic(v)])):value;}
function record(name:string,value:any,signed:any,key:any,role?:string,domain?:string){
  const prefix=domain??(role?'hail.connection-handover.'+role+'.v1':value.type+'.v1');
  const input=Buffer.concat([Buffer.from(prefix+'\0'),signed.payloadBytes]);
  records.push({id:name,type:value.type,role:role??null,algorithm:key.algorithm,publicKeyHex:key.publicKeyHex,didKey:key.didKey,
    diagnostic:diagnostic(value),payloadHex:hex(signed.payloadBytes),payloadDigestHex:hex(hash(signed.payloadBytes)),
    signingInputHex:hex(input),signatureHex:hex(signed.signature),wire:encodeSignedRecord(signed)});
  return signed;
}
const common={version:1,did,nonce:id(1),source_service_base:source,destination_service_base:destination,issued_at:now,expires_at:now+3600};
async function portable(name:string,value:any,key:any){return record(name,value,await signHandshake(value,key.privateKey),key);}
const grant=await portable('portable-grant',{...common,type:'hail.transfer-grant',destination_domain:'target.example.com'},identity);
const invitation=await portable('portable-invitation',{type:'hail.transfer-invitation',version:1,did,nonce:id(1),source_service_base:source,destination_service_base:destination,
  grant_digest:hash(grant.payloadBytes),challenge:new Uint8Array(32).fill(8),expires_at:now+3600},sender);
const offerValue={...common,type:'hail.transfer-offer',transfer_id:id(2),grant_digest:hash(grant.payloadBytes),invitation_digest:hash(invitation.payloadBytes),
  invitation_challenge:new Uint8Array(32).fill(8),destination_rotation_key:rotation.did(),destination_messaging_key:target.didKey};
const offer=await portable('portable-offer',offerValue,target);
const selectionValue={type:'hail.transfer-address-selection',version:1,did,nonce:id(1),transfer_id:id(2),grant_digest:hash(grant.payloadBytes),offer_digest:hash(offer.payloadBytes),address:'alice@target.example.com',selection_nonce:id(3),issued_at:now,expires_at:now+3600};
const selection=await portable('portable-selection',selectionValue,identity);
const reservationValue={type:'hail.transfer-reservation',version:1,did,nonce:id(1),transfer_id:id(2),offer_digest:hash(offer.payloadBytes),selection_digest:hash(selection.payloadBytes),address:selectionValue.address,issued_at:now,expires_at:now+3600};
const reservation=await portable('portable-reservation',reservationValue,target);
await portable('portable-request',{...offerValue,type:'hail.transfer-request',offer_digest:hash(offer.payloadBytes),destination_address:selectionValue.address,selection_digest:hash(selection.payloadBytes),reservation_digest:hash(reservation.payloadBytes)},target);
await portable('portable-cancellation',{type:'hail.transfer-cancellation',version:1,did,nonce:id(1),grant_digest:hash(grant.payloadBytes),issued_at:now,expires_at:now+3600},identity);
await portable('portable-cancellation-receipt',{type:'hail.transfer-cancellation-receipt',version:1,did,nonce:id(1),grant_digest:hash(grant.payloadBytes),invitation_digest:hash(invitation.payloadBytes),destination_domain:'target.example.com',source_service_base:source,issued_at:now,expires_at:now+86400},sender);
async function managed(name:string,value:any,key:any){
  const payloadBytes=encodeManagedHandshake(value);
  const signed=key===owner?{payloadBytes,signature:await recovery.sign(managedHandshakeSignatureInput(value.type,payloadBytes))}:await signManagedProviderHandshake(value,key.privateKey);
  return record(name,value,signed,key);
}
const mg=await managed('managed-grant',{...common,type:'hail.managed-transfer-grant',destination_domain:'target.example.com',owner_recovery_key:owner.didKey,source_identity_key:identity.didKey},owner);
const ack=await managed('managed-acknowledgement',{...common,type:'hail.managed-transfer-acknowledgement',grant_digest:hash(mg.payloadBytes),source_messaging_key:sender.didKey},sender);
const moValue={...common,type:'hail.managed-transfer-offer',transfer_id:id(2),grant_digest:hash(mg.payloadBytes),acknowledgement_digest:hash(ack.payloadBytes),destination_rotation_key:rotation.did(),destination_identity_key:targetIdentity.didKey,destination_messaging_key:target.didKey};
const mo=await managed('managed-offer',moValue,target);
const msValue={...selectionValue,type:'hail.managed-transfer-address-selection',grant_digest:hash(mg.payloadBytes),offer_digest:hash(mo.payloadBytes)};
const ms=await managed('managed-selection',msValue,owner);
const mrValue={...reservationValue,type:'hail.managed-transfer-reservation',offer_digest:hash(mo.payloadBytes),selection_digest:hash(ms.payloadBytes),destination_rotation_key:rotation.did(),destination_identity_key:targetIdentity.didKey,destination_messaging_key:target.didKey};
const mr=await managed('managed-reservation',mrValue,target);
const mf={...moValue,type:'hail.managed-transfer-fence-request',destination_address:msValue.address,owner_recovery_key:owner.didKey,source_identity_key:identity.didKey,
  offer_digest:hash(mo.payloadBytes),selection_digest:hash(ms.payloadBytes),reservation_digest:hash(mr.payloadBytes)};
await managed('managed-fence',mf,target);
const {acknowledgement_digest:unused,reservation_digest:unused2,...ma}=mf;
await managed('managed-approval',{...ma,type:'hail.managed-transfer-approval',snapshot_version:8,snapshot_digest:hash(cb({fixture:'snapshot'})),history_checkpoint_digest:hash(cb({fixture:'history'})),source_generation:1,previous_operation_cid:'bafy-previous-fixture',operation_cid:'bafy-cutover-fixture'},owner);
const consent:any={type:'hail.portable-migration-consent',version:1,did,transfer_id:id(2),snapshot_digest:hash(cb({fixture:'snapshot'})),plc_operation_sha256:hash(cb({fixture:'operation'})),source_service_base:source,destination_service_base:destination,destination_address:selectionValue.address,destination_rotation_key:rotation.did(),destination_messaging_key:target.didKey,user_recovery_key:owner.didKey,user_identity_key:identity.didKey,created_at:now,expires_at:now+3600};
record('portable-consent',consent,await signPortableMigrationConsent(consent,identity.privateKey),identity);
const activated:any={type:'hail.portable-migration-activated',version:1,did,transfer_id:id(2),snapshot_digest:consent.snapshot_digest,destination_service_base:destination,destination_messaging_key:target.didKey,destination_address:selectionValue.address,address_binding_digest:hash(cb({fixture:'binding'})),activated_at:now};
const activation=record('activation',activated,await signActivationReceipt(activated,target.privateKey),target);
const plan:any={type:'hail.connection-handover-prepare',version:1,request_id:id(4),transfer_id:id(2),did,peer_did:peer,source_service_base:source,destination_service_base:destination,destination_messaging_key:target.didKey,source_generation:1,snapshot_digest:consent.snapshot_digest,connection_checkpoint_digest:hash(cb({fixture:'connections'})),frontier:{native:[],federated:{connectionId:id(5),epoch:2,state:'disconnected',tombstones:[{connectionId:id(5),epoch:2}]}},issued_at:now,expires_at:now+300};
for(const role of ['source','destination','peer-ack','source-freeze','destination-freeze','peer-freeze'] as const){const key=role.startsWith('source')?sender:role.startsWith('destination')?target:other;record('handover-'+role,plan,await signConnectionHandover(plan,role,key.privateKey),key,role);}
const abort:any={type:'hail.connection-handover-abort',version:1,request_id:id(6),transfer_id:id(2),did,peer_did:peer,plan_digest:hash(cb(plan)),issued_at:now,expires_at:now+300};
for(const role of ['source-abort','destination-abort','peer-release'] as const){const key=role.startsWith('source')?sender:role.startsWith('destination')?target:other;record(role,abort,await signConnectionHandoverAbort(abort,role,key.privateKey),key,role);}
for(const action of ['commit','complete'] as const){
 const transition:any={type:'hail.connection-handover-transition',version:1,action,request_id:id(action==='commit'?7:8),transfer_id:id(2),did,peer_did:peer,plan_digest:hash(cb(plan)),binding_digest:activated.address_binding_digest,activation_digest:action==='commit'?null:connectionActivationDigest(activation),issued_at:now,expires_at:now+300};
 const signed=record('handover-'+action,transition,await signConnectionHandoverTransition(transition,target.privateKey),target,'destination-'+action);
 const result:any={type:'hail.connection-handover-result',version:1,phase:action==='commit'?'committed':'completed',transfer_id:id(2),did,peer_did:peer,plan_digest:hash(cb(plan)),request_digest:hash(signed.payloadBytes),terminal_ids:[id(5)],issued_at:now};
 record('handover-'+action+'-result',result,await signConnectionHandoverResult(result,other.privateKey),other,'peer-'+action);
}
const cancellation={type:'hail.connection-transfer-cancellation',version:1,did,transfer_id:id(2),snapshot_digest:consent.snapshot_digest,source_service_base:source,destination_service_base:destination,issued_at:now,expires_at:now+300};
for(const role of ['owner-cancel','destination-cancelled'] as const){const key=role==='owner-cancel'?identity:target,payloadBytes=cb(cancellation);const signature=new Uint8Array(await crypto.subtle.sign('Ed25519',key.privateKey,connectionCancellationInput(role,payloadBytes)));record('connection-'+role,cancellation,{payloadBytes,signature},key,role,'hail.connection-transfer.'+role+'.v1');}
await writeFile(new URL('../../../spec/vectors/transfer-wire.json',import.meta.url),JSON.stringify({format:'hail-transfer-wire-v1',time:now,
  notice:'PUBLIC TEST KEYS. Fixed scalar/seed bytes 01..07 repeated; never use for accounts. Placeholder PLC CIDs and digest subjects exercise representation/linkage, not live PLC authority.',records},null,2)+'\n');
console.log('Wrote '+records.length+' signed transfer/handover records');

// Complete coherent consent bundle, not arbitrary base64 placeholders.
const {signPayload}=await import('@hailproto/codec');
const objects:any[]=[];
async function cose(name:string,value:any,key:any,role='hail-messaging'){
  const kid=value.from??value.did;
  const bytes=await signPayload(value.type,value,{keyId:kid+'#'+role,async sign(input){return new Uint8Array(await crypto.subtle.sign('Ed25519',key.privateKey,input));}});
  objects.push({id:name,type:value.type,keyId:kid+'#'+role,publicKeyHex:key.publicKeyHex,coseHex:hex(bytes)});return bytes;
}
const token=new Uint8Array(32).fill(9);
const inv=await cose('invitation',{type:'hail.connection-invitation',version:1,invitation_id:id(10),from:did,token_hash:{algorithm:'sha-256',value:hash(token)},issued_at:now,expires_at:now+3600,key_id:did+'#hail-identity'},identity,'hail-identity');
const confirmation=await cose('confirmation',{type:'hail.connection-confirmation',version:1,confirmation_id:id(11),from:peer,to:did,invitation_id:id(10),invitation_hash:{algorithm:'sha-256',value:hash(inv)},issued_at:now,expires_at:now+300,key_id:peer+'#hail-identity'},targetIdentity,'hail-identity');
const ib=await cose('inviter-binding',{type:'hail.address-binding',version:2,address:'alice@source.example.com',did,issued_at:now,key_id:did+'#hail-identity'},identity,'hail-identity');
const sb=await cose('scanner-binding',{type:'hail.address-binding',version:2,address:'bob@target.example.com',did:peer,issued_at:now,key_id:peer+'#hail-identity'},targetIdentity,'hail-identity');
const base:any={type:'hail.connection-control',version:1,from:did,to:peer,request_id:id(11),connection_id:null,epoch:0,state:'empty',proof_hash:{algorithm:'sha-256',value:hash(new Uint8Array())},issued_at:now,expires_at:null,key_id:did+'#hail-messaging'};
const snapshot=await cose('reviewed-snapshot',{...base,operation:'snapshot'},sender);
const bundle=cb({invitation:inv,confirmation,inviterBinding:ib,scannerBinding:sb,snapshot});
const proof={algorithm:'sha-256',value:hash(bundle)};
const probe=await cose('probe',{...base,from:peer,to:did,key_id:peer+'#hail-messaging',operation:'probe',expires_at:now+300},target);
const offered=await cose('offer',{...base,from:peer,to:did,key_id:peer+'#hail-messaging',operation:'offer',expires_at:now+300,proof_hash:proof},target);
const admitted=await cose('admission',{...base,operation:'admission',proof_hash:proof},sender);
const connect=await cose('connect',{...base,from:peer,to:did,key_id:peer+'#hail-messaging',operation:'connect',expires_at:now+300,proof_hash:proof},target);
const event=await cose('active-event',{...base,operation:'snapshot',connection_id:id(12),epoch:1,state:'active',proof_hash:proof},sender);
const current=await cose('current-active',{...base,operation:'snapshot',connection_id:id(12),epoch:1,state:'active'},sender);
const acknowledged=await cose('ack',{...base,from:peer,to:did,key_id:peer+'#hail-messaging',operation:'ack',connection_id:id(12),epoch:1,state:'active',proof_hash:{algorithm:'sha-256',value:hash(event)}},target);
const disconnect=await cose('disconnect',{...base,operation:'disconnect',connection_id:id(12),epoch:1,state:'active',request_id:id(13),expires_at:now+300,proof_hash:{algorithm:'sha-256',value:hash(cb({connection_id:id(12)}))}},sender);
const closed=await cose('closed-event',{...base,operation:'snapshot',connection_id:id(12),epoch:2,state:'disconnected',request_id:id(13),proof_hash:{algorithm:'sha-256',value:hash(cb({connection_id:id(12)}))}},sender);
const closedCurrent=await cose('current-closed',{...base,operation:'snapshot',connection_id:id(12),epoch:2,state:'disconnected',request_id:id(13)},sender);
const closeAck=await cose('closed-ack',{...base,from:peer,to:did,key_id:peer+'#hail-messaging',operation:'ack',connection_id:id(12),epoch:2,state:'disconnected',request_id:id(13),proof_hash:{algorithm:'sha-256',value:hash(closed)}},target);
const descriptor=await cose('conversation',{type:'hail.conversation',version:1,from:did,conversation_id:id(14),membership_revision:1,participants:[did,peer,'did:plc:'+'c'.repeat(24)],created_at:now,admission_until:now+3600},sender);
const revival=await cose('revival',{type:'hail.conversation-revival',version:1,from:did,to:peer,conversation_id:id(14),descriptor_hash:{algorithm:'sha-256',value:hash(descriptor)},request_id:id(15),issued_at:now+4000,expires_at:now+5000},sender);
const b64=encodeBase64Url;
const exchanges=[
 {operation:'invitations/review',request:{id:id(10),did,token:b64(token)},response:{type:'hail.connection-review',version:1,invitation:b64(inv),binding:b64(ib),federation:1}},
 {operation:'state',request:{control:b64(probe)},response:{control:b64(snapshot)}},
 {operation:'admit',request:{control:b64(offered),bundle:b64(bundle),token:b64(token)},response:{control:b64(admitted)}},
 {operation:'commit',request:{control:b64(connect),bundle:b64(bundle),admission:b64(admitted)},response:{control:b64(event),current:b64(current)}},
 {operation:'sync',request:{control:b64(event),bundle:b64(bundle),admission:b64(admitted)},response:{control:b64(acknowledged)}},
 {operation:'disconnect',request:{control:b64(disconnect)},response:{control:b64(closed),current:b64(closedCurrent)}},
 {operation:'sync',request:{control:b64(closed)},response:{control:b64(closeAck)}},
 {operation:'conversation-revival',request:{connectionId:id(12),cose:b64(revival),epoch:1},response:{requestId:id(15),outcome:'renewed'}},
];
await writeFile(new URL('../../../spec/vectors/connection-wire.json',import.meta.url),JSON.stringify({format:'hail-connection-wire-v1',time:now,objects,bundleHex:hex(bundle),bundleDigestHex:hex(hash(bundle)),
  exchanges:exchanges.map(e=>({...e,method:'POST',contentType:'application/json',requestUtf8:JSON.stringify(e.request),responseStatus:200,responseUtf8:JSON.stringify(e.response)})),
  negative:[{id:'duplicate-key',operation:'state',body:'{"control":"a","control":"b"}',status:400},{id:'wrong-media',operation:'state',body:'{}',contentType:'text/plain',status:415},{id:'coded',operation:'state',body:'{}',contentEncoding:'gzip',status:415},{id:'credential',operation:'state',body:'{}',authorization:'Bearer fixture',status:403},{id:'unknown-operation',operation:'unknown',body:'{}',status:404}]},null,2)+'\n');
console.log('Wrote connection, revival and transport rejection vectors');
