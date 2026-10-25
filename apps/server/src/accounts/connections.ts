import {createHash,randomBytes,timingSafeEqual} from "node:crypto";
import type {SQL} from "bun";
import type {AuthenticationResponseJSON} from "@simplewebauthn/server";
import {createWebCryptoSigner,createWebCryptoVerifier,decodeBase64Url,decodeDeterministic,encodeBase64Url,
  encodeDeterministic,signPayload,verifySignedPayload,type HailConnectionConfirmation,
  type HailConnectionGrant,type HailConnectionInvitation,type HailPayloadByType,type HailSignedPayloadType} from "@hailproto/codec";
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

const UUID=/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/;
const DID=/^did:plc:[a-z2-7]{24}$/;
const hash=(bytes:Uint8Array)=>new Uint8Array(createHash("sha256").update(bytes).digest());
const digest=(bytes:Uint8Array)=>({algorithm:"sha-256" as const,value:hash(bytes)});
const same=(a:Uint8Array,b:Uint8Array)=>a.length===b.length&&timingSafeEqual(a,b);
const now=()=>Math.floor(Date.now()/1000);
export class ConnectionError extends Error {constructor(readonly status:number,message="Connection not changed. Check the original approval before retrying."){super(message);}}
interface Owner {id:string;did:string;canonical_address:string;generation:number|string;}
interface Invitation {id:string;account_id:string;serving_generation:number|string;did:string;personal:boolean;label:string;
  token_hash:Uint8Array;ciphertext:Uint8Array;nonce:Uint8Array;cose:Uint8Array;signing_key:string;expires_at:number|string|null;revoked_at:Date|null;}
interface Connection {id:string;account_a:string;account_b:string;did_a:string;did_b:string;generation_a:number|string;generation_b:number|string;
  grant_id_a:string;grant_id_b:string;state:"pending"|"active"|"disconnected"|"expired";pending_until:Date;ended_at:Date|null;}
interface Approval {id:string;action:string;connection_id:string|null;invitation_id:string|null;request_digest:Uint8Array;intent_bytes:Uint8Array;
  actor_key:string;peer_key:string|null;actor_binding:Uint8Array|null;peer_binding:Uint8Array|null;challenge:string;expires_at:Date;result:unknown;}

// Provider-local preview only: deliberately separate from subscription Grant and envelope stores.
export class AccountConnections {
  constructor(private readonly sql:SQL,private readonly encryptor:KeyEncryptor,private readonly resolver:HailDidResolver,
    private readonly passkeys:Pick<PasskeyAuth,"actionOptions"|"approveAction">,private readonly origin:string){}

