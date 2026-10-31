import {previousAddressIdentities} from "./identity-history.js";
import {createHash,randomBytes,timingSafeEqual} from "node:crypto";
import type {SQL} from "bun";
import type {AuthenticationResponseJSON} from "@simplewebauthn/server";
import {createWebCryptoSigner,createWebCryptoVerifier,decodeBase64Url,decodeDeterministic,encodeBase64Url,
  encodeDeterministic,toDiagnosticJson,signPayload,verifySignedPayload,type HailConnectionConfirmation,
  type HailConnectionInvitation,type HailPayloadByType,type HailSignedPayloadType} from "@hailproto/codec";
import {OnboardingRepository} from "../onboarding/repository.js";
import type {HailDidResolver} from "../plc/resolver.js";
import {requireFreshPublicAuthority} from "../plc/authority.js";
import {ed25519PublicKeyFromDidKey} from "../identity/did-key.js";
import {importEd25519PrivateKey} from "../identity/keys.js";
import type {KeyEncryptor} from "../identity/key-encryption.js";
import {uuidV7} from "../identity/uuid-v7.js";
import {withServingGeneration} from "../db/serving.js";
import type {AccountApiSession} from "./repository.js";
import type {PasskeyAuth} from "./passkeys.js";
import type {RemoteConnectionReview} from "./connection-review.js";
import {ConnectionFederation} from "./connection-federation.js";
import {ConnectionError} from "./connection-error.js";
export {ConnectionError} from "./connection-error.js";

const UUID=/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/;
const DID=/^did:plc:[a-z2-7]{24}$/;
const hash=(bytes:Uint8Array)=>new Uint8Array(createHash("sha256").update(bytes).digest());
const digest=(bytes:Uint8Array)=>({algorithm:"sha-256" as const,value:hash(bytes)});
const same=(a:Uint8Array,b:Uint8Array)=>a.length===b.length&&timingSafeEqual(a,b);
const now=()=>Math.floor(Date.now()/1000);
export interface ConnectionOwner {id:string;did:string;canonical_address:string;generation:number|string;managed:boolean;identity_key:string;}
type Owner=ConnectionOwner;
interface DisconnectSelection {connectionId:string;pairId:string;epoch:number;did:string;address:string;operationId:string;}
interface Invitation {id:string;account_id:string;serving_generation:number|string;did:string;personal:boolean;label:string;
  token_hash:Uint8Array;ciphertext:Uint8Array;nonce:Uint8Array;cose:Uint8Array;signing_key:string;expires_at:number|string|null;revoked_at:Date|null;created_at:Date;}
interface Approval {id:string;action:string;connection_id:string|null;invitation_id:string|null;request_digest:Uint8Array;intent_bytes:Uint8Array;
  actor_key:string;peer_key:string|null;actor_binding:Uint8Array|null;peer_binding:Uint8Array|null;challenge:string;expires_at:Date;result:unknown;
  owner_payload:Uint8Array|null;token_ciphertext:Uint8Array|null;token_nonce:Uint8Array|null;
  federated_pair_id:string|null;remote_bundle:Uint8Array|null;remote_token_ciphertext:Uint8Array|null;remote_token_nonce:Uint8Array|null;}

// All connections use the same signed consent/control model, independent of provider placement.
export class AccountConnections {
  readonly federation:ConnectionFederation;
  constructor(private readonly sql:SQL,private readonly encryptor:KeyEncryptor,private readonly resolver:HailDidResolver,
    private readonly passkeys:Pick<PasskeyAuth,"actionOptions"|"approveAction">,private readonly origin:string,private readonly remote?:RemoteConnectionReview){
    this.federation=new ConnectionFederation(sql,encryptor,resolver,remote,origin+"/hail",{
      owner:(tx,id)=>this.owner(tx,id),live:(tx,session)=>this.live(tx,session),authority:(tx,owner,key)=>this.authority(tx,owner,key),
      binding:(tx,owner,key)=>this.binding(tx,owner,key),invitation:async(tx,input)=>{
        const row=await this.invitation(tx,input.id),owner=await this.checkInvitation(tx,row,input.token,input.did);
        return {owner,cose:new Uint8Array(row.cose),createdAt:row.created_at};
      },
    });
  }

