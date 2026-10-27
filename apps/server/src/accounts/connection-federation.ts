import {createHash} from "node:crypto";
import type {SQL} from "bun";
import {createWebCryptoSigner,createWebCryptoVerifier,decodeBase64Url,decodeDeterministic,encodeBase64Url,encodeDeterministic,
  inspectSignedPayload,signPayload,verifySignedPayload,type HailConnectionControl,type HailConnectionConfirmation,type HailValue} from "@hailproto/codec";
import type {ConnectionOwner} from "./connections.js";
import type {AccountApiSession} from "./repository.js";
import {ConnectionError} from "./connection-error.js";
import {RemoteConnectionError,RemoteConnectionReview} from "./connection-review.js";
import type {HailDidResolver,ResolvedHailDid,PlcResolutionEvidence} from "../plc/resolver.js";
import {requireFreshPublicAuthority} from "../plc/authority.js";
import {ed25519PublicKeyFromDidKey} from "../identity/did-key.js";
import {importEd25519PrivateKey} from "../identity/keys.js";
import type {KeyEncryptor} from "../identity/key-encryption.js";
import {uuidV7} from "../identity/uuid-v7.js";
import {OnboardingRepository} from "../onboarding/repository.js";
import {withServingGeneration} from "../db/serving.js";
import {connectionFrontier,sameConnectionFrontier,signConnectionHandover,verifyConnectionHandover,decodeConnectionHandover,connectionHandoverPlanDigest,
  decodeConnectionHandoverAbort,signConnectionHandoverAbort,verifyConnectionHandoverAbort} from "../migration/connection-handover.js";
import {verifyConnectionHandoverSignature} from '../migration/connection-handover.js';
import {decodeConnectionHandoverTransition,verifyConnectionHandoverTransition,signConnectionHandoverResult,connectionActivationDigest,type ConnectionHandoverResult} from '../migration/connection-handover.js';
import {verifyActivationReceipt} from '../migration/activation-receipt.js';
import {decodeSignedRecord,encodeSignedRecord} from "../migration/wire.js";

const hash=(value:Uint8Array)=>new Uint8Array(createHash("sha256").update(value).digest());
const digest=(value:Uint8Array)=>({algorithm:"sha-256" as const,value:hash(value)});
const equal=(a:Uint8Array,b:Uint8Array)=>Buffer.from(a).equals(Buffer.from(b));
const encoded=(value:unknown)=>encodeDeterministic(value as HailValue);
const EMPTY=hash(new Uint8Array());
const now=()=>Math.floor(Date.now()/1000);
type Control=HailConnectionControl;
interface Pair {id:string;account_id:string;serving_generation:number|string;local_did:string;peer_did:string;peer_address:string;
  peer_service_base:string;coordinator_service_base:string;
  epoch:number|string;state:"empty"|"active"|"disconnected";connection_id:string|null;cutoff_at:Date|null;updated_at:Date;}
interface Attempt {id:string;account_id:string;pair_id:string;direction:"outbound"|"admitted";bundle:Uint8Array;proof_digest:Uint8Array;
  token_ciphertext:Uint8Array|null;token_nonce:Uint8Array|null;admission_cose:Uint8Array|null;result_cose:Uint8Array|null;
  state:"pending"|"admitted"|"active"|"expired"|"conflict";expires_at:Date;}
interface Event {id:string;account_id:string;pair_id:string;epoch:number|string;state:"active"|"disconnected";connection_id:string;request_id:string;proof_digest:Uint8Array;created_at:Date;}
interface Bundle {invitation:Uint8Array;confirmation:Uint8Array;inviterBinding:Uint8Array;scannerBinding:Uint8Array;snapshot:Uint8Array;}
interface Draft {invitation:Uint8Array;inviterBinding:Uint8Array;scannerBinding:Uint8Array;snapshot:Uint8Array;confirmation:HailConnectionConfirmation;}
interface Barrier {account_id:string;moving_did:string;transfer_id:string;plan_digest:Uint8Array;plan_bytes:Uint8Array;source_signature:Uint8Array;destination_signature:Uint8Array;
  peer_signature:Uint8Array;state:'frozen'|'committed'|'completed'|'released';release_payload:Uint8Array|null;release_source_signature:Uint8Array|null;
  release_destination_signature:Uint8Array|null;release_peer_signature:Uint8Array|null;destination_binding:Uint8Array|null;
  commit_payload:Uint8Array|null;commit_signature:Uint8Array|null;peer_commit_payload:Uint8Array|null;peer_commit_signature:Uint8Array|null;
  completion_payload:Uint8Array|null;completion_signature:Uint8Array|null;peer_completion_payload:Uint8Array|null;peer_completion_signature:Uint8Array|null;}
export interface FederationHooks {
  owner(tx:SQL,id:string):Promise<ConnectionOwner>;
  live(tx:SQL,session:AccountApiSession):Promise<void>;
  authority(tx:SQL,owner:ConnectionOwner,key?:string):Promise<{resolved:ResolvedHailDid}>;
  binding(tx:SQL,owner:ConnectionOwner,key:string):Promise<Uint8Array>;
  invitation(tx:SQL,input:{id:string;did:string;token:string}):Promise<{owner:ConnectionOwner;cose:Uint8Array;createdAt:Date}>;
}

// The lexicographically smaller DID's current provider serializes pair epochs.
// No shared transaction, synchronized clock, or unsolicited invitation inbox is assumed.
export class ConnectionFederation {
  constructor(private readonly sql:SQL,private readonly encryptor:KeyEncryptor,private readonly resolver:HailDidResolver,
    private readonly remote:RemoteConnectionReview|undefined,private readonly base:string,private readonly hooks:FederationHooks){}

