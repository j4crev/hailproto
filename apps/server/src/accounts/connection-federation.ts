import {createHash} from "node:crypto";
import type {SQL} from "bun";
import {createWebCryptoSigner,createWebCryptoVerifier,decodeBase64Url,decodeDeterministic,encodeBase64Url,encodeDeterministic,
  inspectSignedPayload,signPayload,verifySignedPayload,type HailConnectionControl,type HailConnectionConfirmation,type HailValue} from "@hailproto/codec";
import type {ConnectionOwner} from "./connections.js";
import type {AccountApiSession} from "./repository.js";
import {ConnectionError} from "./connection-error.js";
import {RemoteConnectionError,RemoteConnectionReview} from "./connection-review.js";
import type {HailDidResolver,ResolvedHailDid} from "../plc/resolver.js";
import {requireFreshPublicAuthority} from "../plc/authority.js";
import {ed25519PublicKeyFromDidKey} from "../identity/did-key.js";
import {importEd25519PrivateKey} from "../identity/keys.js";
import type {KeyEncryptor} from "../identity/key-encryption.js";
import {uuidV7} from "../identity/uuid-v7.js";
import {OnboardingRepository} from "../onboarding/repository.js";
import {withServingGeneration} from "../db/serving.js";

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
    private readonly remote:RemoteConnectionReview,private readonly base:string,private readonly hooks:FederationHooks){}

  private bytes(value:unknown,max=16384){
    if(typeof value!=="string"||value.length>Math.ceil(max*4/3))throw new ConnectionError(400,"Invalid connection proof.");
    try{const bytes=decodeBase64Url(value);if(!bytes.length||bytes.length>max||encodeBase64Url(bytes)!==value)throw new Error();return bytes;}
    catch{throw new ConnectionError(400,"Invalid connection proof.");}
  }
  private fields(value:Record<string,unknown>,keys:string[]){if(!value||typeof value!=="object"||Array.isArray(value)||Object.keys(value).sort().join(",")!==keys.sort().join(","))throw new ConnectionError(400);}
  private async verify(bytes:Uint8Array,operation:Control["operation"],fresh=false){
    const payload=inspectSignedPayload("hail.connection-control",bytes).payload;
    if(payload.operation!==operation)throw new ConnectionError(400,"Connection control purpose differs.");
    const state=await this.resolver.resolve(payload.from);
    await requireFreshPublicAuthority(this.sql,state.evidence,{did:payload.from,role:"hail-messaging",key:state.messagingDidKey,serviceBase:state.serviceBase},new Date());
    await verifySignedPayload("hail.connection-control",bytes,createWebCryptoVerifier(async kid=>{
      if(kid!==payload.from+"#hail-messaging")throw new ConnectionError(400);return ed25519PublicKeyFromDidKey(state.messagingDidKey);
    }));
    if(payload.issued_at>now()+300||fresh&&(payload.expires_at===null||payload.expires_at<=now()))throw new ConnectionError(410,"Connection transport approval expired.");
    return payload;
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
  private async transaction<T>(owner:ConnectionOwner,fn:(tx:SQL)=>Promise<T>){
    return withServingGeneration(owner.id,Number(owner.generation),()=>this.sql.begin(async tx=>{
      await tx`SELECT id FROM provider_accounts WHERE id=${owner.id} FOR UPDATE`;
      const current=await this.hooks.owner(tx,owner.id);if(current.did!==owner.did||Number(current.generation)!==Number(owner.generation))throw new ConnectionError(409);
      await tx`SELECT hail_assert_unfenced_account(${owner.id}::uuid)`;return fn(tx as SQL);
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
    if(inviter.did!==invitation.from||scanner.did!==confirmation.from||inviter.serviceBase===scanner.serviceBase||confirmation.to!==invitation.from||
      confirmation.invitation_id!==invitation.invitation_id||!equal(confirmation.invitation_hash.value,hash(b.invitation)))throw new ConnectionError(400,"Connection consent linkage differs.");
    const verifier=(did:string,key:string)=>createWebCryptoVerifier(async kid=>{if(kid!==did+"#hail-identity")throw new ConnectionError(400);return ed25519PublicKeyFromDidKey(key);});
    await verifySignedPayload("hail.connection-invitation",b.invitation,verifier(inviter.did,inviter.identityDidKey));
    await verifySignedPayload("hail.connection-confirmation",b.confirmation,verifier(scanner.did,scanner.identityDidKey));
    const ib=(await verifySignedPayload("hail.address-binding",b.inviterBinding,verifier(inviter.did,inviter.identityDidKey))).payload;
    const sb=(await verifySignedPayload("hail.address-binding",b.scannerBinding,verifier(scanner.did,scanner.identityDidKey))).payload;
    if(ib.did!==inviter.did||sb.did!==scanner.did||invitation.issued_at>now()+300||confirmation.issued_at>now()+300||ib.issued_at>now()+300||sb.issued_at>now()+300||
      fresh&&(confirmation.expires_at<=now()||invitation.expires_at!==null&&invitation.expires_at<=now()||ib.expires_at<=now()||sb.expires_at<=now()))throw new ConnectionError(410,"Connection consent or address proof expired.");
    const snapshot=await this.verify(b.snapshot,"snapshot");
    const [small,large]=[inviter.did,scanner.did].sort();
    if(snapshot.from!==small||snapshot.to!==large||snapshot.request_id!==confirmation.confirmation_id||!equal(snapshot.proof_hash.value,EMPTY))throw new ConnectionError(400,"Connection epoch proposal differs.");
    for(const state of [inviter,scanner])await requireFreshPublicAuthority(this.sql,state.evidence,{did:state.did,role:"hail-identity",key:state.identityDidKey,serviceBase:state.serviceBase},new Date());
    return {b,invitation,confirmation,inviter,scanner,ib,sb,snapshot,proof:hash(bytes)};
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
    const owner=await this.hooks.owner(this.sql,session.account_id),proof=await this.remote.proof(input);
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
    await this.verifyBundle(bytes,true);
    await tx`INSERT INTO federated_connection_attempts(id,account_id,pair_id,direction,bundle,proof_digest,token_ciphertext,token_nonce,state,expires_at)
      VALUES(${id},${owner.id},${pair.id},'outbound',${bytes},${hash(bytes)},${ciphertext},${nonce},'pending',${new Date(draft.confirmation.expires_at*1000)})`;
    return {attemptId:id,state:"connecting",connectionId:null};
  }
  async active(session:AccountApiSession,id:string){
    return (await this.sql<Pair[]>`SELECT p.* FROM federated_connection_pairs p WHERE account_id=${session.account_id} AND connection_id=${id} AND state='active'
      AND NOT EXISTS(SELECT 1 FROM federated_connection_tombstones t WHERE t.pair_id=p.id AND t.connection_id=p.connection_id)`)[0]??null;
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
    return {connections:active.map(p=>({id:p.connection_id!,did:p.peer_did,address:p.peer_address,connectedAt:p.updated_at.toISOString(),remote:true})),
      pendingConnections:[...new Map(pending.map(p=>[p.kind+":"+p.peer_did,{id:p.id,did:p.peer_did,address:p.peer_address,kind:p.kind,state:p.state}])).values()]};
  }

  async handle(step:"state"|"admit"|"commit"|"disconnect"|"sync",wire:Record<string,unknown>):Promise<Record<string,unknown>>{
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
          const v=await this.verifyBundle(bytes,false),admission=await this.verify(admissionBytes,"admission");this.matches(admission,v,v.inviter.did);
          this.activation(control,v);
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
        const existing=(await tx<Attempt[]>`SELECT * FROM federated_connection_attempts WHERE id=${control.request_id}`)[0];
        if(existing){if(existing.pair_id!==pair.id||!equal(existing.proof_digest,proof))throw new ConnectionError(409);return {control:encodeBase64Url(existing.admission_cose!)};}
        if(v.confirmation.expires_at<=now()||v.invitation.expires_at!==null&&v.invitation.expires_at<=now())throw new ConnectionError(410);
        const admission=await this.sign(tx,owner,{operation:"admission",to:peer,request_id:control.request_id,connection_id:v.snapshot.connection_id,epoch:v.snapshot.epoch,state:v.snapshot.state,proof_hash:{algorithm:"sha-256",value:proof}});
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
    await tx`INSERT INTO federated_connection_outbox(id,account_id,event_id) VALUES(${uuidV7()},${pair.account_id},${event.id})`;
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
      const out=(await this.sql<{id:string;event_id:string;account_id:string}[]>`SELECT * FROM federated_connection_outbox WHERE ack_cose IS NULL AND next_attempt_at<=clock_timestamp() ORDER BY attempts,id LIMIT 1`)[0];
      if(out){await this.workOutbox(out);return true;}
      const attempt=(await this.sql<Attempt[]>`SELECT * FROM federated_connection_attempts WHERE direction='outbound' AND state='pending' AND next_attempt_at<=clock_timestamp() ORDER BY attempts,id LIMIT 1`)[0];
      if(!attempt)return false;await this.workAttempt(attempt);return true;
    }finally{try{if(locked)await lock`SELECT pg_advisory_unlock(684245164)`;}finally{lock.release();}}
  }
  private async defer(table:"federated_connection_attempts"|"federated_connection_disconnects"|"federated_connection_outbox",id:string){
    // Table names are a closed internal union, never wire input.
    await this.sql.unsafe(`UPDATE ${table} SET attempts=attempts+1,next_attempt_at=clock_timestamp()+make_interval(secs=>LEAST(3600,power(2,LEAST(attempts+1,12))::integer)) WHERE id=$1`,[id]);
  }
  private async workAttempt(attempt:Attempt){
    const owner=await this.hooks.owner(this.sql,attempt.account_id),pair=await this.pairById(this.sql,attempt.pair_id,owner);
    try{
      const v=await this.verifyBundle(new Uint8Array(attempt.bundle),false);
      if(v.inviter.serviceBase!==pair.peer_service_base||v.scanner.serviceBase!==this.base)throw new ConnectionError(409,"Provider location changed after review.");
      let admissionBytes:Uint8Array|null=attempt.admission_cose?new Uint8Array(attempt.admission_cose):null;
      if(!admissionBytes){
        if(attempt.expires_at.getTime()<=Date.now()){await this.sql`UPDATE federated_connection_attempts SET state='expired' WHERE id=${attempt.id} AND state='pending'`;return;}
        const offer=await this.transaction(owner,tx=>this.sign(tx,owner,{operation:"offer",to:pair.peer_did,request_id:attempt.id,connection_id:v.snapshot.connection_id,
          epoch:v.snapshot.epoch,state:v.snapshot.state,proof_hash:{algorithm:"sha-256",value:attempt.proof_digest}}));
        const token=await this.encryptor.decryptConnectionToken(owner.id,attempt.id,{ciphertext:attempt.token_ciphertext!,nonce:attempt.token_nonce!,encryptionVersion:1,kekId:"poc-v1"});
        let response:Record<string,unknown>;
        try{response=await this.send(pair.peer_did,"admit",{control:encodeBase64Url(offer),bundle:encodeBase64Url(attempt.bundle),token:encodeBase64Url(token)});}finally{token.fill(0);}
        admissionBytes=this.bytes(response.control);this.matches(await this.verify(admissionBytes,"admission"),v,v.inviter.did);
        await this.sql`UPDATE federated_connection_attempts SET admission_cose=${admissionBytes} WHERE id=${attempt.id} AND admission_cose IS NULL`;
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
        await tx`UPDATE federated_connection_attempts SET result_cose=${bytes},state='active' WHERE id=${attempt.id} AND state='pending'`;
      });
    }catch(error){
      const status=error instanceof ConnectionError||error instanceof RemoteConnectionError?error.status:503;
      if([400,403,404,409,410].includes(status))await this.sql`UPDATE federated_connection_attempts SET state=${status===410?"expired":"conflict"} WHERE id=${attempt.id} AND state='pending'`;
      else await this.defer("federated_connection_attempts",attempt.id);
    }
  }
  private async workDisconnect(d:{id:string;account_id:string;pair_id:string;connection_id:string;epoch:number|string}){
    const owner=await this.hooks.owner(this.sql,d.account_id),pair=await this.pairById(this.sql,d.pair_id,owner);
    try{
      const request=await this.transaction(owner,tx=>this.sign(tx,owner,{operation:"disconnect",to:pair.peer_did,request_id:d.id,connection_id:d.connection_id,epoch:Number(d.epoch),state:"active",proof_hash:digest(encoded({connection_id:d.connection_id}))}));
      const response=await this.send([owner.did,pair.peer_did].sort()[0]!,"disconnect",{control:encodeBase64Url(request)}),bytes=this.bytes(response.control),snapshot=await this.verify(bytes,"snapshot");
      if(snapshot.request_id!==d.id||snapshot.state!=="disconnected"||snapshot.connection_id!==d.connection_id||!equal(snapshot.proof_hash.value,hash(encoded({connection_id:d.connection_id}))))throw new ConnectionError(409);
      await this.transaction(owner,async tx=>{await this.apply(tx,await this.pairById(tx,pair.id,owner),snapshot);await tx`UPDATE federated_connection_disconnects SET result_cose=${bytes} WHERE id=${d.id} AND result_cose IS NULL`;});
    }catch{await this.defer("federated_connection_disconnects",d.id);}
  }
  private async workOutbox(job:{id:string;event_id:string;account_id:string}){
    const owner=await this.hooks.owner(this.sql,job.account_id),original=(await this.sql<Event[]>`SELECT * FROM federated_connection_events WHERE id=${job.event_id}`)[0]!,pair=await this.pairById(this.sql,original.pair_id,owner);
    const event=Number(pair.epoch)>Number(original.epoch)?(await this.sql<Event[]>`SELECT * FROM federated_connection_events WHERE pair_id=${pair.id} AND epoch=${pair.epoch}`)[0]!:original;
    try{
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
    }catch{await this.defer("federated_connection_outbox",job.id);}
  }
}