  private async live(tx:SQL,session:AccountApiSession){
    if(!session.passkey_credential_id){
      if(!session.scopes.includes("account:write"))throw new ConnectionError(403,"Connection consent requires account:write and a local identity signature.");
      const valid=await tx`SELECT c.id FROM account_api_credentials c
        JOIN account_credential_generations b ON b.credential_id=c.id
        JOIN account_serving_generations g ON g.account_id=c.account_id AND g.generation=b.generation
        WHERE c.id=${session.credential_id} AND c.account_id=${session.account_id}
          AND c.revoked_at IS NULL AND c.expires_at>clock_timestamp() AND c.scopes ? 'account:write'
          AND g.generation=${session.serving_generation??1}`;
      const owner=await this.owner(tx,session.account_id);
      if(!valid.length||owner.did!==session.did||owner.managed)throw new ConnectionError(403,"CLI consent requires current owner-controlled account access; managed consent requires a passkey.");
      await tx`SELECT hail_assert_unfenced_account(${session.account_id}::uuid)`;
      return;
    }
    const rows=await tx`SELECT s.id FROM account_passkey_sessions s JOIN provider_accounts a ON a.id=s.account_id
      JOIN account_serving_generations g ON g.account_id=a.id
      JOIN account_passkeys k ON k.credential_id=s.credential_id AND k.account_id=a.id
      WHERE s.id=${session.credential_id} AND a.id=${session.account_id} AND a.did=${session.did}
        AND a.onboarding_state='active' AND a.activation_verification_mode='public' AND s.serving_generation=g.generation
        AND g.generation=${session.serving_generation??1} AND k.serving_generation=g.generation AND k.revoked_at IS NULL
        AND s.revoked_at IS NULL AND s.expires_at>clock_timestamp() AND s.last_seen_at>clock_timestamp()-interval '30 minutes'
        AND s.credential_id=${session.passkey_credential_id}`;
    if(!rows.length)throw new ConnectionError(403,"Current account access is required.");
    await this.owner(tx,session.account_id);
    await tx`SELECT hail_assert_unfenced_account(${session.account_id}::uuid)`;
  }
  private async owner(tx:SQL,id:string){
    const row=(await tx<Owner[]>`SELECT a.id,a.did,a.canonical_address,g.generation,m.account_id IS NOT NULL AS managed,
      COALESCE(m.provider_identity_public_key,p.user_identity_public_key) AS identity_key FROM provider_accounts a
      JOIN account_serving_generations g ON g.account_id=a.id
      LEFT JOIN managed_custody_evidence m ON m.account_id=a.id LEFT JOIN portable_custody_evidence p ON p.account_id=a.id
      WHERE a.id=${id} AND a.onboarding_state='active' AND a.activation_verification_mode='public'
        AND ((m.account_id IS NOT NULL AND p.account_id IS NULL) OR (p.account_id IS NOT NULL AND m.account_id IS NULL
          AND NOT EXISTS(SELECT 1 FROM account_keys WHERE account_id=a.id AND role='hail-identity')))`)[0];
    if(!row)throw new ConnectionError(409,"This preview requires active managed or owner-controlled accounts on this provider.");return row;
  }
  private async authority(tx:SQL,owner:Owner,expected?:string){
    await tx`SELECT hail_assert_unfenced_account(${owner.id}::uuid)`;
    const resolved=await this.resolver.resolve(owner.did),key=owner.managed?await new OnboardingRepository(tx).getKey(owner.id,"hail-identity"):null;
    if(resolved.did!==owner.did||resolved.serviceBase!==this.origin+"/hail"||resolved.identityDidKey!==owner.identity_key||
      key&&key.publicKey!==owner.identity_key||expected&&expected!==owner.identity_key)
      throw new ConnectionError(409,"Identity signing authority changed. Review a current code.");
    await requireFreshPublicAuthority(tx,resolved.evidence,{did:owner.did,role:"hail-identity",key:owner.identity_key,serviceBase:this.origin+"/hail"},new Date());
    return {key,resolved};
  }
  private async sign<T extends HailSignedPayloadType>(tx:SQL,owner:Owner,type:T,payload:HailPayloadByType[T],expected:string){
    const {key,resolved}=await this.authority(tx,owner,expected);
    if(!key)throw new ConnectionError(403,"Your identity key must sign this consent locally; the provider cannot substitute its own key.");
    const raw=await this.encryptor.decrypt(owner.id,key.role,key.algorithm,key.publicKey,key);
    try{return {cose:await signPayload(type,payload,createWebCryptoSigner(owner.did+"#hail-identity",await importEd25519PrivateKey(raw))),evidence:resolved.evidence};}
    finally{raw.fill(0);}
  }
  private async signedConsent<T extends "hail.connection-invitation"|"hail.connection-confirmation">(
    tx:SQL,owner:Owner,type:T,payload:HailPayloadByType[T],key:string,external?:Uint8Array){
    if(owner.managed){if(external)throw new ConnectionError(400,"Managed consent does not accept an external identity signature.");return this.sign(tx,owner,type,payload,key);}
    if(!external||external.length>16384)throw new ConnectionError(403,"Sign the downloaded consent with your local identity key, then upload the signed COSE file.");
    const {resolved}=await this.authority(tx,owner,key);
    try{
      const checked=await verifySignedPayload(type,external,createWebCryptoVerifier(async kid=>{
        if(kid!==owner.did+"#hail-identity")throw new Error("Wrong consent signer");return ed25519PublicKeyFromDidKey(key);
      }));
      if(!same(encodeDeterministic(checked.payload as never),encodeDeterministic(payload as never)))throw new Error("Consent changed");
    }catch{throw new ConnectionError(400,"The signature must cover this exact reviewed consent using the current identity key.");}
    return {cose:external,evidence:resolved.evidence};
  }
  private async binding(tx:SQL,owner:Owner,key:string){
    const row=(await tx<{cose:Uint8Array}[]>`SELECT cose FROM address_bindings WHERE account_id=${owner.id} AND did=${owner.did}
      AND canonical_address=${owner.canonical_address} AND selected_at IS NOT NULL ORDER BY selected_at DESC,id DESC LIMIT 1`)[0];
    if(!row)throw new ConnectionError(409,"A current verified address binding is required.");
    const checked=await verifySignedPayload("hail.address-binding",new Uint8Array(row.cose),createWebCryptoVerifier(async kid=>{
      if(kid!==owner.did+"#hail-identity")throw new ConnectionError(409);return ed25519PublicKeyFromDidKey(key);
    }));
    if(checked.payload.address!==owner.canonical_address||checked.payload.did!==owner.did||checked.payload.issued_at>now()+300)
      throw new ConnectionError(409,"The account's address binding is not currently authorized.");
    return new Uint8Array(row.cose);
  }
  private async invitation(tx:SQL,id:unknown){
    if(typeof id!=="string"||!UUID.test(id))throw new ConnectionError(400,"Invalid invitation.");
    const row=(await tx<Invitation[]>`SELECT * FROM connection_invitations WHERE id=${id}`)[0];
    if(!row)throw new ConnectionError(410,"This code is unavailable. Ask for a current one.");return row;
  }
  private async checkInvitation(tx:SQL,row:Invitation,token:unknown,pinned:unknown){
    if(typeof token!=="string"||!/^[A-Za-z0-9_-]{43}$/.test(token)||typeof pinned!=="string"||!DID.test(pinned))throw new ConnectionError(400,"Invalid connection code.");
    const raw=decodeBase64Url(token,32);
    if(encodeBase64Url(raw)!==token||!same(hash(raw),row.token_hash))throw new ConnectionError(410,"This code is unavailable. Ask for a current one.");
    if(row.revoked_at||row.expires_at!==null&&Number(row.expires_at)<=now())throw new ConnectionError(410,"This code was revoked or expired.");
    const owner=await this.owner(tx,row.account_id);
    if(owner.did!==pinned||row.did!==pinned||Number(owner.generation)!==Number(row.serving_generation))throw new ConnectionError(409,"The code's identity or provider generation changed.");
    await this.authority(tx,owner,row.signing_key);
    const checked=await verifySignedPayload("hail.connection-invitation",new Uint8Array(row.cose),createWebCryptoVerifier(async kid=>{
      if(kid!==owner.did+"#hail-identity")throw new ConnectionError(409);return ed25519PublicKeyFromDidKey(row.signing_key);
    }));
    if(checked.payload.invitation_id!==row.id||checked.payload.from!==owner.did||!same(checked.payload.token_hash.value,row.token_hash)||
      checked.payload.expires_at!==(row.expires_at===null?null:Number(row.expires_at)))throw new ConnectionError(409);
    return owner;
  }
  private async pairTransaction<T>(session:AccountApiSession,peerId:string|undefined,operation:(tx:SQL)=>Promise<T>){
    const peer=peerId?await this.owner(this.sql,peerId):undefined;
    // ponytail: signing holds pair locks; prepare proofs outside the transaction if preview contention becomes material.
    const run=()=>this.sql.begin(async tx=>{
      // Lock account rows in one order across invitations, admission and disconnect.
      await tx`SELECT id FROM provider_accounts WHERE id=${session.account_id} OR id=${peerId??session.account_id} ORDER BY id FOR UPDATE`;
      await this.live(tx,session);if(peer)await tx`SELECT hail_assert_unfenced_account(${peer.id}::uuid)`;
      return operation(tx as SQL);
    });
    return peer?withServingGeneration(peer.id,Number(peer.generation),run):run();
  }
  async credentialConnections(session:AccountApiSession,connectionId?:string,invitations=false){
    const scope=connectionId===undefined?"account:read":"account:write";
    if(session.passkey_credential_id||!session.scopes.includes(scope))throw new ConnectionError(403,undefined,"MISSING_SCOPE");
    if(connectionId!==undefined&&!UUID.test(connectionId))throw new ConnectionError(400);
    return this.sql.begin(async tx=>{
      await tx`SELECT id FROM provider_accounts WHERE id=${session.account_id} FOR UPDATE`;
      const valid=await tx`SELECT c.id FROM account_api_credentials c
        JOIN account_credential_generations b ON b.credential_id=c.id
        JOIN account_serving_generations g ON g.account_id=c.account_id AND g.generation=b.generation
        WHERE c.id=${session.credential_id} AND c.account_id=${session.account_id}
          AND c.revoked_at IS NULL AND c.expires_at>clock_timestamp()
          AND c.scopes ? ${scope} AND g.generation=${session.serving_generation??1}`;
      if(!valid.length)throw new ConnectionError(403);
      const owner=await this.owner(tx as SQL,session.account_id);
      await tx`SELECT hail_assert_unfenced_account(${session.account_id}::uuid)`;
      if(invitations){
        if(connectionId!==undefined){
          const rows=await tx`UPDATE connection_invitations SET revoked_at=COALESCE(revoked_at,clock_timestamp()) WHERE account_id=${session.account_id} AND id=${connectionId} RETURNING id`;
          if(!rows.length)throw new ConnectionError(404);
          return {invitationId:connectionId,revoked:true};
        }
        const rows=await tx<{id:string;label:string;personal:boolean;expires_at:number|string|null}[]>`SELECT id,label,personal,expires_at FROM connection_invitations WHERE account_id=${session.account_id} AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at>extract(epoch FROM clock_timestamp())) ORDER BY id LIMIT 1001`;
        return {invitations:rows.slice(0,1000).map(r=>({invitationId:r.id,label:r.label,personal:r.personal,expiresAt:r.expires_at===null?null:Number(r.expires_at)})),truncated:rows.length>1000};
      }
      if(connectionId===undefined)return this.federation.list(session.account_id);
      // A retry can only acknowledge this account's own terminal operation.
      const prior=await tx`SELECT id FROM federated_connection_disconnects
        WHERE account_id=${session.account_id} AND connection_id=${connectionId}`;
      if(prior.length)return {connectionId,state:"disconnected"};
      const pair=await this.federation.active(session,connectionId);
      if(!pair)throw new ConnectionError(404);
      return this.federation.disconnect(tx as SQL,owner,pair.id,connectionId,uuidV7());
    });
  }
  async list(session:AccountApiSession){
    return this.pairTransaction(session,undefined,async tx=>{
      const codes=await tx<Invitation[]>`SELECT * FROM connection_invitations WHERE account_id=${session.account_id} AND revoked_at IS NULL
        AND (expires_at IS NULL OR expires_at>extract(epoch FROM clock_timestamp())) ORDER BY personal DESC,id DESC LIMIT 21`;
      const connections=await this.federation.list(session.account_id);
      return {preview:true,codes:await Promise.all(codes.map(async row=>{
        const token=await this.encryptor.decryptConnectionToken(row.account_id,row.id,{ciphertext:row.ciphertext,nonce:row.nonce,encryptionVersion:1,kekId:"poc-v1"});
        try{return {id:row.id,personal:row.personal,label:row.label,expiresAt:row.expires_at===null?null:Number(row.expires_at),
          link:this.origin+"/connect#"+new URLSearchParams({id:row.id,did:row.did,token:encodeBase64Url(token)}).toString()};}finally{token.fill(0);}
      })),...connections};
    });
  }
  async review(session:AccountApiSession,input:Record<string,unknown>){
    this.keys(input,["id","did","token"]);
    await this.live(this.sql,session);
    if(this.remote&&typeof input.id==="string"&&UUID.test(input.id)&&typeof input.did==="string"&&DID.test(input.did)&&typeof input.token==="string"&&
      !(await this.sql`SELECT id FROM connection_invitations WHERE id=${input.id}`).length){
      if(input.did===session.did)throw new ConnectionError(400,"This is your own identity.");
      try{return await this.remote.review(input as {id:string;did:string;token:string});}
      catch{throw new ConnectionError(409,"The remote code could not be verified. It may be expired, revoked, or from a provider without connection review support.");}
    }
    const row=await this.invitation(this.sql,input.id);
    return this.pairTransaction(session,row.account_id,async tx=>{
      const current=await this.invitation(tx,row.id),owner=await this.checkInvitation(tx,current,input.token,input.did);
      if(owner.id===session.account_id)throw new ConnectionError(400,"This is your own connection code.");
      return {id:row.id,did:owner.did,address:owner.canonical_address,expiresAt:current.expires_at===null?null:Number(current.expires_at),preview:true};
    });
  }
  async exportInvitation(input:Record<string,unknown>){
    this.keys(input,["id","did","token"]);
    const row=await this.invitation(this.sql,input.id),owner=await this.owner(this.sql,row.account_id);
    return withServingGeneration(owner.id,Number(owner.generation),()=>this.sql.begin(async tx=>{
      await tx`SELECT id FROM provider_accounts WHERE id=${owner.id} FOR UPDATE`;
      const current=await this.invitation(tx,row.id),checked=await this.checkInvitation(tx,current,input.token,input.did);
      return {type:"hail.connection-review",version:1,invitation:encodeBase64Url(current.cose),binding:encodeBase64Url(await this.binding(tx,checked,current.signing_key)),...(this.federation?{federation:1}:{})};
    }));
  }
  private keys(input:Record<string,unknown>,keys:string[]){
    if(Object.keys(input).length!==keys.length||Object.keys(input).some(key=>!keys.includes(key)))throw new ConnectionError(400,"Invalid connection request.");
  }
  private async approval(tx:SQL,session:AccountApiSession,id:string){
    const row=(await tx<Approval[]>`SELECT * FROM connection_approvals WHERE id=${id} AND account_id=${session.account_id}
      AND ((${Boolean(session.passkey_credential_id)} AND session_id=${session.credential_id}) OR
        (${!session.passkey_credential_id} AND api_credential_id=${session.credential_id})) AND serving_generation=${session.serving_generation??1}`)[0];
    if(!row)throw new ConnectionError(404);return row;
  }
  private async summary(session:AccountApiSession,row:Approval){
    const intent=decodeDeterministic(new Uint8Array(row.intent_bytes)) as Record<string,unknown>;
    const {token,confirmation,...review}=intent; // Expose review fields, not admission secrets or internal proof bytes.
    if(row.action==="connect"&&typeof review.address==="string"&&typeof review.did==="string")
      review.previousDids=await previousAddressIdentities(this.sql,session.account_id,review.address,review.did);
    const payload=row.owner_payload?decodeDeterministic(new Uint8Array(row.owner_payload)) as unknown as HailConnectionInvitation|HailConnectionConfirmation:null;
    let result=typeof row.result==="string"?JSON.parse(row.result):row.result;
    if(result&&typeof result==="object"&&"attemptId" in result&&typeof result.attemptId==="string"&&this.federation)result=await this.federation.result(session.account_id,result.attemptId);
    let invitation;
    if(!session.passkey_credential_id&&row.action==="create"&&result?.invitationId){
      const code=await this.invitation(this.sql,result.invitationId);
      if(code.account_id!==session.account_id||code.revoked_at||code.expires_at!==null&&Number(code.expires_at)<=now())
        throw new ConnectionError(410,"The retained invitation is expired or revoked.");
      const token=await this.encryptor.decryptConnectionToken(code.account_id,code.id,{ciphertext:code.ciphertext,nonce:code.nonce,encryptionVersion:1,kekId:"poc-v1"});
      try{invitation={type:"hailp.connection-invitation",version:1,id:code.id,did:code.did,token:encodeBase64Url(token)};}finally{token.fill(0);}
    }
    return {requestId:row.id,action:row.action==="disconnect"&&Array.isArray(intent.connections)?"disconnect-batch":row.action,review,expiresAt:row.expires_at.toISOString(),result,
      ...(invitation?{invitation}:{}),
      ownerSigning:payload?{type:"hailp.connection-signing",version:1,provider:this.origin,requestId:row.id,expiresAt:row.expires_at.toISOString(),payload:toDiagnosticJson(payload.type,payload)}:null,
      options:!session.passkey_credential_id||row.result||row.expires_at.getTime()<=Date.now()?null:await this.passkeys.actionOptions(session,row.challenge)};
  }
  async status(session:AccountApiSession,id:string){
    if(!UUID.test(id))throw new ConnectionError(400);await this.live(this.sql,session);return this.summary(session,await this.approval(this.sql,session,id));
  }
  async prepare(session:AccountApiSession,input:Record<string,unknown>){
    if(typeof input.requestId!=="string"||!UUID.test(input.requestId)||typeof input.action!=="string")throw new ConnectionError(400);
    const action=input.action,batch=action==="disconnect"&&Array.isArray(input.connectionIds);
    if(!session.passkey_credential_id&&!["create","connect"].includes(action))throw new ConnectionError(403,"CLI approvals support only owner-signed invitation creation and acceptance.");
    this.keys(input,action==="create"?["requestId","action","personal","label","expiresAt"]:
      action==="connect"?["requestId","action","id","did","token"]:action==="replace"||action==="revoke"?["requestId","action","id"]:
      action==="disconnect"?(batch?["requestId","action","connectionIds"]:["requestId","action","connectionId"]):[]);
    const requestId=input.requestId,requestDigest=hash(encodeDeterministic(input as never));
    // A retained retry never creates a new connection epoch.
    await this.live(this.sql,session);
    const prior=(await this.sql`SELECT id FROM connection_approvals WHERE id=${requestId}`)[0];
    if(prior){const row=await this.approval(this.sql,session,requestId);if(!same(row.request_digest,requestDigest))throw new ConnectionError(409);return this.summary(session,row);}
    let invitation:Invitation|undefined;
    let remoteDraft:Awaited<ReturnType<ConnectionFederation["prepare"]>>|undefined,remotePair:Awaited<ReturnType<ConnectionFederation["active"]>>=null;
    if(action==="connect"){
      if(typeof input.id!=="string"||!UUID.test(input.id)||typeof input.did!=="string"||!DID.test(input.did)||typeof input.token!=="string"||!/^[A-Za-z0-9_-]{43}$/.test(input.token))throw new ConnectionError(400,"Invalid connection code.");
      remoteDraft=await this.federation.prepare(session,{id:input.id,did:input.did as string,token:input.token as string});
    }else if(["replace","revoke"].includes(action))invitation=await this.invitation(this.sql,input.id);
    const disconnects:DisconnectSelection[]=[];
    if(batch){
      const ids=input.connectionIds as unknown[];
      if(!ids.length||ids.length>100||ids.some(id=>typeof id!=="string"||!UUID.test(id))||new Set(ids).size!==ids.length)throw new ConnectionError(400,"Select between 1 and 100 distinct connections.");
      for(const id of ids as string[]){
        const pair=await this.federation.active(session,id);if(!pair)throw new ConnectionError(409,"A selected connection changed. Refresh and review the selection again.");
        disconnects.push({connectionId:id,pairId:pair.id,epoch:Number(pair.epoch),did:pair.peer_did,address:pair.peer_address,operationId:uuidV7()});
      }
    }else if(action==="disconnect"){
      if(typeof input.connectionId!=="string"||!UUID.test(input.connectionId))throw new ConnectionError(400);
      remotePair=await this.federation.active(session,input.connectionId);if(!remotePair)throw new ConnectionError(404);
    }
    const saved=await this.pairTransaction(session,undefined,async tx=>{
      if((await tx`SELECT id FROM connection_approvals WHERE account_id=${session.account_id} AND expires_at>clock_timestamp() AND result IS NULL`).length>=20)
        throw new ConnectionError(429,"Too many pending reviews. Wait five minutes.");
      const actor=await this.owner(tx,session.account_id);await this.authority(tx,actor);
      let ownerPayload:Uint8Array|null=null,pendingToken:{ciphertext:Uint8Array;nonce:Uint8Array}|null=null;
      let peerKey:string|null=null,actorBinding:Uint8Array|null=null,peerBinding:Uint8Array|null=null;
      let intent:Record<string,unknown>={...input};
      if(action==="create"){
        if(typeof input.personal!=="boolean"||typeof input.label!=="string"||!input.label.trim()||input.label.length>80||input.personal&&input.expiresAt!==null)throw new ConnectionError(400);
        if(!input.personal&&(!Number.isSafeInteger(input.expiresAt)||Number(input.expiresAt)<=now()||Number(input.expiresAt)>now()+366*86400))
          throw new ConnectionError(400,"Choose an expiration within one year.");
      }else if(action==="replace"||action==="revoke"){
        invitation=await this.invitation(tx,input.id);
        if(invitation.account_id!==session.account_id||action==="replace"&&!invitation.personal)throw new ConnectionError(404);
      }else if(action==="connect"&&remoteDraft){
        peerKey=remoteDraft.peerKey;actorBinding=remoteDraft.actorBinding;peerBinding=remoteDraft.peerBinding;
        intent={action,id:input.id,did:input.did,address:remoteDraft.address,confirmation:remoteDraft.confirmation,remote:true};
        if(!actor.managed)ownerPayload=encodeDeterministic(remoteDraft.confirmation as never);
      }else if(action==="disconnect"){
        intent=batch?{action,connections:disconnects}:{...input,remote:true,operationId:uuidV7()};
      }
      if(!actor.managed&&(action==="create"||action==="replace")){
        if(action==="replace"&&invitation!.revoked_at)throw new ConnectionError(409,"Personal code already changed. Refresh the list.");
        const invitationId=uuidV7(),token=new Uint8Array(randomBytes(32));
        try{
          const payload:HailConnectionInvitation={type:"hail.connection-invitation",version:1,invitation_id:invitationId,from:actor.did,
            token_hash:digest(token),issued_at:now(),expires_at:action==="replace"?null:input.expiresAt as number|null,key_id:actor.did+"#hail-identity"};
          ownerPayload=encodeDeterministic(payload as never);
          pendingToken=await this.encryptor.encryptConnectionToken(actor.id,invitationId,token);
        }finally{token.fill(0);}
      }
      await tx`INSERT INTO connection_approvals(id,account_id,session_id,api_credential_id,serving_generation,action,connection_id,invitation_id,request_digest,intent_bytes,
        actor_key,peer_key,actor_binding,peer_binding,challenge,owner_payload,token_ciphertext,token_nonce,federated_pair_id,remote_bundle,remote_token_ciphertext,remote_token_nonce) VALUES(${requestId},${session.account_id},${session.passkey_credential_id?session.credential_id:null},${session.passkey_credential_id?null:session.credential_id},${session.serving_generation??1},${action},
        ${null},${invitation?.id??null},${requestDigest},${encodeDeterministic(intent as never)},${actor.identity_key},${peerKey},${actorBinding},${peerBinding},${encodeBase64Url(randomBytes(32))},${ownerPayload},${pendingToken?.ciphertext??null},${pendingToken?.nonce??null},
        ${remoteDraft?.pairId??remotePair?.id??null},${remoteDraft?.bytes??null},${remoteDraft?.ciphertext??null},${remoteDraft?.nonce??null})
        ON CONFLICT(id) DO NOTHING`;
      const row=await this.approval(tx,session,requestId);if(!same(row.request_digest,requestDigest))throw new ConnectionError(409);
      return row;
    });
    return this.summary(session,saved);
  }