  private bytes(value:unknown,max=16384){
    if(typeof value!=="string"||value.length>Math.ceil(max*4/3))throw new ConnectionError(400,"Invalid connection proof.");
    try{const bytes=decodeBase64Url(value);if(!bytes.length||bytes.length>max||encodeBase64Url(bytes)!==value)throw new Error();return bytes;}
    catch{throw new ConnectionError(400,"Invalid connection proof.");}
  }
  private fields(value:Record<string,unknown>,keys:string[]){if(!value||typeof value!=="object"||Array.isArray(value)||Object.keys(value).sort().join(",")!==keys.sort().join(","))throw new ConnectionError(400);}
  private async checkedControl(bytes:Uint8Array,operation:Control["operation"],fresh=false){
    const payload=inspectSignedPayload("hail.connection-control",bytes).payload;
    if(payload.operation!==operation)throw new ConnectionError(400,"Connection control purpose differs.");
    const state=await this.resolver.resolve(payload.from);
    await requireFreshPublicAuthority(this.sql,state.evidence,{did:payload.from,role:"hail-messaging",key:state.messagingDidKey,serviceBase:state.serviceBase},new Date());
    await verifySignedPayload("hail.connection-control",bytes,createWebCryptoVerifier(async kid=>{
      if(kid!==payload.from+"#hail-messaging")throw new ConnectionError(400);return ed25519PublicKeyFromDidKey(state.messagingDidKey);
    }));
    if(payload.issued_at>now()+300||fresh&&(payload.expires_at===null||payload.expires_at<=now()))throw new ConnectionError(410,"Connection transport approval expired.");
    return {payload,state};
  }
  private async retainProof(tx:SQL,accountId:string,cose:Uint8Array,authority:PlcResolutionEvidence){
    await tx`INSERT INTO connection_proof_signatures(account_id,digest,cose,authority)
      VALUES(${accountId},${hash(cose)},${cose},${JSON.stringify(authority)}::jsonb) ON CONFLICT(account_id,digest) DO NOTHING`;
  }
  private async verify(bytes:Uint8Array,operation:Control["operation"],fresh=false,tx=this.sql){
    const {payload,state}=await this.checkedControl(bytes,operation,fresh);
    const pair=(await tx<{account_id:string}[]>`SELECT p.account_id FROM federated_connection_pairs p
      JOIN provider_accounts a ON a.id=p.account_id AND a.did=p.local_did
      JOIN account_serving_generations g ON g.account_id=a.id AND g.generation=p.serving_generation
      WHERE p.local_did=${payload.to} AND p.peer_did=${payload.from} AND a.onboarding_state='active' AND a.activation_verification_mode='public'
        AND NOT EXISTS(SELECT 1 FROM provider_migration_fences f WHERE f.account_id=a.id)`)[0];
    if(pair)await this.retainProof(tx,pair.account_id,bytes,state.evidence);
    return payload;
  }
  private async retainBundle(tx:SQL,owner:ConnectionOwner,v:Awaited<ReturnType<ConnectionFederation['verifyBundle']>>){
    await this.retainProof(tx,owner.id,v.b.invitation,v.inviter.evidence);
    await this.retainProof(tx,owner.id,v.b.confirmation,v.scanner.evidence);
    await this.retainProof(tx,owner.id,v.b.snapshot,v.coordinator.evidence);
  }
  private async sign(tx:SQL,owner:ConnectionOwner,fields:Omit<Control,"type"|"version"|"from"|"key_id"|"issued_at"|"expires_at">,issued=now()){
    await this.hooks.authority(tx,owner);
    const key=await new OnboardingRepository(tx).getKey(owner.id,"hail-messaging"),state=await this.resolver.resolve(owner.did);
    if(state.serviceBase!==this.base||state.messagingDidKey!==key.publicKey)throw new ConnectionError(409,"Connection provider authority changed.");
    await requireFreshPublicAuthority(tx,state.evidence,{did:owner.did,role:"hail-messaging",key:key.publicKey,serviceBase:this.base},new Date());
    const receipt=["snapshot","admission","ack"].includes(fields.operation);
    const payload:Control={type:"hail.connection-control",version:1,...fields,from:owner.did,key_id:owner.did+"#hail-messaging",issued_at:issued,expires_at:receipt?null:issued+300};
    const raw=await this.encryptor.decrypt(owner.id,key.role,key.algorithm,key.publicKey,key);
    let cose:Uint8Array;
    try{cose=await signPayload("hail.connection-control",payload,createWebCryptoSigner(payload.key_id,await importEd25519PrivateKey(raw)));}finally{raw.fill(0);}
    await tx`INSERT INTO federated_connection_signatures(digest,account_id,cose,authority)
      VALUES(${hash(cose)},${owner.id},${cose},${JSON.stringify(state.evidence)}::jsonb) ON CONFLICT(digest) DO NOTHING`;
    return cose;
  }
  private async ownerForDid(did:string){
    const row=(await this.sql<{id:string}[]>`SELECT id FROM provider_accounts WHERE did=${did} AND onboarding_state='active'`)[0];
    if(!row)throw new ConnectionError(404);return this.hooks.owner(this.sql,row.id);
  }
  private async transaction<T>(owner:ConnectionOwner,fn:(tx:SQL)=>Promise<T>,releasing=false){
    return withServingGeneration(owner.id,Number(owner.generation),()=>this.sql.begin(async tx=>{
      await tx`SELECT id FROM provider_accounts WHERE id=${owner.id} FOR UPDATE`;
      const current=await this.hooks.owner(tx,owner.id);if(current.did!==owner.did||Number(current.generation)!==Number(owner.generation))throw new ConnectionError(409);
      if(!releasing)await tx`SELECT hail_assert_unfenced_account(${owner.id}::uuid)`;return fn(tx as SQL);
    }));
  }
  private async pair(tx:SQL,owner:ConnectionOwner,peer:string,address?:string){
    let pair=(await tx<Pair[]>`SELECT * FROM federated_connection_pairs WHERE account_id=${owner.id} AND peer_did=${peer}`)[0];
    const remote=await this.resolver.resolve(peer),coordinatorBase=owner.did<peer?this.base:remote.serviceBase;
    if(!pair&&address){
      const count=(await tx<{count:string}[]>`SELECT count(*) FROM federated_connection_pairs WHERE account_id=${owner.id}`)[0]!;
      if(Number(count.count)>=100)throw new ConnectionError(429,"The federation preview supports up to 100 retained peer relationships per account.");
      pair=(await tx<Pair[]>`INSERT INTO federated_connection_pairs(id,account_id,serving_generation,local_did,peer_did,peer_address,peer_service_base,coordinator_service_base)
        VALUES(${uuidV7()},${owner.id},${owner.generation},${owner.did},${peer},${address},${remote.serviceBase},${coordinatorBase}) RETURNING *`)[0]!;
    }
    if(!pair)throw new ConnectionError(404);
    if(Number(pair.serving_generation)!==Number(owner.generation)||pair.local_did!==owner.did)throw new ConnectionError(409);
    if(pair.peer_service_base!==remote.serviceBase||pair.coordinator_service_base!==coordinatorBase)throw new ConnectionError(409,"Provider location changed; portable history reconciliation is required.");
    return pair;
  }
  private async pairById(tx:SQL,id:string,owner:ConnectionOwner){
    const row=(await tx<Pair[]>`SELECT * FROM federated_connection_pairs WHERE id=${id} AND account_id=${owner.id}`)[0];
    if(!row||Number(row.serving_generation)!==Number(owner.generation))throw new ConnectionError(404);return row;
  }
  private async send(did:string,step:"state"|"admit"|"commit"|"disconnect"|"sync",wire:Record<string,unknown>){
    const state=await this.resolver.resolve(did);
    if(state.serviceBase===this.base)return this.handle(step,wire);
    if(!this.remote)throw new ConnectionError(409,"Remote connection transport is unavailable.");
    return (await this.remote.exchange(did,step,wire)).wire;
  }
  private async snapshot(tx:SQL,owner:ConnectionOwner,peer:string,request:Control,event?:Event,pair?:Pair){
    return this.sign(tx,owner,{operation:"snapshot",to:peer,request_id:request.request_id,
      connection_id:event?.connection_id??pair?.connection_id??null,epoch:Number(event?.epoch??pair?.epoch??0),state:event?.state??pair?.state??"empty",
      proof_hash:{algorithm:"sha-256",value:event?.proof_digest??request.proof_hash.value}},event?Math.floor(event.created_at.getTime()/1000):now());
  }
  private async connectionResponse(tx:SQL,owner:ConnectionOwner,peer:string,request:Control,event:Event,proof:Uint8Array){
    const pair=await this.pair(tx,owner,peer);
    return {control:encodeBase64Url(await this.snapshot(tx,owner,peer,request,{...event,proof_digest:proof})),
      current:encodeBase64Url(await this.snapshot(tx,owner,peer,{...request,proof_hash:{algorithm:"sha-256",value:EMPTY}},undefined,pair))};
  }
  private async current(owner:ConnectionOwner,peer:string){
    const id=uuidV7(),probe=await this.transaction(owner,tx=>this.sign(tx,owner,{operation:"probe",to:peer,request_id:id,connection_id:null,epoch:0,state:"empty",proof_hash:{algorithm:"sha-256",value:EMPTY}}));
    const response=await this.send([owner.did,peer].sort()[0]!,"state",{control:encodeBase64Url(probe)}),snapshot=await this.verify(this.bytes(response.control),"snapshot");
    if(snapshot.from!==[owner.did,peer].sort()[0]||snapshot.to!==[owner.did,peer].sort()[1]||snapshot.request_id!==id||!equal(snapshot.proof_hash.value,EMPTY))throw new ConnectionError(409);
    return snapshot;
  }
  private async verifyBundle(bytes:Uint8Array,fresh:boolean){
    const b=decodeDeterministic(bytes) as unknown as Bundle;
    this.fields(b as unknown as Record<string,unknown>,["invitation","confirmation","inviterBinding","scannerBinding","snapshot"]);
    for(const v of Object.values(b))if(!(v instanceof Uint8Array)||v.length>16384)throw new ConnectionError(400);
    const invitation=inspectSignedPayload("hail.connection-invitation",b.invitation).payload,confirmation=inspectSignedPayload("hail.connection-confirmation",b.confirmation).payload;
    const inviter=await this.resolver.resolve(invitation.from),scanner=await this.resolver.resolve(confirmation.from);
    if(inviter.did!==invitation.from||scanner.did!==confirmation.from||confirmation.to!==invitation.from||
      confirmation.invitation_id!==invitation.invitation_id||!equal(confirmation.invitation_hash.value,hash(b.invitation)))throw new ConnectionError(400,"Connection consent linkage differs.");
    const verifier=(did:string,key:string)=>createWebCryptoVerifier(async kid=>{if(kid!==did+"#hail-identity")throw new ConnectionError(400);return ed25519PublicKeyFromDidKey(key);});
    await verifySignedPayload("hail.connection-invitation",b.invitation,verifier(inviter.did,inviter.identityDidKey));
    await verifySignedPayload("hail.connection-confirmation",b.confirmation,verifier(scanner.did,scanner.identityDidKey));
    const ib=(await verifySignedPayload("hail.address-binding",b.inviterBinding,verifier(inviter.did,inviter.identityDidKey))).payload;
    const sb=(await verifySignedPayload("hail.address-binding",b.scannerBinding,verifier(scanner.did,scanner.identityDidKey))).payload;
    if(ib.did!==inviter.did||sb.did!==scanner.did||invitation.issued_at>now()+300||confirmation.issued_at>now()+300||ib.issued_at>now()+300||sb.issued_at>now()+300||
      fresh&&(confirmation.expires_at<=now()||invitation.expires_at!==null&&invitation.expires_at<=now()||ib.expires_at<=now()||sb.expires_at<=now()))throw new ConnectionError(410,"Connection consent or address proof expired.");
    const {payload:snapshot,state:coordinator}=await this.checkedControl(b.snapshot,"snapshot");
    const [small,large]=[inviter.did,scanner.did].sort();
    if(snapshot.from!==small||snapshot.to!==large||snapshot.request_id!==confirmation.confirmation_id||!equal(snapshot.proof_hash.value,EMPTY))throw new ConnectionError(400,"Connection epoch proposal differs.");
    for(const state of [inviter,scanner])await requireFreshPublicAuthority(this.sql,state.evidence,{did:state.did,role:"hail-identity",key:state.identityDidKey,serviceBase:state.serviceBase},new Date());
    return {b,invitation,confirmation,inviter,scanner,ib,sb,snapshot,coordinator,proof:hash(bytes)};
  }
  private matches(control:Control,verified:Awaited<ReturnType<ConnectionFederation["verifyBundle"]>>,actor:string){
    const peer=actor===verified.inviter.did?verified.scanner.did:verified.inviter.did;
    if(control.from!==actor||control.to!==peer||control.request_id!==verified.confirmation.confirmation_id||
      !equal(control.proof_hash.value,verified.proof)||control.epoch!==verified.snapshot.epoch||control.state!==verified.snapshot.state||control.connection_id!==verified.snapshot.connection_id)
      throw new ConnectionError(400,"Provider admission does not bind this consent and epoch.");
    if(control.operation==="admission"&&(control.issued_at>=verified.confirmation.expires_at||verified.invitation.expires_at!==null&&control.issued_at>=verified.invitation.expires_at))throw new ConnectionError(400,"Admission was not issued within the consent window.");
  }
  private activation(control:Control,v:Awaited<ReturnType<ConnectionFederation["verifyBundle"]>>){
    const [small,large]=[v.inviter.did,v.scanner.did].sort();
    const permitted=v.snapshot.state==="active"?control.epoch===v.snapshot.epoch&&control.connection_id===v.snapshot.connection_id:
      control.epoch===v.snapshot.epoch+1;
    if(control.state!=="active"||control.from!==small||control.to!==large||control.request_id!==v.confirmation.confirmation_id||
      !permitted||!equal(control.proof_hash.value,v.proof)||control.issued_at>=v.confirmation.expires_at||
      v.invitation.expires_at!==null&&control.issued_at>=v.invitation.expires_at)throw new ConnectionError(400,"Activation does not match the admitted consent epoch.");
  }
  private async apply(tx:SQL,pair:Pair,snapshot:Control){
    const [small,large]=[pair.local_did,pair.peer_did].sort();
    if(snapshot.from!==small||snapshot.to!==large)throw new ConnectionError(400);
    if(snapshot.state==="empty")return;
    if(snapshot.state==="disconnected"){
      const inserted=await tx`INSERT INTO federated_connection_tombstones(account_id,pair_id,connection_id,epoch)
        VALUES(${pair.account_id},${pair.id},${snapshot.connection_id!},${snapshot.epoch}) ON CONFLICT(pair_id,connection_id) DO NOTHING RETURNING connection_id`;
      if(inserted.length&&snapshot.epoch>=Number(pair.epoch))await tx`UPDATE federated_connection_pairs SET cutoff_at=clock_timestamp() WHERE id=${pair.id}`;
    }
    const terminal=(await tx`SELECT connection_id FROM federated_connection_tombstones WHERE pair_id=${pair.id} AND connection_id=${snapshot.connection_id!}`).length>0;
    if(snapshot.epoch<Number(pair.epoch)||snapshot.state==="active"&&terminal)return;
    if(snapshot.epoch===Number(pair.epoch)&&pair.connection_id!==null&&pair.connection_id!==snapshot.connection_id)throw new ConnectionError(409,"Conflicting coordinator epoch.");
    if(snapshot.epoch===Number(pair.epoch)&&pair.state===snapshot.state&&pair.connection_id===snapshot.connection_id)return;
    await tx`UPDATE federated_connection_pairs SET epoch=${snapshot.epoch},state=${snapshot.state},connection_id=${snapshot.connection_id},updated_at=clock_timestamp() WHERE id=${pair.id}`;
  }