  private async live(tx:SQL,session:AccountApiSession){
    if(!session.passkey_credential_id)throw new ConnectionError(403,"Use your managed account's passkey session.");
    const rows=await tx`SELECT s.id FROM account_passkey_sessions s JOIN provider_accounts a ON a.id=s.account_id
      JOIN managed_custody_evidence m ON m.account_id=a.id JOIN account_serving_generations g ON g.account_id=a.id
      JOIN account_passkeys k ON k.credential_id=s.credential_id AND k.account_id=a.id
      WHERE s.id=${session.credential_id} AND a.id=${session.account_id} AND a.did=${session.did}
        AND a.onboarding_state='active' AND a.activation_verification_mode='public' AND s.serving_generation=g.generation
        AND g.generation=${session.serving_generation??1} AND k.serving_generation=g.generation AND k.revoked_at IS NULL
        AND s.revoked_at IS NULL AND s.expires_at>clock_timestamp() AND s.last_seen_at>clock_timestamp()-interval '30 minutes'
        AND s.credential_id=${session.passkey_credential_id}`;
    if(!rows.length)throw new ConnectionError(403,"Current managed account access is required.");
    await tx`SELECT hail_assert_unfenced_account(${session.account_id}::uuid)`;
  }
  private async owner(tx:SQL,id:string){
    const row=(await tx<Owner[]>`SELECT a.id,a.did,a.canonical_address,g.generation FROM provider_accounts a
      JOIN managed_custody_evidence m ON m.account_id=a.id JOIN account_serving_generations g ON g.account_id=a.id
      WHERE a.id=${id} AND a.onboarding_state='active' AND a.activation_verification_mode='public'`)[0];
    if(!row)throw new ConnectionError(409,"This preview requires two active managed accounts on this provider.");return row;
  }
  private async authority(tx:SQL,owner:Owner,expected?:string){
    await tx`SELECT hail_assert_unfenced_account(${owner.id}::uuid)`;
    const resolved=await this.resolver.resolve(owner.did),key=await new OnboardingRepository(tx).getKey(owner.id,"hail-identity");
    if(resolved.did!==owner.did||resolved.serviceBase!==this.origin+"/hail"||resolved.identityDidKey!==key.publicKey||expected&&expected!==key.publicKey)
      throw new ConnectionError(409,"Identity signing authority changed. Review a current code.");
    await requireFreshPublicAuthority(tx,resolved.evidence,{did:owner.did,role:"hail-identity",key:key.publicKey,serviceBase:this.origin+"/hail"},new Date());
    return {key,resolved};
  }
  private async sign<T extends HailSignedPayloadType>(tx:SQL,owner:Owner,type:T,payload:HailPayloadByType[T],expected:string){
    const {key,resolved}=await this.authority(tx,owner,expected);
    const raw=await this.encryptor.decrypt(owner.id,key.role,key.algorithm,key.publicKey,key);
    try{return {cose:await signPayload(type,payload,createWebCryptoSigner(owner.did+"#hail-identity",await importEd25519PrivateKey(raw))),evidence:resolved.evidence};}
    finally{raw.fill(0);}
  }
  private async binding(tx:SQL,owner:Owner,key:string){
    const row=(await tx<{cose:Uint8Array}[]>`SELECT cose FROM address_bindings WHERE account_id=${owner.id} AND did=${owner.did}
      AND canonical_address=${owner.canonical_address} AND selected_at IS NOT NULL ORDER BY selected_at DESC,id DESC LIMIT 1`)[0];
    if(!row)throw new ConnectionError(409,"A current verified address binding is required.");
    const checked=await verifySignedPayload("hail.address-binding",new Uint8Array(row.cose),createWebCryptoVerifier(async kid=>{
      if(kid!==owner.did+"#hail-identity")throw new ConnectionError(409);return ed25519PublicKeyFromDidKey(key);
    }));
    if(checked.payload.address!==owner.canonical_address||checked.payload.did!==owner.did||checked.payload.expires_at<=now()||checked.payload.issued_at>now()+300)
      throw new ConnectionError(409,"The account's address binding needs renewal.");
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
  async list(session:AccountApiSession){
    return this.pairTransaction(session,undefined,async tx=>{
      const codes=await tx<Invitation[]>`SELECT * FROM connection_invitations WHERE account_id=${session.account_id} AND revoked_at IS NULL
        AND (expires_at IS NULL OR expires_at>extract(epoch FROM clock_timestamp())) ORDER BY personal DESC,id DESC LIMIT 21`;
      const connections=await tx<{id:string;did:string;address:string;activated_at:Date}[]>`SELECT c.id,
        CASE WHEN c.account_a=${session.account_id} THEN c.did_b ELSE c.did_a END AS did,
        a.canonical_address AS address,c.activated_at FROM account_connections c JOIN provider_accounts a
        ON a.id=CASE WHEN c.account_a=${session.account_id} THEN c.account_b ELSE c.account_a END
        WHERE ${session.account_id} IN (c.account_a,c.account_b) AND c.state='active' ORDER BY c.id DESC LIMIT 100`;
      return {preview:true,codes:await Promise.all(codes.map(async row=>{
        const token=await this.encryptor.decryptConnectionToken(row.account_id,row.id,{ciphertext:row.ciphertext,nonce:row.nonce,encryptionVersion:1,kekId:"poc-v1"});
        try{return {id:row.id,personal:row.personal,label:row.label,expiresAt:row.expires_at===null?null:Number(row.expires_at),
          link:this.origin+"/connect#"+new URLSearchParams({id:row.id,did:row.did,token:encodeBase64Url(token)}).toString()};}finally{token.fill(0);}
      })),connections:connections.map(row=>({id:row.id,did:row.did,address:row.address,connectedAt:row.activated_at.toISOString()}))};
    });
  }
  async review(session:AccountApiSession,input:Record<string,unknown>){
    this.keys(input,["id","did","token"]);
    const row=await this.invitation(this.sql,input.id);
    return this.pairTransaction(session,row.account_id,async tx=>{
      const current=await this.invitation(tx,row.id),owner=await this.checkInvitation(tx,current,input.token,input.did);
      if(owner.id===session.account_id)throw new ConnectionError(400,"This is your own connection code.");
      return {id:row.id,did:owner.did,address:owner.canonical_address,expiresAt:current.expires_at===null?null:Number(current.expires_at),preview:true};
    });
  }
  private keys(input:Record<string,unknown>,keys:string[]){
    if(Object.keys(input).length!==keys.length||Object.keys(input).some(key=>!keys.includes(key)))throw new ConnectionError(400,"Invalid connection request.");
  }
  private async approval(tx:SQL,session:AccountApiSession,id:string){
    const row=(await tx<Approval[]>`SELECT * FROM connection_approvals WHERE id=${id} AND account_id=${session.account_id}
      AND session_id=${session.credential_id} AND serving_generation=${session.serving_generation??1}`)[0];
    if(!row)throw new ConnectionError(404);return row;
  }
  private async summary(session:AccountApiSession,row:Approval){
    const intent=decodeDeterministic(new Uint8Array(row.intent_bytes)) as Record<string,unknown>;
    const {token,confirmation,...review}=intent; // Expose review fields, not admission secrets or internal proof bytes.
    return {requestId:row.id,action:row.action,review,expiresAt:row.expires_at.toISOString(),result:typeof row.result==="string"?JSON.parse(row.result):row.result,
      options:row.result||row.expires_at.getTime()<=Date.now()?null:await this.passkeys.actionOptions(session,row.challenge)};
  }
  async status(session:AccountApiSession,id:string){
    if(!UUID.test(id))throw new ConnectionError(400);await this.live(this.sql,session);return this.summary(session,await this.approval(this.sql,session,id));
  }
  async prepare(session:AccountApiSession,input:Record<string,unknown>){
    if(typeof input.requestId!=="string"||!UUID.test(input.requestId)||typeof input.action!=="string")throw new ConnectionError(400);
    const action=input.action;
    this.keys(input,action==="create"?["requestId","action","personal","label","expiresAt"]:
      action==="connect"?["requestId","action","id","did","token"]:action==="replace"||action==="revoke"?["requestId","action","id"]:
      action==="disconnect"?["requestId","action","connectionId"]:[]);
    const requestId=input.requestId,requestDigest=hash(encodeDeterministic(input as never));
    // A retained retry never creates a new connection epoch.
    await this.live(this.sql,session);
    const prior=(await this.sql`SELECT id FROM connection_approvals WHERE id=${requestId}`)[0];
    if(prior){const row=await this.approval(this.sql,session,requestId);if(!same(row.request_digest,requestDigest))throw new ConnectionError(409);return this.summary(session,row);}
    let invitation:Invitation|undefined,peerId:string|undefined;
    if(["connect","replace","revoke"].includes(action))invitation=await this.invitation(this.sql,input.id);
    if(action==="connect")peerId=invitation!.account_id;
    if(action==="disconnect"){
      if(typeof input.connectionId!=="string"||!UUID.test(input.connectionId))throw new ConnectionError(400);
      const c=(await this.sql<Connection[]>`SELECT * FROM account_connections WHERE id=${input.connectionId} AND ${session.account_id} IN (account_a,account_b)`)[0];
      if(!c)throw new ConnectionError(404);peerId=c.account_a===session.account_id?c.account_b:c.account_a;
    }
    const saved=await this.pairTransaction(session,peerId,async tx=>{
      if((await tx`SELECT id FROM connection_approvals WHERE account_id=${session.account_id} AND expires_at>clock_timestamp() AND result IS NULL`).length>=20)
        throw new ConnectionError(429,"Too many pending reviews. Wait five minutes.");
      const actor=await this.owner(tx,session.account_id),authority=await this.authority(tx,actor);
      let connection:Connection|undefined,peerKey:string|null=null,actorBinding:Uint8Array|null=null,peerBinding:Uint8Array|null=null;
      let intent:Record<string,unknown>={...input};
      if(action==="create"){
        if(typeof input.personal!=="boolean"||typeof input.label!=="string"||!input.label.trim()||input.label.length>80||input.personal&&input.expiresAt!==null)throw new ConnectionError(400);
        if(!input.personal&&(!Number.isSafeInteger(input.expiresAt)||Number(input.expiresAt)<=now()||Number(input.expiresAt)>now()+366*86400))
          throw new ConnectionError(400,"Choose an expiration within one year.");
      }else if(action==="replace"||action==="revoke"){
        invitation=await this.invitation(tx,input.id);
        if(invitation.account_id!==session.account_id||action==="replace"&&!invitation.personal)throw new ConnectionError(404);
      }else if(action==="connect"){
        invitation=await this.invitation(tx,input.id);const peer=await this.checkInvitation(tx,invitation,input.token,input.did);
        if(peer.id===actor.id)throw new ConnectionError(400,"You cannot connect to yourself.");
        const peerAuthority=await this.authority(tx,peer);peerKey=peerAuthority.key.publicKey;
        actorBinding=await this.binding(tx,actor,authority.key.publicKey);peerBinding=await this.binding(tx,peer,peerKey);
        const [a,b]=actor.did<peer.did?[actor,peer]:[peer,actor];
        // A disconnected epoch invalidates every earlier invitation, including permanent codes.
        const old=await tx`SELECT id FROM account_connections WHERE did_a=${a.did} AND did_b=${b.did} AND state='disconnected'
          AND ended_at>=(SELECT created_at FROM connection_invitations WHERE id=${invitation.id}) LIMIT 1`;
        if(old.length)throw new ConnectionError(409,"A prior disconnect invalidated this code for this pair. Share a newly created or replaced code to reconnect.");
        await tx`UPDATE account_connections SET state='expired',ended_at=clock_timestamp() WHERE did_a=${a.did} AND did_b=${b.did} AND state='pending' AND pending_until<=clock_timestamp()`;
        connection=(await tx<Connection[]>`SELECT * FROM account_connections WHERE did_a=${a.did} AND did_b=${b.did} AND state IN ('pending','active')`)[0];
        if(!connection){
          const counts=await tx<{count:string|number}[]>`SELECT count(*) FROM account_connections WHERE
            (${a.id} IN (account_a,account_b) OR ${b.id} IN (account_a,account_b)) AND (state='active' OR state='pending' AND pending_until>clock_timestamp())
            GROUP BY CASE WHEN ${a.id} IN (account_a,account_b) THEN ${a.id}::uuid ELSE ${b.id}::uuid END`;
          if(counts.some(row=>Number(row.count)>=100))throw new ConnectionError(429,"The connection preview supports up to 100 current connections per account.");
          connection=(await tx<Connection[]>`INSERT INTO account_connections(id,account_a,account_b,did_a,did_b,generation_a,generation_b,grant_id_a,grant_id_b)
            VALUES(${uuidV7()},${a.id},${b.id},${a.did},${b.did},${a.generation},${b.generation},${uuidV7()},${uuidV7()}) RETURNING *`)[0]!;
        }
        const issued=now();
        intent={action,id:invitation.id,did:peer.did,address:peer.canonical_address,confirmation:{type:"hail.connection-confirmation",version:1,
          confirmation_id:uuidV7(),from:actor.did,to:peer.did,invitation_id:invitation.id,invitation_hash:digest(new Uint8Array(invitation.cose)),
          issued_at:issued,expires_at:issued+300,key_id:actor.did+"#hail-identity"} satisfies HailConnectionConfirmation};
      }else if(action==="disconnect"){
        connection=(await tx<Connection[]>`SELECT * FROM account_connections WHERE id=${input.connectionId as string} AND ${session.account_id} IN (account_a,account_b)`)[0];
        if(!connection||connection.state!=="active")throw new ConnectionError(409,"This connection is no longer active.");
      }
      await tx`INSERT INTO connection_approvals(id,account_id,session_id,serving_generation,action,connection_id,invitation_id,request_digest,intent_bytes,
        actor_key,peer_key,actor_binding,peer_binding,challenge) VALUES(${requestId},${session.account_id},${session.credential_id},${session.serving_generation??1},${action},
        ${connection?.id??null},${invitation?.id??null},${requestDigest},${encodeDeterministic(intent as never)},${authority.key.publicKey},${peerKey},${actorBinding},${peerBinding},${encodeBase64Url(randomBytes(32))})
        ON CONFLICT(id) DO NOTHING`;
      const row=await this.approval(tx,session,requestId);if(!same(row.request_digest,requestDigest))throw new ConnectionError(409);
      return row;
    });
    return this.summary(session,saved);
  }

  async commit(session:AccountApiSession,id:string,response?:AuthenticationResponseJSON){
    if(!UUID.test(id))throw new ConnectionError(400);await this.live(this.sql,session);
    const initial=await this.approval(this.sql,session,id);
    if(initial.result)return this.summary(session,initial);
    let peerId:string|undefined;
    if(initial.connection_id){const c=(await this.sql<Connection[]>`SELECT * FROM account_connections WHERE id=${initial.connection_id}`)[0]!;peerId=c.account_a===session.account_id?c.account_b:c.account_a;}
    const saved=await this.pairTransaction(session,peerId,async tx=>{
      const row=await this.approval(tx,session,id);if(row.result)return row;
      if(row.expires_at.getTime()<=Date.now())throw new ConnectionError(410,"Approval expired. Review again.");
      if(!response)throw new ConnectionError(403,"Confirm this exact action with your passkey.");
      const intent=decodeDeterministic(new Uint8Array(row.intent_bytes)) as Record<string,unknown>;
      const actor=await this.owner(tx,session.account_id);await this.authority(tx,actor,row.actor_key);
      const credential=await this.passkeys.approveAction(tx,session,row.challenge,response);
      let result:Record<string,unknown>;
      if(row.action==="create"||row.action==="replace"){
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
        const invitationId=uuidV7(),token=new Uint8Array(randomBytes(32));
        try{
          const payload:HailConnectionInvitation={type:"hail.connection-invitation",version:1,invitation_id:invitationId,from:actor.did,
            token_hash:digest(token),issued_at:now(),expires_at:expiresAt,key_id:actor.did+"#hail-identity"};
          const signed=await this.sign(tx,actor,"hail.connection-invitation",payload,row.actor_key);
          const encrypted=await this.encryptor.encryptConnectionToken(actor.id,invitationId,token);
          await tx`INSERT INTO connection_invitations(id,account_id,serving_generation,did,personal,label,request_id,request_digest,token_hash,ciphertext,nonce,cose,signing_key,signing_evidence,expires_at)
            VALUES(${invitationId},${actor.id},${actor.generation},${actor.did},${personal},${label},${id},${row.request_digest},${hash(token)},
            ${encrypted.ciphertext},${encrypted.nonce},${signed.cose},${row.actor_key},${JSON.stringify(signed.evidence)}::jsonb,${expiresAt})`;
        }finally{token.fill(0);}
        result={invitationId};
      }else if(row.action==="revoke"){
        const invitation=await this.invitation(tx,row.invitation_id);if(invitation.account_id!==actor.id)throw new ConnectionError(404);
        await tx`UPDATE connection_invitations SET revoked_at=COALESCE(revoked_at,clock_timestamp()) WHERE id=${invitation.id}`;result={invitationId:invitation.id,revoked:true};
      }else{
        const c=(await tx<Connection[]>`SELECT * FROM account_connections WHERE id=${row.connection_id!}`)[0]!;
        if(row.action==="disconnect"){
          if(c.state!=="active")throw new ConnectionError(409,"This connection was already ended.");
          await tx`UPDATE account_connections SET state='disconnected',ended_at=clock_timestamp(),ended_by=${actor.id} WHERE id=${c.id}`;
          result={connectionId:c.id,state:"disconnected"};
        }else{
          if(c.state==="disconnected"||c.state==="expired"||c.state==="pending"&&c.pending_until.getTime()<=Date.now())throw new ConnectionError(410,"This connection attempt ended. Review a current code.");
          if(c.state==="active")result={connectionId:c.id,state:"active"};
          else{
            const invitation=await this.invitation(tx,row.invitation_id);
            // Token possession was checked during preparation. The immutable approval binds its exact signed invitation.
            if(invitation.revoked_at||invitation.expires_at!==null&&Number(invitation.expires_at)<=now())throw new ConnectionError(410,"This code expired or was revoked before confirmation.");
            const peer=await this.owner(tx,peerId!);await this.authority(tx,peer,row.peer_key!);
            if(peer.id!==invitation.account_id||Number(peer.generation)!==Number(invitation.serving_generation)||peer.did!==invitation.did||row.peer_key!==invitation.signing_key||
              Number(actor.generation)!==Number(c.account_a===actor.id?c.generation_a:c.generation_b)||Number(peer.generation)!==Number(c.account_a===peer.id?c.generation_a:c.generation_b))throw new ConnectionError(409);
            const confirmation=intent.confirmation as unknown as HailConnectionConfirmation;
            if(confirmation.expires_at<=now()||!same(confirmation.invitation_hash.value,hash(new Uint8Array(invitation.cose))))throw new ConnectionError(410);
            const actorBinding=await this.binding(tx,actor,row.actor_key),peerBinding=await this.binding(tx,peer,row.peer_key!);
            if(!same(actorBinding,row.actor_binding!)||!same(peerBinding,row.peer_binding!))throw new ConnectionError(409,"Address evidence changed. Review again.");
            const confirmed=await this.sign(tx,actor,"hail.connection-confirmation",confirmation,row.actor_key);
            const grant=(owner:Owner,grantee:Owner,binding:Uint8Array):HailConnectionGrant=>({type:"hail.connection-grant",version:1,
              grant_id:owner.id===c.account_a?c.grant_id_a:c.grant_id_b,connection_id:c.id,revision:1,previous:null,grantor:owner.did,grantee:grantee.did,
              status:"active",issued_at:now(),updated_at:now(),expires_at:null,key_id:owner.did+"#hail-identity",consent_context:{grantee_address:grantee.canonical_address,
                address_binding_hash:digest(binding),invitation_hash:digest(new Uint8Array(invitation.cose)),confirmation_hash:digest(confirmed.cose)}});
            const actorGrant=await this.sign(tx,actor,"hail.connection-grant",grant(actor,peer,peerBinding),row.actor_key);
            const peerGrant=await this.sign(tx,peer,"hail.connection-grant",grant(peer,actor,actorBinding),row.peer_key!);
            const a=actor.id===c.account_a?actorGrant:peerGrant,b=actor.id===c.account_b?actorGrant:peerGrant;
            const activated=await tx`UPDATE account_connections SET state='active',activated_at=clock_timestamp(),invitation_cose=${invitation.cose},confirmation_cose=${confirmed.cose},
              grant_a_cose=${a.cose},grant_b_cose=${b.cose},evidence_a=${JSON.stringify(a.evidence)}::jsonb,evidence_b=${JSON.stringify(b.evidence)}::jsonb
              WHERE id=${c.id} AND state='pending' AND pending_until>clock_timestamp() AND ${row.expires_at}>clock_timestamp()
                AND ${confirmation.expires_at}>extract(epoch FROM clock_timestamp())
                AND (${invitation.expires_at}::bigint IS NULL OR ${invitation.expires_at}::bigint>extract(epoch FROM clock_timestamp())) RETURNING id`;
            if(!activated.length)throw new ConnectionError(410,"The code or review expired before admission. No connection was activated.");
            result={connectionId:c.id,state:"active"};
          }
        }
      }
      await this.live(tx,session);
      const saved=await tx`UPDATE connection_approvals SET result=${JSON.stringify(result)}::jsonb,credential_id=${credential}
        WHERE id=${id} AND expires_at>clock_timestamp() RETURNING id`;
      if(!saved.length)throw new ConnectionError(410,"Review expired before the action could be saved.");
      return this.approval(tx,session,id);
    });
    return this.summary(session,saved);
  }
}