  async commit(session:AccountApiSession,id:string,response?:AuthenticationResponseJSON,external?:Uint8Array){
    if(!UUID.test(id))throw new ConnectionError(400);await this.live(this.sql,session);
    const initial=await this.approval(this.sql,session,id);
    if(initial.result)return this.summary(session,initial);
    if(initial.connection_id)throw new ConnectionError(409,"This obsolete local approval cannot be resumed. Review a fresh code.");
    const saved=await this.pairTransaction(session,undefined,async tx=>{
      const row=await this.approval(tx,session,id);if(row.result)return row;
      if(row.expires_at.getTime()<=Date.now())throw new ConnectionError(410,"Approval expired. Review again.","APPROVAL_EXPIRED");
      if(session.passkey_credential_id&&!response)throw new ConnectionError(403,"Confirm this exact action with your passkey.");
      if(!session.passkey_credential_id&&(response||!row.owner_payload||!["create","connect"].includes(row.action)))throw new ConnectionError(403,"CLI consent requires the exact owner signature.");
      const intent=decodeDeterministic(new Uint8Array(row.intent_bytes)) as Record<string,unknown>;
      const actor=await this.owner(tx,session.account_id);await this.authority(tx,actor,row.actor_key);
      if(Boolean(row.owner_payload)!==Boolean(external))throw new ConnectionError(403,row.owner_payload?"This action also needs your locally signed consent file.":"This action does not accept an external consent file.");
      const ownerConfirmation=row.owner_payload&&row.action==="connect"?await this.signedConsent(tx,actor,"hail.connection-confirmation",
        decodeDeterministic(new Uint8Array(row.owner_payload)) as unknown as HailConnectionConfirmation,row.actor_key,external):null;
      const credential=session.passkey_credential_id?await this.passkeys.approveAction(tx,session,row.challenge,response!):null;
      let result:Record<string,unknown>;
      if(row.action==="disconnect"&&Array.isArray(intent.connections)){
        const selections=intent.connections as unknown as DisconnectSelection[];
        // All local cutoffs and their propagation jobs commit with the one
        // passkey assertion. A changed member rolls back the entire selection.
        for(const item of [...selections].sort((a,b)=>a.pairId.localeCompare(b.pairId))){
          const current=await tx`SELECT id FROM federated_connection_pairs p WHERE p.id=${item.pairId}
            AND p.account_id=${actor.id} AND p.connection_id=${item.connectionId} AND p.epoch=${item.epoch} AND p.state='active'
            AND NOT EXISTS(SELECT 1 FROM federated_connection_tombstones t WHERE t.pair_id=p.id AND t.connection_id=p.connection_id) FOR UPDATE`;
          if(!current.length)throw new ConnectionError(409,"A selected connection changed. No connections were removed; refresh and review again.");
          await this.federation.disconnect(tx,actor,item.pairId,item.connectionId,item.operationId);
        }
        result={connectionIds:selections.map(item=>item.connectionId),state:"disconnected",propagation:"pending"};
      }else if(row.federated_pair_id){
        if(!this.federation)throw new ConnectionError(409,"Cross-provider connection handling is unavailable.");
        if(row.action==="disconnect")result=await this.federation.disconnect(tx,actor,row.federated_pair_id,intent.connectionId as string,intent.operationId as string);
        else{
          const confirmed=ownerConfirmation??await this.signedConsent(tx,actor,"hail.connection-confirmation",intent.confirmation as unknown as HailConnectionConfirmation,row.actor_key,external);
          result=await this.federation.enqueue(tx,actor,row.federated_pair_id,new Uint8Array(row.remote_bundle!),new Uint8Array(row.remote_token_ciphertext!),new Uint8Array(row.remote_token_nonce!),confirmed.cose);
        }
      }else if(row.action==="create"||row.action==="replace"){
        let personal=Boolean(intent.personal),label=String(intent.label),expiresAt=intent.expiresAt as number|null;
        if(row.action==="replace"){
          const old=await this.invitation(tx,row.invitation_id);
          if(old.account_id!==actor.id||!old.personal||old.revoked_at)throw new ConnectionError(409,"Personal code already changed. Refresh the list.");
          await tx`UPDATE connection_invitations SET revoked_at=clock_timestamp() WHERE id=${old.id}`;
          personal=true;label=old.label;expiresAt=null;
        }
        const count=(await tx<{count:string|number}[]>`SELECT count(*) FROM connection_invitations WHERE account_id=${actor.id}
          AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at>extract(epoch FROM clock_timestamp()))`)[0]!;
        if(Number(count.count)>=20)throw new ConnectionError(429,"Revoke an existing code before creating another (limit 20).");
        if(personal&&(await tx`SELECT id FROM connection_invitations WHERE account_id=${actor.id} AND personal AND revoked_at IS NULL`).length)
          throw new ConnectionError(409,"A personal code already exists. Replace it instead.");
        if(!personal&&Number(expiresAt)<=now())throw new ConnectionError(410,"Chosen expiration has already passed.");
        const proposal=row.owner_payload?decodeDeterministic(new Uint8Array(row.owner_payload)) as unknown as HailConnectionInvitation:null;
        const invitationId=proposal?.invitation_id??uuidV7(),token=proposal?
          await this.encryptor.decryptConnectionToken(actor.id,invitationId,{ciphertext:row.token_ciphertext!,nonce:row.token_nonce!,encryptionVersion:1,kekId:"poc-v1"}):new Uint8Array(randomBytes(32));
        try{
          const payload:HailConnectionInvitation=proposal??{type:"hail.connection-invitation",version:1,invitation_id:invitationId,from:actor.did,
            token_hash:digest(token),issued_at:now(),expires_at:expiresAt,key_id:actor.did+"#hail-identity"};
          const signed=await this.signedConsent(tx,actor,"hail.connection-invitation",payload,row.actor_key,external);
          const encrypted=await this.encryptor.encryptConnectionToken(actor.id,invitationId,token);
          await tx`INSERT INTO connection_invitations(id,account_id,serving_generation,did,personal,label,request_id,request_digest,token_hash,ciphertext,nonce,cose,signing_key,signing_evidence,expires_at)
            VALUES(${invitationId},${actor.id},${actor.generation},${actor.did},${personal},${label},${id},${row.request_digest},${hash(token)},
            ${encrypted.ciphertext},${encrypted.nonce},${signed.cose},${row.actor_key},${JSON.stringify(signed.evidence)}::jsonb,${expiresAt})`;
        }finally{token.fill(0);}
        result={invitationId};
      }else if(row.action==="revoke"){
        const invitation=await this.invitation(tx,row.invitation_id);if(invitation.account_id!==actor.id)throw new ConnectionError(404);
        await tx`UPDATE connection_invitations SET revoked_at=COALESCE(revoked_at,clock_timestamp()) WHERE id=${invitation.id}`;result={invitationId:invitation.id,revoked:true};
      }else throw new ConnectionError(409,"Review this connection action again.");
      await this.live(tx,session);
      const saved=await tx`UPDATE connection_approvals SET result=${JSON.stringify(result)}::jsonb,credential_id=${credential}
        WHERE id=${id} AND expires_at>clock_timestamp() RETURNING id`;
      if(!saved.length)throw new ConnectionError(410,"Review expired before the action could be saved.");
      return this.approval(tx,session,id);
    });
    return this.summary(session,saved);
  }
}