  async prepare(session:AccountApiSession,input:{id:string;did:string;token:string}){
    await this.hooks.live(this.sql,session);
    const owner=await this.hooks.owner(this.sql,session.account_id),location=await this.resolver.resolve(input.did);
    const proof=location.serviceBase===this.base?await (async()=>{
      const inviter=await this.ownerForDid(input.did);
      return withServingGeneration(inviter.id,Number(inviter.generation),async()=>{
        const checked=await this.hooks.invitation(this.sql,input),bindingBytes=await this.hooks.binding(this.sql,checked.owner,checked.owner.identity_key);
        return {admissionSupported:true,invitationBytes:checked.cose,bindingBytes,address:checked.owner.canonical_address,identityKey:checked.owner.identity_key};
      });
    })():await (async()=>{if(!this.remote)throw new ConnectionError(409,"Remote connection transport is unavailable.");return this.remote.proof(input);})();
    if(!proof.admissionSupported)throw new ConnectionError(409,"The other provider does not support cross-provider connection admission yet.");
    if(input.did===owner.did)throw new ConnectionError(400);
    const id=uuidV7(),coordinator=[owner.did,input.did].sort()[0]!;
    const probe=await this.transaction(owner,tx=>this.sign(tx,owner,{operation:"probe",to:input.did,request_id:id,connection_id:null,epoch:0,state:"empty",proof_hash:{algorithm:"sha-256",value:EMPTY}}));
    const response=await this.send(coordinator,"state",{control:encodeBase64Url(probe)}),snapshotBytes=this.bytes(response.control),snapshot=await this.verify(snapshotBytes,"snapshot");
    if(snapshot.from!==coordinator||snapshot.to!==[owner.did,input.did].sort()[1]||snapshot.request_id!==id||!equal(snapshot.proof_hash.value,EMPTY))throw new ConnectionError(409);
    const issued=now(),confirmation:HailConnectionConfirmation={type:"hail.connection-confirmation",version:1,confirmation_id:id,from:owner.did,to:input.did,
      invitation_id:input.id,invitation_hash:digest(proof.invitationBytes),issued_at:issued,expires_at:issued+300,key_id:owner.did+"#hail-identity"};
    return this.transaction(owner,async tx=>{
      await this.hooks.live(tx,session);await this.hooks.authority(tx,owner);
      const pair=await this.pair(tx,owner,input.did,proof.address);
      if((await tx`SELECT id FROM federated_connection_attempts WHERE pair_id=${pair.id} AND direction='outbound' AND state='pending'`).length)
        throw new ConnectionError(409,"A connection attempt is already in progress. Check its status on Security.");
      if(snapshot.state==="disconnected")await this.apply(tx,pair,snapshot);
      if(snapshot.state==="active"&&(await tx`SELECT connection_id FROM federated_connection_tombstones WHERE pair_id=${pair.id} AND connection_id=${snapshot.connection_id!}`).length)
        throw new ConnectionError(409,"Your disconnect is still synchronizing. Wait for it before reconnecting.");
      const scannerBinding=await this.hooks.binding(tx,owner,owner.identity_key),token=decodeBase64Url(input.token,32);
      const encrypted=await this.encryptor.encryptConnectionToken(owner.id,id,token);token.fill(0);
      const draft:Draft={invitation:proof.invitationBytes,inviterBinding:proof.bindingBytes,scannerBinding,snapshot:snapshotBytes,confirmation};
      return {pairId:pair.id,confirmation,bytes:encoded(draft),ciphertext:encrypted.ciphertext,nonce:encrypted.nonce,peerKey:proof.identityKey,
        address:proof.address,actorBinding:scannerBinding,peerBinding:proof.bindingBytes};
    });
  }
  async enqueue(tx:SQL,owner:ConnectionOwner,pairId:string,draftBytes:Uint8Array,ciphertext:Uint8Array,nonce:Uint8Array,signed:Uint8Array){
    const pair=await this.pairById(tx,pairId,owner),draft=decodeDeterministic(draftBytes) as unknown as Draft;
    if(draft.confirmation.from!==owner.did||draft.confirmation.to!==pair.peer_did||draft.confirmation.expires_at<=now())throw new ConnectionError(410);
    const current=await this.hooks.binding(tx,owner,owner.identity_key);if(!equal(current,draft.scannerBinding))throw new ConnectionError(409,"Your address binding changed after review.");
    const bytes=encoded({...draft,confirmation:signed}),id=draft.confirmation.confirmation_id;
    const verified=await this.verifyBundle(bytes,true);await this.retainBundle(tx,owner,verified);
    await tx`INSERT INTO federated_connection_attempts(id,account_id,pair_id,direction,bundle,proof_digest,token_ciphertext,token_nonce,state,expires_at)
      VALUES(${id},${owner.id},${pair.id},'outbound',${bytes},${hash(bytes)},${ciphertext},${nonce},'pending',${new Date(draft.confirmation.expires_at*1000)})`;
    return {attemptId:id,state:"connecting",connectionId:null};
  }
  async active(session:AccountApiSession,id:string){
    return (await this.sql<Pair[]>`SELECT p.* FROM federated_connection_pairs p WHERE account_id=${session.account_id} AND connection_id=${id} AND state='active'
      AND NOT EXISTS(SELECT 1 FROM federated_connection_tombstones t WHERE t.pair_id=p.id AND t.connection_id=p.connection_id)`)[0]??null;
  }
  async messageState(localDid:string,peerDid:string,connectionId:string,epoch:number){
    const owner=await this.ownerForDid(localDid);
    return withServingGeneration(owner.id,Number(owner.generation),async()=>{
      const pair=await this.pair(this.sql,owner,peerDid);
      if(pair.state!=="active"||pair.connection_id!==connectionId||Number(pair.epoch)!==epoch)return false;
      const snapshot=await this.current(owner,peerDid);
      if(snapshot.state==="disconnected")await this.transaction(owner,async tx=>this.apply(tx,await this.pairById(tx,pair.id,owner),snapshot));
      return snapshot.state==="active"&&snapshot.connection_id===connectionId&&snapshot.epoch===epoch;
    });
  }
  async disconnect(tx:SQL,owner:ConnectionOwner,pairId:string,id:string,operationId:string){
    const pair=await this.pairById(tx,pairId,owner);if(pair.connection_id!==id||pair.state!=="active")throw new ConnectionError(409,"The connection is no longer active.");
    await tx`INSERT INTO federated_connection_tombstones(account_id,pair_id,connection_id,epoch) VALUES(${owner.id},${pair.id},${id},${pair.epoch}) ON CONFLICT DO NOTHING`;
    await tx`UPDATE federated_connection_pairs SET cutoff_at=clock_timestamp(),updated_at=clock_timestamp() WHERE id=${pair.id}`;
    await tx`INSERT INTO federated_connection_disconnects(id,account_id,pair_id,connection_id,epoch) VALUES(${operationId},${owner.id},${pair.id},${id},${pair.epoch})`;
    return {connectionId:id,state:"disconnected",propagation:"pending"};
  }
  async result(accountId:string,id:string){
    const row=(await this.sql<Attempt[]>`SELECT * FROM federated_connection_attempts WHERE id=${id} AND account_id=${accountId} AND direction='outbound'`)[0];
    if(!row)throw new ConnectionError(404);
    if(row.result_cose){const result=inspectSignedPayload("hail.connection-control",new Uint8Array(row.result_cose)).payload;return {attemptId:id,connectionId:result.connection_id,state:result.state};}
    return {attemptId:id,connectionId:null,state:row.state==="pending"?"connecting":row.state};
  }
  async list(accountId:string){
    const active=await this.sql<Pair[]>`SELECT p.* FROM federated_connection_pairs p WHERE account_id=${accountId} AND state='active'
      AND NOT EXISTS(SELECT 1 FROM federated_connection_tombstones t WHERE t.pair_id=p.id AND t.connection_id=p.connection_id) ORDER BY id LIMIT 100`;
    const pending=await this.sql<{id:string;peer_did:string;peer_address:string;kind:string;state:string}[]>`
      SELECT latest.id,latest.peer_did,latest.peer_address,'connect' AS kind,latest.state FROM (
        SELECT DISTINCT ON (a.pair_id) a.id,p.peer_did,p.peer_address,a.state,p.state AS pair_state FROM federated_connection_attempts a
          JOIN federated_connection_pairs p ON p.id=a.pair_id WHERE a.account_id=${accountId} AND a.direction='outbound'
          ORDER BY a.pair_id,a.created_at DESC,a.id DESC
      ) latest WHERE latest.state='pending' OR latest.state IN ('expired','conflict') AND latest.pair_state<>'active'
      UNION ALL SELECT d.id,p.peer_did,p.peer_address,'disconnect' AS kind,'pending' AS state FROM federated_connection_disconnects d
        JOIN federated_connection_pairs p ON p.id=d.pair_id WHERE d.account_id=${accountId} AND d.result_cose IS NULL
      UNION ALL SELECT o.id,p.peer_did,p.peer_address,CASE WHEN e.state='active' THEN 'connect' ELSE 'disconnect' END AS kind,e.state
        FROM federated_connection_outbox o JOIN federated_connection_events e ON e.id=o.event_id JOIN federated_connection_pairs p ON p.id=e.pair_id
        WHERE o.account_id=${accountId} AND o.ack_cose IS NULL LIMIT 300`;
    return {connections:active.map(p=>({id:p.connection_id!,did:p.peer_did,address:p.peer_address,connectedAt:p.updated_at.toISOString(),remote:p.peer_service_base!==this.base})),
      pendingConnections:[...new Map(pending.map(p=>[p.kind+":"+p.peer_did,{id:p.id,did:p.peer_did,address:p.peer_address,kind:p.kind,state:p.state}])).values()]};
  }

  private barrierResponse(row:Barrier){
    const receipt=row.state==='frozen'?{payloadBytes:row.plan_bytes,signature:row.peer_signature}:row.state==='released'?{payloadBytes:row.release_payload!,signature:row.release_peer_signature!}:
      row.state==='committed'?{payloadBytes:row.peer_commit_payload!,signature:row.peer_commit_signature!}:{payloadBytes:row.peer_completion_payload!,signature:row.peer_completion_signature!};
    return {type:'hail.connection-handover-barrier',version:1,phase:row.state,barrierDigest:encodeBase64Url(row.plan_digest),cutoverAuthorized:false,
      receipt:encodeSignedRecord({payloadBytes:new Uint8Array(receipt.payloadBytes),signature:new Uint8Array(receipt.signature)}),
      freezeReceipt:encodeSignedRecord({payloadBytes:new Uint8Array(row.plan_bytes),signature:new Uint8Array(row.peer_signature)})};
  }
  private exactBarrier(row:Barrier,proposal:{payloadBytes:Uint8Array;signature:Uint8Array},destination:Uint8Array){
    if(!equal(row.plan_bytes,proposal.payloadBytes)||!equal(row.source_signature,proposal.signature)||!equal(row.destination_signature,destination))throw new ConnectionError(409,'Handover retry changed its retained exact intent.');
    return this.barrierResponse(row);
  }
  private async prepareHandover(wire:Record<string,unknown>,freeze=false){
    this.fields(wire,["proposal","destinationSignature"]);
    const proposal=decodeSignedRecord(wire.proposal,65536),untrusted=decodeConnectionHandover(proposal),destination=this.bytes(wire.destinationSignature,64);
    const owner=await this.ownerForDid(untrusted.peer_did),planDigest=connectionHandoverPlanDigest(proposal.payloadBytes);
    if(freeze){const prior=(await this.sql<Barrier[]>`SELECT * FROM connection_handover_barriers WHERE account_id=${owner.id} AND plan_digest=${planDigest}`)[0];
      if(prior)return this.exactBarrier(prior,proposal,destination);}
    const source=await this.resolver.resolve(untrusted.did);
    if(untrusted.expires_at<=now())throw new ConnectionError(410,'Connection handover freshness window expired without a retained freeze.');
    if(source.did!==untrusted.did)throw new ConnectionError(409,'Handover source identity differs.');
    await requireFreshPublicAuthority(this.sql,source.evidence,{did:source.did,role:"hail-messaging",key:source.messagingDidKey,serviceBase:source.serviceBase},new Date());
    const plan=await verifyConnectionHandover(proposal,freeze?'source-freeze':"source",source.messagingDidKey,now());
    if(plan.source_service_base!==source.serviceBase)throw new ConnectionError(409,"Handover source location differs.");
    await verifyConnectionHandover({...proposal,signature:destination},freeze?'destination-freeze':"destination",plan.destination_messaging_key,now());
    return this.transaction(owner,async tx=>{
      await this.hooks.authority(tx,owner);
      if(freeze){
        const prior=(await tx<Barrier[]>`SELECT * FROM connection_handover_barriers WHERE account_id=${owner.id} AND plan_digest=${planDigest}`)[0];
        if(prior)return this.exactBarrier(prior,proposal,destination);
        if((await tx`SELECT plan_digest FROM connection_handover_barriers WHERE account_id=${owner.id} AND moving_did=${plan.did} AND state IN('frozen','committed')`).length)
          throw new ConnectionError(409,'A different handover already holds this connection pair.');
      }
      const native=await tx<Record<string,unknown>[]>`SELECT id,did_a,did_b,state FROM account_connections
        WHERE ${owner.id} IN(account_a,account_b) AND ${plan.did} IN(did_a,did_b)`;
      const pairs=await tx<Record<string,unknown>[]>`SELECT * FROM federated_connection_pairs WHERE account_id=${owner.id} AND peer_did=${plan.did}`;
      if(pairs.length)await this.pair(tx,owner,plan.did); // Existing service-location pins still apply.
      if(freeze&&(await tx`SELECT o.id FROM federated_connection_outbox o JOIN federated_connection_events e ON e.id=o.event_id
        JOIN federated_connection_pairs p ON p.id=e.pair_id WHERE o.account_id=${owner.id} AND p.peer_did=${plan.did} AND o.ack_cose IS NULL LIMIT 1`).length)
        throw new ConnectionError(409,'Finish connection result replication before handover freeze.');
      const tombstones=await tx<Record<string,unknown>[]>`SELECT t.* FROM federated_connection_tombstones t JOIN federated_connection_pairs p ON p.id=t.pair_id
        WHERE t.account_id=${owner.id} AND p.peer_did=${plan.did}`;
      if(!sameConnectionFrontier(plan.frontier,connectionFrontier(owner.did,plan.did,native,pairs,tombstones)))throw new ConnectionError(409,"Connection history changed before handover preparation.");
      const key=await new OnboardingRepository(tx).getKey(owner.id,"hail-messaging"),resolved=await this.resolver.resolve(owner.did);
      if(resolved.messagingDidKey!==key.publicKey||resolved.serviceBase!==this.base)throw new ConnectionError(409);
      await requireFreshPublicAuthority(tx,resolved.evidence,{did:owner.did,role:"hail-messaging",key:key.publicKey,serviceBase:this.base},new Date());
      const raw=await this.encryptor.decrypt(owner.id,key.role,key.algorithm,key.publicKey,key);
      try{
        const signed=await signConnectionHandover(plan,freeze?'peer-freeze':"peer-ack",await importEd25519PrivateKey(raw));
        if(!freeze)return {preparation:encodeSignedRecord(signed)};
        if(plan.expires_at<=now())throw new ConnectionError(410,'Handover freeze approval expired before commit.');
        await requireFreshPublicAuthority(tx,source.evidence,{did:source.did,role:'hail-messaging',key:source.messagingDidKey,serviceBase:source.serviceBase},new Date());
        const row=(await tx<Barrier[]>`INSERT INTO connection_handover_barriers(account_id,serving_generation,moving_did,transfer_id,plan_digest,plan_bytes,
          source_signature,destination_signature,source_messaging_key,source_authority,source_service_base,destination_service_base,peer_service_base,peer_signature,peer_messaging_key,peer_authority)
          VALUES(${owner.id},${owner.generation},${plan.did},${plan.transfer_id},${planDigest},${proposal.payloadBytes},${proposal.signature},${destination},
            ${source.messagingDidKey},${JSON.stringify(source.evidence)}::jsonb,${plan.source_service_base},${plan.destination_service_base},${this.base},${signed.signature},${key.publicKey},${JSON.stringify(resolved.evidence)}::jsonb) RETURNING *`)[0]!;
        return this.barrierResponse(row);
      }
      finally{raw.fill(0);}
    });
  }

  private async abortHandover(wire:Record<string,unknown>){
    const supplied=wire.proposal!==undefined;
    this.fields(wire,supplied?['abort','destinationSignature','proposal','freezeDestinationSignature']:['abort','destinationSignature']);
    const command=decodeSignedRecord(wire.abort),abort=decodeConnectionHandoverAbort(command),destination=this.bytes(wire.destinationSignature,64),owner=await this.ownerForDid(abort.peer_did);
    return this.transaction(owner,async tx=>{
      let row=(await tx<Barrier[]>`SELECT * FROM connection_handover_barriers WHERE account_id=${owner.id} AND plan_digest=${abort.plan_digest} FOR UPDATE`)[0];
      if(!row&&!supplied)throw new ConnectionError(404);
      const proposal=row?{payloadBytes:new Uint8Array(row.plan_bytes),signature:new Uint8Array(row.source_signature)}:decodeSignedRecord(wire.proposal,65536),plan=decodeConnectionHandover(proposal);
      if(abort.did!==plan.did||abort.transfer_id!==plan.transfer_id||abort.peer_did!==plan.peer_did||plan.peer_did!==owner.did||!equal(connectionHandoverPlanDigest(proposal.payloadBytes),abort.plan_digest))throw new ConnectionError(409,'Abort targets another handover.');
      if(row?.state==='released'){
        if(!equal(row.release_payload!,command.payloadBytes)||!equal(row.release_source_signature!,command.signature)||!equal(row.release_destination_signature!,destination))
          throw new ConnectionError(409,'Released handover has another exact abort result.');
        return this.barrierResponse(row);
      }
      if(row&&row.state!=='frozen')throw new ConnectionError(409,'A post-cutover handover cannot be aborted.');
      if(abort.expires_at<=now())throw new ConnectionError(410,'Connection abort freshness window expired without a retained release.');
      const source=await this.resolver.resolve(abort.did);
      if(source.did!==abort.did||source.serviceBase!==plan.source_service_base)throw new ConnectionError(409,'A committed or changed source cannot release the old handover.');
      await requireFreshPublicAuthority(tx,source.evidence,{did:abort.did,role:'hail-messaging',key:source.messagingDidKey,serviceBase:source.serviceBase},new Date());
      await verifyConnectionHandoverAbort(command,'source-abort',source.messagingDidKey,now());
      await verifyConnectionHandoverAbort({...command,signature:destination},'destination-abort',plan.destination_messaging_key,now());
      const freezeDestination=row?new Uint8Array(row.destination_signature):this.bytes(wire.freezeDestinationSignature,64);
      if(!row){await verifyConnectionHandoverSignature(proposal,'source-freeze',source.messagingDidKey);
        await verifyConnectionHandoverSignature({...proposal,signature:freezeDestination},'destination-freeze',plan.destination_messaging_key);}
      const key=await new OnboardingRepository(tx).getKey(owner.id,'hail-messaging'),resolved=await this.resolver.resolve(owner.did);
      if(resolved.messagingDidKey!==key.publicKey||resolved.serviceBase!==this.base)throw new ConnectionError(409);
      await requireFreshPublicAuthority(tx,resolved.evidence,{did:owner.did,role:'hail-messaging',key:key.publicKey,serviceBase:this.base},new Date());
      const raw=await this.encryptor.decrypt(owner.id,key.role,key.algorithm,key.publicKey,key);
      try{
        const signed=await signConnectionHandoverAbort(abort,'peer-release',await importEd25519PrivateKey(raw));
        await tx`SELECT set_config('hail.connection_abort_record',${Buffer.from(abort.plan_digest).toString('hex')},true)`;
        if(!row){
          const frozen=await signConnectionHandover(plan,'peer-freeze',await importEd25519PrivateKey(raw));
          row=(await tx<Barrier[]>`INSERT INTO connection_handover_barriers(account_id,serving_generation,moving_did,transfer_id,plan_digest,plan_bytes,
            source_signature,destination_signature,source_messaging_key,source_authority,source_service_base,destination_service_base,peer_service_base,peer_signature,peer_messaging_key,peer_authority,
            state,release_payload,release_source_signature,release_source_authority,release_destination_signature,release_peer_signature,release_peer_key,release_peer_authority)
            VALUES(${owner.id},${owner.generation},${plan.did},${plan.transfer_id},${abort.plan_digest},${proposal.payloadBytes},${proposal.signature},${freezeDestination},${source.messagingDidKey},${JSON.stringify(source.evidence)}::jsonb,
              ${plan.source_service_base},${plan.destination_service_base},${this.base},${frozen.signature},${key.publicKey},${JSON.stringify(resolved.evidence)}::jsonb,'released',${command.payloadBytes},${command.signature},${JSON.stringify(source.evidence)}::jsonb,
              ${destination},${signed.signature},${key.publicKey},${JSON.stringify(resolved.evidence)}::jsonb) RETURNING *`)[0]!;
          return this.barrierResponse(row);
        }
        if(abort.expires_at<=now())throw new ConnectionError(410,'Handover abort expired before commit.');
        const released=(await tx<Barrier[]>`UPDATE connection_handover_barriers SET state='released',release_payload=${command.payloadBytes},
          release_source_signature=${command.signature},release_source_authority=${JSON.stringify(source.evidence)}::jsonb,release_destination_signature=${destination},release_peer_signature=${signed.signature},
          release_peer_key=${key.publicKey},release_peer_authority=${JSON.stringify(resolved.evidence)}::jsonb WHERE account_id=${owner.id} AND plan_digest=${abort.plan_digest} RETURNING *`)[0]!;
        return this.barrierResponse(released);
      }finally{raw.fill(0);}
    },true);
  }

  private async transitionHandover(wire:Record<string,unknown>,action:'commit'|'complete'){
    this.fields(wire,action==='commit'?['command','binding']:['command','binding','activation']);
    const command=decodeSignedRecord(wire.command),request=decodeConnectionHandoverTransition(command),bindingBytes=this.bytes(wire.binding),owner=await this.ownerForDid(request.peer_did);
    if(request.action!==action||!equal(hash(bindingBytes),request.binding_digest))throw new ConnectionError(400,'Handover transition purpose or binding differs.');
    const activation=action==='complete'?decodeSignedRecord(wire.activation):null;
    if(activation&&!equal(connectionActivationDigest(activation),request.activation_digest!))throw new ConnectionError(400,'Handover activation bytes differ.');
    return this.transaction(owner,async tx=>{
      const row=(await tx<Barrier[]>`SELECT * FROM connection_handover_barriers WHERE account_id=${owner.id} AND plan_digest=${request.plan_digest} FOR UPDATE`)[0];
      if(!row||row.state==='released')throw new ConnectionError(409,'No held handover exists for this transition.');
      const plan=decodeConnectionHandover({payloadBytes:new Uint8Array(row.plan_bytes),signature:new Uint8Array(row.source_signature)});
      if(request.did!==plan.did||request.peer_did!==plan.peer_did||request.transfer_id!==plan.transfer_id)throw new ConnectionError(409,'Handover transition targets another transfer.');
      const priorPayload=action==='commit'?row.commit_payload:row.completion_payload,priorSignature=action==='commit'?row.commit_signature:row.completion_signature;
      if(priorPayload){
        if(!equal(priorPayload,command.payloadBytes)||!equal(priorSignature!,command.signature)||!equal(row.destination_binding!,bindingBytes))throw new ConnectionError(409,'Handover transition retry changed exact artifacts.');
        return {phase:action==='commit'?'committed':'completed',currentPhase:row.state,receipt:encodeSignedRecord(action==='commit'?
          {payloadBytes:new Uint8Array(row.peer_commit_payload!),signature:new Uint8Array(row.peer_commit_signature!)}:
          {payloadBytes:new Uint8Array(row.peer_completion_payload!),signature:new Uint8Array(row.peer_completion_signature!)})};
      }
      if(action==='complete'&&row.state!=='committed'||action==='commit'&&row.state!=='frozen')throw new ConnectionError(409,'Handover transition is out of order.');
      if(request.expires_at<=now())throw new ConnectionError(410,'Connection handover transition freshness window expired without a retained result.');
      const moving=await this.resolver.resolve(plan.did);
      if(moving.did!==plan.did||moving.serviceBase!==plan.destination_service_base||moving.messagingDidKey!==plan.destination_messaging_key)throw new ConnectionError(409,'PLC has not authorized the exact handover destination.');
      await requireFreshPublicAuthority(tx,moving.evidence,{did:plan.did,role:'hail-messaging',key:plan.destination_messaging_key,serviceBase:plan.destination_service_base},new Date());
      await verifyConnectionHandoverTransition(command,plan.destination_messaging_key,now());
      const binding=(await verifySignedPayload('hail.address-binding',bindingBytes,createWebCryptoVerifier(async kid=>{
        if(kid!==plan.did+'#hail-identity')throw new ConnectionError(400);return ed25519PublicKeyFromDidKey(moving.identityDidKey);
      }))).payload;
      if(binding.did!==plan.did||binding.expires_at<=now()||binding.issued_at>now()+300)throw new ConnectionError(410,'Destination binding is stale or belongs to another DID.');
      if(plan.frontier.native.length)throw new ConnectionError(409,'Native connection reconstruction is not enabled for this handover.');
      const pair=(await tx<Pair[]>`SELECT * FROM federated_connection_pairs WHERE account_id=${owner.id} AND peer_did=${plan.did}`)[0],base=plan.frontier.federated;
      if(!pair||!base||pair.connection_id!==base.connectionId||Number(pair.epoch)<base.epoch||Number(pair.epoch)>base.epoch+1||
        (Number(pair.epoch)>base.epoch&&pair.state!=='disconnected'))throw new ConnectionError(409,'Connection changed beyond the held handover frontier.');
      const tombstones=await tx<{connection_id:string}[]>`SELECT connection_id FROM federated_connection_tombstones WHERE pair_id=${pair.id}`;
      const terminalIds=tombstones.map(r=>r.connection_id).sort(),known=new Set([base.connectionId,...base.tombstones.map(t=>t.connectionId)]);
      if(terminalIds.some(id=>!known.has(id))||base.tombstones.some(t=>!terminalIds.includes(t.connectionId)))throw new ConnectionError(409,'Handover terminal history changed unexpectedly.');
      if(action==='complete'){
        const receipt=await verifyActivationReceipt(activation!,plan.destination_messaging_key,now());
        if(receipt.did!==plan.did||receipt.transfer_id!==plan.transfer_id||receipt.destination_service_base!==plan.destination_service_base||receipt.destination_address!==binding.address||
          !equal(receipt.snapshot_digest,plan.snapshot_digest)||!equal(receipt.address_binding_digest,request.binding_digest))throw new ConnectionError(409,'Activation receipt does not match the held snapshot and binding.');
      }
      await this.hooks.authority(tx,owner);
      const key=await new OnboardingRepository(tx).getKey(owner.id,'hail-messaging'),self=await this.resolver.resolve(owner.did);
      if(self.messagingDidKey!==key.publicKey||self.serviceBase!==this.base)throw new ConnectionError(409);
      await requireFreshPublicAuthority(tx,self.evidence,{did:owner.did,role:'hail-messaging',key:key.publicKey,serviceBase:this.base},new Date());
      const result:ConnectionHandoverResult={type:'hail.connection-handover-result',version:1,phase:action==='commit'?'committed':'completed',transfer_id:plan.transfer_id,
        did:plan.did,peer_did:owner.did,plan_digest:request.plan_digest,request_digest:hash(command.payloadBytes),terminal_ids:terminalIds,issued_at:now()};
      const raw=await this.encryptor.decrypt(owner.id,key.role,key.algorithm,key.publicKey,key);
      try{
        const signed=await signConnectionHandoverResult(result,await importEd25519PrivateKey(raw));
        if(request.expires_at<=now())throw new ConnectionError(410,'Handover transition expired before commit.');
        if(action==='commit'){
          if(pair.peer_service_base!==plan.source_service_base)throw new ConnectionError(409,'Peer location no longer matches the held source.');
          await tx`UPDATE connection_handover_barriers SET state='committed',destination_binding=${bindingBytes},destination_address=${binding.address},commit_payload=${command.payloadBytes},
            commit_signature=${command.signature},commit_moving_authority=${JSON.stringify(moving.evidence)}::jsonb,peer_commit_payload=${signed.payloadBytes},peer_commit_signature=${signed.signature},peer_commit_key=${key.publicKey},peer_commit_authority=${JSON.stringify(self.evidence)}::jsonb
            WHERE account_id=${owner.id} AND plan_digest=${request.plan_digest}`;
          await tx`SELECT set_config('hail.connection_handover_commit',${Buffer.from(request.plan_digest).toString('hex')},true)`;
          if(pair.state==='active'&&pair.peer_address!==binding.address){
            await tx`INSERT INTO connection_address_notices(account_id,serving_generation,peer_did,connection_id,transfer_id,previous_address,address)
              VALUES(${owner.id},${owner.generation},${plan.did},${pair.connection_id},${plan.transfer_id},${pair.peer_address},${binding.address})
              ON CONFLICT(account_id,peer_did) DO UPDATE SET serving_generation=EXCLUDED.serving_generation,
                connection_id=EXCLUDED.connection_id,transfer_id=EXCLUDED.transfer_id,previous_address=EXCLUDED.previous_address,
                address=EXCLUDED.address,completed_at=NULL`;
          }
          await tx`UPDATE federated_connection_pairs SET peer_address=${binding.address},peer_service_base=${plan.destination_service_base},
            coordinator_service_base=${owner.did<plan.did?this.base:plan.destination_service_base},updated_at=clock_timestamp() WHERE id=${pair.id}`;
        }else {
          await tx`UPDATE connection_handover_barriers SET state='completed',completion_payload=${command.payloadBytes},completion_signature=${command.signature},activation_payload=${activation!.payloadBytes},activation_signature=${activation!.signature},
          peer_completion_payload=${signed.payloadBytes},peer_completion_signature=${signed.signature},peer_completion_key=${key.publicKey},peer_completion_authority=${JSON.stringify(self.evidence)}::jsonb
          WHERE account_id=${owner.id} AND plan_digest=${request.plan_digest}`;
          await tx`UPDATE connection_address_notices SET completed_at=clock_timestamp()
            WHERE account_id=${owner.id} AND peer_did=${plan.did} AND transfer_id=${plan.transfer_id}
              AND serving_generation=${owner.generation} AND completed_at IS NULL`;
        }
        return {phase:result.phase,currentPhase:result.phase,receipt:encodeSignedRecord(signed)};
      }finally{raw.fill(0);}
    });
  }

  async handle(step:"state"|"admit"|"commit"|"disconnect"|"sync"|"handover"|'handover-freeze'|'handover-abort'|'handover-commit'|'handover-complete',wire:Record<string,unknown>):Promise<Record<string,unknown>>{
    // Preparation acknowledges an exact frontier only. It never changes location
    // pins, freezes a peer or authorizes cutover; a later fenced commit is required.
    if(step==="handover")return this.prepareHandover(wire);
    if(step==='handover-freeze')return this.prepareHandover(wire,true);
    if(step==='handover-abort')return this.abortHandover(wire);
    if(step==='handover-commit')return this.transitionHandover(wire,'commit');
    if(step==='handover-complete')return this.transitionHandover(wire,'complete');
    this.fields(wire,step==="admit"?["control","bundle","token"]:step==="commit"?["control","bundle","admission"]:
      step==="sync"&&wire.bundle!==undefined?["control","bundle","admission"]:["control"]);
    const raw=this.bytes(wire.control),operation={state:"probe",admit:"offer",commit:"connect",disconnect:"disconnect",sync:"snapshot"}[step] as Control["operation"];
    const control=await this.verify(raw,operation,step!=="sync"),[small,large]=[control.from,control.to].sort();
    const target=step==="admit"?control.to:step==="sync"?large!:small!;
    if(step==="sync"&&control.from!==small)throw new ConnectionError(400);
    const owner=await this.ownerForDid(target);
    await this.hooks.authority(this.sql,owner);
    const peer=owner.did===control.from?control.to:control.from;
    if(step==="state"){
      if(control.state!=="empty"||control.connection_id!==null||control.epoch!==0||!equal(control.proof_hash.value,EMPTY))throw new ConnectionError(400);
      return this.transaction(owner,async tx=>{
        const pair=(await tx<Pair[]>`SELECT * FROM federated_connection_pairs WHERE account_id=${owner.id} AND peer_did=${peer}`)[0];
        return {control:encodeBase64Url(await this.snapshot(tx,owner,peer,control,undefined,pair))};
      });
    }
    if(step==="sync"){
      let current:Control|null=null;
      if(control.state==="active"){
        const pair=await this.pair(this.sql,owner,peer);
        const consent=(await this.sql<Attempt[]>`SELECT * FROM federated_connection_attempts WHERE id=${control.request_id} AND pair_id=${pair.id}`)[0];
        if(!consent||!equal(consent.proof_digest,control.proof_hash.value))throw new ConnectionError(409,"No local consent exists for this activation.");
        const closed=(await this.sql`SELECT connection_id FROM federated_connection_tombstones WHERE pair_id=${pair.id} AND connection_id=${control.connection_id!}`).length>0;
        if(!closed&&!(pair.state==="active"&&pair.connection_id===control.connection_id&&Number(pair.epoch)>=control.epoch))current=await this.current(owner,peer);
      }
      return this.transaction(owner,async tx=>{
        const pair=await this.pair(tx,owner,peer);
        if(control.state==="active"){
          const bytes=this.bytes(wire.bundle,100000),proof=hash(bytes),admissionBytes=this.bytes(wire.admission);
          if(!equal(control.proof_hash.value,proof))throw new ConnectionError(400);
          const attempt=(await tx<Attempt[]>`SELECT * FROM federated_connection_attempts WHERE id=${control.request_id} AND pair_id=${pair.id}`)[0];
          if(!attempt||!equal(attempt.proof_digest,proof))throw new ConnectionError(409,"No local consent exists for this activation.");
          const prior=attempt.result_cose?inspectSignedPayload('hail.connection-control',new Uint8Array(attempt.result_cose)).payload:null;
          const alreadyAdopted=prior&&Number(pair.epoch)>=control.epoch&&prior.operation==='snapshot'&&prior.state==='active'&&prior.from===control.from&&prior.to===control.to&&
            prior.request_id===control.request_id&&prior.connection_id===control.connection_id&&prior.epoch===control.epoch&&equal(prior.proof_hash.value,control.proof_hash.value)&&
            equal(attempt.bundle,bytes)&&attempt.admission_cose&&equal(attempt.admission_cose,admissionBytes);
          if(!alreadyAdopted){
            const v=await this.verifyBundle(bytes,false),admission=await this.verify(admissionBytes,"admission",false,tx);this.matches(admission,v,v.inviter.did);
            this.activation(control,v);await this.retainBundle(tx,owner,v);
            await tx`UPDATE federated_connection_attempts SET admission_cose=COALESCE(admission_cose,${admissionBytes}),result_cose=${raw},state='active'
              WHERE id=${control.request_id} AND pair_id=${pair.id} AND result_cose IS NULL AND state IN('pending','admitted')`;
          }
        }
        if(current?.state==="disconnected")await this.apply(tx,pair,current);
        if(!current||current.epoch===control.epoch&&current.connection_id===control.connection_id&&current.state===control.state)await this.apply(tx,await this.pairById(tx,pair.id,owner),control);
        const ack=await this.sign(tx,owner,{operation:"ack",to:peer,request_id:control.request_id,connection_id:control.connection_id,epoch:control.epoch,state:control.state,proof_hash:digest(raw)});
        return {control:encodeBase64Url(ack)};
      });
    }
    if(step==="disconnect")return this.coordinatorDisconnect(owner,peer,control,raw);
    const bytes=this.bytes(wire.bundle,100000),proof=hash(bytes);
    if(!equal(control.proof_hash.value,proof))throw new ConnectionError(400);
    if(step==="admit"){
      const prior=(await this.sql<Attempt[]>`SELECT * FROM federated_connection_attempts WHERE id=${control.request_id} AND account_id=${owner.id} AND direction='admitted'`)[0];
      if(prior){const pair=await this.pair(this.sql,owner,peer);if(prior.pair_id!==pair.id||!equal(prior.proof_digest,proof))throw new ConnectionError(409);return {control:encodeBase64Url(prior.admission_cose!)};}
      const v=await this.verifyBundle(bytes,true);this.matches(control,v,v.scanner.did);
      if(v.inviter.did!==owner.did||typeof wire.token!=="string")throw new ConnectionError(400);
      const input={id:v.invitation.invitation_id,did:owner.did,token:wire.token};
      // Persist authenticated remote disconnect knowledge even if this old code is then refused.
      await this.transaction(owner,async tx=>{
        await this.hooks.invitation(tx,input);const pair=await this.pair(tx,owner,peer,v.sb.address);
        if(v.snapshot.state==="disconnected")await this.apply(tx,pair,v.snapshot);
      });
      return this.transaction(owner,async tx=>{
        const invitation=await this.hooks.invitation(tx,input),pair=await this.pair(tx,owner,peer),current=await this.hooks.binding(tx,owner,owner.identity_key);
        if(!equal(invitation.cose,v.b.invitation)||!equal(current,v.b.inviterBinding))throw new ConnectionError(409,"Invitation or binding changed before admission.");
        const freshCode=(await tx`SELECT i.id FROM connection_invitations i JOIN federated_connection_pairs p ON p.id=${pair.id}
          WHERE i.id=${input.id} AND (p.cutoff_at IS NULL OR i.created_at>p.cutoff_at)`).length>0;
        if(!freshCode)throw new ConnectionError(409,"Replace or create a new code after the prior disconnect before reconnecting this pair.");
        if(v.snapshot.connection_id&&(await tx`SELECT connection_id FROM federated_connection_tombstones WHERE pair_id=${pair.id} AND connection_id=${v.snapshot.connection_id}`).length&&v.snapshot.state==="active")throw new ConnectionError(409);
        const existing=(await tx<Attempt[]>`SELECT * FROM federated_connection_attempts WHERE id=${control.request_id} AND account_id=${owner.id}`)[0];
        if(existing){if(existing.pair_id!==pair.id||!equal(existing.proof_digest,proof))throw new ConnectionError(409);return {control:encodeBase64Url(existing.admission_cose!)};}
        if(v.confirmation.expires_at<=now()||v.invitation.expires_at!==null&&v.invitation.expires_at<=now())throw new ConnectionError(410);
        const admission=await this.sign(tx,owner,{operation:"admission",to:peer,request_id:control.request_id,connection_id:v.snapshot.connection_id,epoch:v.snapshot.epoch,state:v.snapshot.state,proof_hash:{algorithm:"sha-256",value:proof}});
        await this.retainBundle(tx,owner,v);
        const rows=await tx`INSERT INTO federated_connection_attempts(id,account_id,pair_id,direction,bundle,proof_digest,admission_cose,state,expires_at)
          SELECT ${control.request_id},${owner.id},${pair.id},'admitted',${bytes},${proof},${admission},'admitted',${new Date(v.confirmation.expires_at*1000)}
          WHERE ${v.confirmation.expires_at}>extract(epoch FROM clock_timestamp())
            AND (${v.invitation.expires_at}::bigint IS NULL OR ${v.invitation.expires_at}::bigint>extract(epoch FROM clock_timestamp())) RETURNING id`;
        if(!rows.length)throw new ConnectionError(410);
        return {control:encodeBase64Url(admission)};
      });
    }
    return this.coordinatorConnect(owner,peer,control,bytes,this.bytes(wire.admission),raw);
  }
  private async event(tx:SQL,pair:Pair,request:Control,state:"active"|"disconnected",connectionId:string,epoch:number){
    const event=(await tx<Event[]>`INSERT INTO federated_connection_events(id,account_id,pair_id,epoch,state,connection_id,request_id,proof_digest)
      VALUES(${uuidV7()},${pair.account_id},${pair.id},${epoch},${state},${connectionId},${request.request_id},${request.proof_hash.value}) RETURNING *`)[0]!;
    if(state==='disconnected')await tx`INSERT INTO federated_connection_outbox(id,account_id,event_id) VALUES(${uuidV7()},${pair.account_id},${event.id})`;
    return event;
  }
  private async coordinatorConnect(owner:ConnectionOwner,peer:string,request:Control,bytes:Uint8Array,admissionBytes:Uint8Array,requestBytes:Uint8Array){
    const proof=hash(bytes);
    const prior=(await this.sql<{proof_digest:Uint8Array;pair_id:string;event_id:string}[]>`SELECT * FROM federated_connection_results WHERE id=${request.request_id} AND account_id=${owner.id} AND action='connect'`)[0];
    if(prior)return this.transaction(owner,async tx=>{
      const pair=await this.pair(tx,owner,peer);if(prior.pair_id!==pair.id||!equal(prior.proof_digest,proof))throw new ConnectionError(409);
      const event=(await tx<Event[]>`SELECT * FROM federated_connection_events WHERE id=${prior.event_id}`)[0]!;
      return this.connectionResponse(tx,owner,peer,request,event,prior.proof_digest);
    });
    const v=await this.verifyBundle(bytes,true),admission=await this.verify(admissionBytes,"admission");this.matches(request,v,v.scanner.did);this.matches(admission,v,v.inviter.did);
    return this.transaction(owner,async tx=>{
      const pair=await this.pair(tx,owner,peer,owner.did===v.inviter.did?v.sb.address:v.ib.address);
      const local=(await tx<Attempt[]>`SELECT * FROM federated_connection_attempts WHERE id=${request.request_id} AND account_id=${owner.id} AND pair_id=${pair.id}`)[0];
      if(!local||!equal(local.proof_digest,proof))throw new ConnectionError(409,"Coordinator has no local consent for this pair.");
      await this.retainBundle(tx,owner,v);
      const raced=(await tx<{event_id:string;proof_digest:Uint8Array}[]>`SELECT * FROM federated_connection_results WHERE id=${request.request_id}`)[0];
      if(raced){if(!equal(raced.proof_digest,proof))throw new ConnectionError(409);const event=(await tx<Event[]>`SELECT * FROM federated_connection_events WHERE id=${raced.event_id}`)[0]!;return this.connectionResponse(tx,owner,peer,request,event,proof);}
      let event:Event;
      if(pair.state==="active"&&(request.epoch===Number(pair.epoch)||request.epoch===Number(pair.epoch)-1)){
        if((await tx`SELECT connection_id FROM federated_connection_tombstones WHERE pair_id=${pair.id} AND connection_id=${pair.connection_id!}`).length)throw new ConnectionError(409);
        event=(await tx<Event[]>`SELECT * FROM federated_connection_events WHERE pair_id=${pair.id} AND epoch=${pair.epoch}`)[0]!;
      }else{
        if(request.epoch!==Number(pair.epoch)||request.state!==pair.state||request.connection_id!==pair.connection_id)throw new ConnectionError(409,"The reviewed connection epoch was superseded.");
        if(v.confirmation.expires_at<=now())throw new ConnectionError(410);
        event=await this.event(tx,pair,request,"active",uuidV7(),Number(pair.epoch)+1);
        const snap:Control={...request,operation:"snapshot",from:owner.did,to:peer,epoch:Number(event.epoch),state:"active",connection_id:event.connection_id,expires_at:null};
        await this.apply(tx,pair,snap);
      }
      // Each accepted operation gets its own proof-bound response, even when it converges on an earlier event.
      await tx`INSERT INTO federated_connection_results(id,account_id,pair_id,action,request_cose,proof_digest,event_id)
        VALUES(${request.request_id},${owner.id},${pair.id},'connect',${requestBytes},${proof},${event.id})`;
      await tx`INSERT INTO federated_connection_outbox(id,account_id,event_id,request_id) VALUES(${uuidV7()},${owner.id},${event.id},${request.request_id})`;
      return this.connectionResponse(tx,owner,peer,request,event,proof);
    });
  }
  private async coordinatorDisconnect(owner:ConnectionOwner,peer:string,request:Control,requestBytes:Uint8Array){
    if(!request.connection_id||request.state!=="active"||!equal(request.proof_hash.value,hash(encoded({connection_id:request.connection_id}))))throw new ConnectionError(400);
    return this.transaction(owner,async tx=>{
      const pair=await this.pair(tx,owner,peer);
      const prior=(await tx<{event_id:string;pair_id:string;proof_digest:Uint8Array}[]>`SELECT * FROM federated_connection_results WHERE id=${request.request_id}`)[0];
      let event:Event;
      if(prior){if(prior.pair_id!==pair.id||!equal(prior.proof_digest,request.proof_hash.value))throw new ConnectionError(409);event=(await tx<Event[]>`SELECT * FROM federated_connection_events WHERE id=${prior.event_id}`)[0]!;}
      else{
        const old=(await tx<Event[]>`SELECT * FROM federated_connection_events WHERE pair_id=${pair.id} AND connection_id=${request.connection_id} AND state='disconnected' ORDER BY epoch DESC LIMIT 1`)[0];
        if(old)event=old;
        else{
          if(pair.connection_id!==request.connection_id||pair.state==="empty")throw new ConnectionError(409,"Disconnect targets a different connection epoch.");
          // A local disconnect already hides the row, but only the coordinator advances its epoch.
          event=await this.event(tx,pair,request,"disconnected",request.connection_id!,Number(pair.epoch)+1);
          await this.apply(tx,pair,{...request,operation:"snapshot",from:owner.did,to:peer,epoch:Number(event.epoch),state:"disconnected",expires_at:null});
        }
        await tx`INSERT INTO federated_connection_results(id,account_id,pair_id,action,request_cose,proof_digest,event_id)
          VALUES(${request.request_id},${owner.id},${pair.id},'disconnect',${requestBytes},${request.proof_hash.value},${event.id})`;
      }
      return {control:encodeBase64Url(await this.snapshot(tx,owner,peer,request,event))};
    });
  }

  async workOne(){
    // ponytail: one federation delivery per provider avoids pooled-connection starvation;
    // use per-job locks and a bounded pool if preview throughput outgrows this worker.
    const lock=await this.sql.reserve();let locked=false;
    try{
      locked=(await lock<{locked:boolean}[]>`SELECT pg_try_advisory_lock(684245164) AS locked`)[0]!.locked;if(!locked)return false;
      const d=(await this.sql<{id:string;account_id:string;pair_id:string;connection_id:string;epoch:number|string}[]>`SELECT * FROM federated_connection_disconnects WHERE result_cose IS NULL AND next_attempt_at<=clock_timestamp() ORDER BY attempts,id LIMIT 1`)[0];
      if(d){await this.workDisconnect(d);return true;}
      const out=(await this.sql<{id:string;event_id:string;account_id:string;request_id:string|null}[]>`SELECT * FROM federated_connection_outbox WHERE ack_cose IS NULL AND next_attempt_at<=clock_timestamp() ORDER BY attempts,id LIMIT 1`)[0];
      if(out){await this.workOutbox(out);return true;}
      const attempt=(await this.sql<Attempt[]>`SELECT * FROM federated_connection_attempts WHERE direction='outbound' AND state='pending' AND next_attempt_at<=clock_timestamp() ORDER BY attempts,id LIMIT 1`)[0];
      if(!attempt)return false;await this.workAttempt(attempt);return true;
    }finally{try{if(locked)await lock`SELECT pg_advisory_unlock(684245164)`;}finally{lock.release();}}
  }
  private async defer(table:"federated_connection_attempts"|"federated_connection_disconnects"|"federated_connection_outbox",id:string,accountId:string){
    // Table names are a closed internal union, never wire input.
    await this.sql.begin(tx=>tx.unsafe(`UPDATE ${table} SET attempts=attempts+1,next_attempt_at=clock_timestamp()+make_interval(secs=>LEAST(3600,power(2,LEAST(attempts+1,12))::integer)) WHERE id=$1 AND account_id=$2`,[id,accountId]));
  }
  private async workAttempt(attempt:Attempt){
    const owner=await this.hooks.owner(this.sql,attempt.account_id),pair=await this.pairById(this.sql,attempt.pair_id,owner);
    try{
      const v=await this.verifyBundle(new Uint8Array(attempt.bundle),false);
      if(v.inviter.serviceBase!==pair.peer_service_base||v.scanner.serviceBase!==this.base)throw new ConnectionError(409,"Provider location changed after review.");
      let admissionBytes:Uint8Array|null=attempt.admission_cose?new Uint8Array(attempt.admission_cose):null;
      if(!admissionBytes){
        if(attempt.expires_at.getTime()<=Date.now()){await this.sql`UPDATE federated_connection_attempts SET state='expired' WHERE id=${attempt.id} AND account_id=${owner.id} AND state='pending'`;return;}
        const offer=await this.transaction(owner,tx=>this.sign(tx,owner,{operation:"offer",to:pair.peer_did,request_id:attempt.id,connection_id:v.snapshot.connection_id,
          epoch:v.snapshot.epoch,state:v.snapshot.state,proof_hash:{algorithm:"sha-256",value:attempt.proof_digest}}));
        const token=await this.encryptor.decryptConnectionToken(owner.id,attempt.id,{ciphertext:attempt.token_ciphertext!,nonce:attempt.token_nonce!,encryptionVersion:1,kekId:"poc-v1"});
        let response:Record<string,unknown>;
        try{response=await this.send(pair.peer_did,"admit",{control:encodeBase64Url(offer),bundle:encodeBase64Url(attempt.bundle),token:encodeBase64Url(token)});}finally{token.fill(0);}
        admissionBytes=this.bytes(response.control);this.matches(await this.verify(admissionBytes,"admission"),v,v.inviter.did);
        await this.sql`UPDATE federated_connection_attempts SET admission_cose=${admissionBytes} WHERE id=${attempt.id} AND account_id=${owner.id} AND admission_cose IS NULL`;
      }
      const request=await this.transaction(owner,tx=>this.sign(tx,owner,{operation:"connect",to:pair.peer_did,request_id:attempt.id,connection_id:v.snapshot.connection_id,
        epoch:v.snapshot.epoch,state:v.snapshot.state,proof_hash:{algorithm:"sha-256",value:attempt.proof_digest}}));
      const response=await this.send([owner.did,pair.peer_did].sort()[0]!,"commit",{control:encodeBase64Url(request),bundle:encodeBase64Url(attempt.bundle),admission:encodeBase64Url(admissionBytes)});
      const bytes=this.bytes(response.control),snapshot=await this.verify(bytes,"snapshot");
      this.activation(snapshot,v);
      const current=await this.verify(this.bytes(response.current),"snapshot");
      if(current.from!==snapshot.from||current.to!==snapshot.to||current.request_id!==attempt.id||!equal(current.proof_hash.value,EMPTY))throw new ConnectionError(409);
      await this.transaction(owner,async tx=>{
        if(current.state==="disconnected")await this.apply(tx,await this.pairById(tx,pair.id,owner),current);
        if(current.state==="active"&&current.connection_id===snapshot.connection_id&&current.epoch===snapshot.epoch)await this.apply(tx,await this.pairById(tx,pair.id,owner),snapshot);
        await tx`UPDATE federated_connection_attempts SET result_cose=${bytes},state='active' WHERE id=${attempt.id} AND account_id=${owner.id} AND state='pending'`;
      });
    }catch(error){
      const status=error instanceof ConnectionError||error instanceof RemoteConnectionError?error.status:503;
      if([400,403,404,409,410].includes(status))await this.sql`UPDATE federated_connection_attempts SET state=${status===410?"expired":"conflict"} WHERE id=${attempt.id} AND account_id=${owner.id} AND state='pending'`;
      else await this.defer("federated_connection_attempts",attempt.id,owner.id);
    }
  }
  private async workDisconnect(d:{id:string;account_id:string;pair_id:string;connection_id:string;epoch:number|string}){
    const owner=await this.hooks.owner(this.sql,d.account_id),pair=await this.pairById(this.sql,d.pair_id,owner);
    try{
      const request=await this.transaction(owner,tx=>this.sign(tx,owner,{operation:"disconnect",to:pair.peer_did,request_id:d.id,connection_id:d.connection_id,epoch:Number(d.epoch),state:"active",proof_hash:digest(encoded({connection_id:d.connection_id}))}));
      const response=await this.send([owner.did,pair.peer_did].sort()[0]!,"disconnect",{control:encodeBase64Url(request)}),bytes=this.bytes(response.control),snapshot=await this.verify(bytes,"snapshot");
      if(snapshot.request_id!==d.id||snapshot.state!=="disconnected"||snapshot.connection_id!==d.connection_id||!equal(snapshot.proof_hash.value,hash(encoded({connection_id:d.connection_id}))))throw new ConnectionError(409);
      await this.transaction(owner,async tx=>{await this.apply(tx,await this.pairById(tx,pair.id,owner),snapshot);await tx`UPDATE federated_connection_disconnects SET result_cose=${bytes} WHERE id=${d.id} AND result_cose IS NULL`;});
    }catch{await this.defer("federated_connection_disconnects",d.id,owner.id);}
  }
  private async workOutbox(job:{id:string;event_id:string;account_id:string;request_id:string|null}){
    const owner=await this.hooks.owner(this.sql,job.account_id),original=(await this.sql<Event[]>`SELECT * FROM federated_connection_events WHERE id=${job.event_id}`)[0]!,pair=await this.pairById(this.sql,original.pair_id,owner);
    let event=job.request_id===null&&Number(pair.epoch)>Number(original.epoch)?(await this.sql<Event[]>`SELECT * FROM federated_connection_events WHERE pair_id=${pair.id} AND epoch=${pair.epoch}`)[0]!:original;
    try{
      if(job.request_id){const intent=(await this.sql<Attempt[]>`SELECT * FROM federated_connection_attempts WHERE id=${job.request_id} AND account_id=${owner.id} AND pair_id=${pair.id}`)[0];
        if(!intent)throw new ConnectionError(409,'Replication lost its retained consent intent');event={...event,request_id:job.request_id,proof_digest:intent.proof_digest};}
      const request={request_id:event.request_id,proof_hash:{algorithm:"sha-256",value:event.proof_digest}} as Control;
      const snapshot=await this.transaction(owner,tx=>this.snapshot(tx,owner,pair.peer_did,request,event));
      const wire:Record<string,unknown>={control:encodeBase64Url(snapshot)};
      if(event.state==="active"){
        const attempt=(await this.sql<Attempt[]>`SELECT * FROM federated_connection_attempts WHERE id=${event.request_id} AND account_id=${owner.id}`)[0]!;
        if(!attempt?.admission_cose)throw new ConnectionError(409);
        wire.bundle=encodeBase64Url(attempt.bundle);wire.admission=encodeBase64Url(attempt.admission_cose);
      }
      const response=await this.send(pair.peer_did,"sync",wire),ackBytes=this.bytes(response.control),ack=await this.verify(ackBytes,"ack");
      if(ack.from!==pair.peer_did||ack.to!==owner.did||ack.request_id!==event.request_id||ack.epoch!==Number(event.epoch)||ack.connection_id!==event.connection_id||ack.state!==event.state||!equal(ack.proof_hash.value,hash(snapshot)))throw new ConnectionError(409);
      await this.sql`UPDATE federated_connection_outbox SET ack_cose=${ackBytes} WHERE id=${job.id} AND ack_cose IS NULL`;
    }catch{await this.defer("federated_connection_outbox",job.id,owner.id);}
  }
}
