import {previousAddressIdentities} from "./identity-history.js";
import {createHash,randomBytes,timingSafeEqual} from "node:crypto";
import type {SQL} from "bun";
import type {Hono} from "hono";
import {getCookie} from "hono/cookie";
import type {AuthenticationResponseJSON} from "@simplewebauthn/server";
import {decodeDeterministic,encodeDeterministic,encodeBase64Url,toDiagnosticJson,validatePayload,type HailGrant} from "@hailproto/codec";
import type {AccountApiRepository,AccountApiSession} from "./repository.js";
import {PasskeyAuth,PasskeyError} from "./passkeys.js";
import {accountRequestBytes} from "./routes.js";
import {GrantService,UserGrantError} from "../grants/service.js";
import type {GrantRepository} from "../grants/repository.js";
import {parseJsonWithoutDuplicateKeys} from "../discovery/strict-json.js";
import {FixedWindowRateLimit,clientAddress} from "../http/rate-limit.js";
import {withServingGeneration} from "../db/serving.js";

const UUID=/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/,DID=/^did:plc:[a-z2-7]{24}$/;
const equal=(a:Uint8Array,b:Uint8Array)=>a.length===b.length&&timingSafeEqual(Buffer.from(a),Buffer.from(b));
export class PermissionError extends Error{constructor(readonly status:number,message="Permission not changed; retain the original approval and retry"){super(message);}}
interface Approval {
  id:string;account_id:string;session_id:string;serving_generation:number|string;action:"allow"|"revoke";
  request_digest:Uint8Array;payload_bytes:Uint8Array;signing_key:string;challenge:string;expires_at:Date;
  approved_at:Date|null;credential_id:string|null;result:Record<string,unknown>|string|null;
}

export class GrantPermissions {
  constructor(private readonly sql:SQL,private readonly accounts:AccountApiRepository,private readonly grants:GrantRepository,
    private readonly service:GrantService,private readonly passkeys:PasskeyAuth,private readonly origin:string){}

  private async live(session:AccountApiSession,sql=this.sql){
    if(!session.passkey_credential_id)throw new PermissionError(403,"Use your account's passkey session to approve permissions");
    const rows=await sql`SELECT s.id FROM account_passkey_sessions s JOIN provider_accounts a ON a.id=s.account_id
      JOIN managed_custody_evidence m ON m.account_id=a.id
      JOIN account_serving_generations g ON g.account_id=a.id AND g.generation=s.serving_generation
      JOIN account_passkeys k ON k.credential_id=s.credential_id AND k.account_id=a.id AND k.serving_generation=g.generation
      WHERE s.id=${session.credential_id} AND s.credential_id=${session.passkey_credential_id}
        AND a.id=${session.account_id} AND g.generation=${session.serving_generation??1}
        AND a.onboarding_state='active' AND a.did=${session.did} AND s.revoked_at IS NULL AND s.expires_at>clock_timestamp()
        AND s.last_seen_at>clock_timestamp()-interval '30 minutes' AND k.revoked_at IS NULL
        AND NOT EXISTS (SELECT 1 FROM provider_migration_fences f WHERE f.account_id=a.id)`;
    if(!rows.length)throw new PermissionError(403,"Current managed account access is required; sign in again if necessary");
  }

  async review(session:AccountApiSession,input:Record<string,unknown>){
    await this.live(session);
    if(Object.keys(input).some(k=>!["sender","senderDid"].includes(k))||typeof input.sender!=="string"||input.sender.length>254||
      input.senderDid!==undefined&&(typeof input.senderDid!=="string"||!DID.test(input.senderDid)))throw new PermissionError(400);
    const {address,profile}=await this.service.inspectSender(input.sender);
    if(address.did===session.did)throw new PermissionError(400,"Choose another sender, not your own account");
    if(input.senderDid!==undefined&&input.senderDid!==address.did)throw new PermissionError(409,"This QR identity no longer matches the address. Ask the sender for a current code");
    return {address:address.address,did:address.did,addressDigest:encodeBase64Url(address.digest),profileDigest:encodeBase64Url(profile.digest),
      previousDids:await previousAddressIdentities(this.sql,session.account_id,address.address,address.did),
      displayName:profile.profile.display_name,categories:profile.profile.categories,offersUncategorized:profile.profile.offers_uncategorized};
  }

  private async row(session:AccountApiSession,id:string,sql=this.sql){
    if(!UUID.test(id))throw new PermissionError(400);
    const row=(await sql<Approval[]>`SELECT * FROM account_grant_approvals WHERE id=${id} AND account_id=${session.account_id}
      AND session_id=${session.credential_id} AND serving_generation=${session.serving_generation??1}`)[0];
    if(!row)throw new PermissionError(404);
    if(!row.result&&row.expires_at.getTime()<=Date.now())throw new PermissionError(410,"Approval expired. Review the current permission again; no renewed authority was issued");
    return row;
  }
  private payloads(row:Approval){
    const decoded=decodeDeterministic(new Uint8Array(row.payload_bytes));
    const payloads=(Array.isArray(decoded)?decoded:[decoded]) as unknown as HailGrant[];
    if(!payloads.length||payloads.length>50||Array.isArray(decoded)&&row.action!=="revoke")throw new PermissionError(409);
    for(const payload of payloads)validatePayload("hail.grant",payload);
    return {payloads,batch:Array.isArray(decoded)};
  }
  private async summary(session:AccountApiSession,row:Approval){
    const {payloads,batch}=this.payloads(row);
    return {requestId:row.id,action:batch?"revoke-batch":row.action,expiresAt:row.expires_at.toISOString(),approved:row.approved_at!==null,
      result:typeof row.result==="string"?JSON.parse(row.result):row.result,
      permission:toDiagnosticJson("hail.grant",payloads[0]!),
      previousDids:row.action==="allow"?await previousAddressIdentities(this.sql,session.account_id,payloads[0]!.consent_context.grantee_address,payloads[0]!.grantee):[],
      ...(batch?{permissions:payloads.map(payload=>toDiagnosticJson("hail.grant",payload))}:{}),
      options:row.approved_at?null:await this.passkeys.actionOptions(session,row.challenge)};
  }
  async status(session:AccountApiSession,id:string){await this.live(session);return this.summary(session,await this.row(session,id));}

  async prepare(session:AccountApiSession,input:Record<string,unknown>){
    await this.live(session);
    if(typeof input.requestId!=="string"||!UUID.test(input.requestId)||!["allow","revoke"].includes(input.action as string))throw new PermissionError(400);
    const batch=input.action==="revoke"&&Array.isArray(input.grants);
    const allowed=input.action==="allow"?["requestId","action","sender","senderDid","addressDigest","profileDigest","scope","expiresAt"]:
      batch?["requestId","action","grants"]:["requestId","action","grantId","revision","digest"];
    if(Object.keys(input).length!==allowed.length||Object.keys(input).some(k=>!allowed.includes(k)))throw new PermissionError(400);
    const digest=new Uint8Array(createHash("sha256").update(encodeDeterministic(input as never)).digest());
    const prior=(await this.sql<Approval[]>`SELECT * FROM account_grant_approvals WHERE id=${input.requestId}`)[0];
    if(prior){const row=await this.row(session,input.requestId);if(!equal(row.request_digest,digest))throw new PermissionError(409,"Approval retry differs from the reviewed intent");return this.summary(session,row);}
    if((await this.sql`SELECT id FROM account_grant_approvals WHERE account_id=${session.account_id} AND expires_at>clock_timestamp() AND result IS NULL`).length>=20)
      throw new PermissionError(429,"Too many unfinished approvals; wait for them to expire");
    let payload:HailGrant|HailGrant[];
    if(input.action==="allow"){
      if((input.scope as Record<string,unknown>|undefined)?.type==="uncategorized")
        throw new PermissionError(400,"Subscribe to General instead; the publisher must offer that category first");
      if(typeof input.sender!=="string"||input.sender.length>254||typeof input.senderDid!=="string"||!DID.test(input.senderDid)||input.senderDid===session.did||
        typeof input.addressDigest!=="string"||typeof input.profileDigest!=="string"||(input.expiresAt!==null&&(!Number.isSafeInteger(input.expiresAt)||
        Number(input.expiresAt)<=Math.floor(Date.now()/1000)||Number(input.expiresAt)>Math.floor(Date.now()/1000)+366*86400)))
        throw new PermissionError(400,"Choose the reviewed sender and an ongoing subscription or a future expiry within one year");
      payload=await this.service.prepareUserSignedGrant(session.canonical_address,input.sender,{scope:input.scope as never,expiresAt:input.expiresAt===null?null:Number(input.expiresAt)});
      if(payload.grantee!==input.senderDid||encodeBase64Url(payload.consent_context.address_binding_hash.value)!==input.addressDigest||
        encodeBase64Url(payload.consent_context.sender_profile_hash.value)!==input.profileDigest)
        throw new PermissionError(409,"Sender identity or profile changed. Review it again before approving");
    }else{
      const selections=batch?input.grants as Record<string,unknown>[]:[input];
      if(selections.length>50)throw new PermissionError(413,"Select at most 50 subscriptions");
      if(!selections.length||new Set(selections.map(item=>item?.grantId)).size!==selections.length)throw new PermissionError(400,"Select between 1 and 50 distinct subscriptions");
      const payloads:HailGrant[]=[];
      for(const item of selections){
        if(!item||typeof item!=="object"||Array.isArray(item)||batch&&(Object.keys(item).length!==3||Object.keys(item).some(key=>!["grantId","revision","digest"].includes(key)))||
          typeof item.grantId!=="string"||!UUID.test(item.grantId)||!Number.isSafeInteger(item.revision)||typeof item.digest!=="string")throw new PermissionError(400);
        const current=await this.grants.findCurrentByGrantId(item.grantId);
        if(!current||current.localAccountId!==session.account_id||current.localRole!=="grantor"||current.payload.status!=="active"||
          current.payload.revision!==item.revision||encodeBase64Url(current.digest)!==item.digest)throw new PermissionError(409,"Permission changed. Review its current revision before revoking");
        payloads.push(current.payload);
      }
      payload=batch?payloads:payloads[0]!;
    }
    const account=await this.accounts.describe(session,this.origin);
    if(account.custodyProfile!=="managed"||!account.identityPublicKey)throw new PermissionError(403);
    const encoded=encodeDeterministic(payload);if(encoded.length>16384)throw new PermissionError(413,"Selection is too large. Select fewer subscriptions");
    await this.sql`INSERT INTO account_grant_approvals(id,account_id,serving_generation,session_id,action,request_digest,payload_bytes,signing_key,challenge)
      VALUES(${input.requestId},${session.account_id},${session.serving_generation??1},${session.credential_id},${input.action as string},
        ${digest},${encoded},${account.identityPublicKey},${encodeBase64Url(randomBytes(32))}) ON CONFLICT (id) DO NOTHING`;
    const row=await this.row(session,input.requestId);
    if(!equal(row.request_digest,digest))throw new PermissionError(409);
    return this.summary(session,row);
  }

  private savedResult(saved:NonNullable<Awaited<ReturnType<GrantRepository["findCurrentByGrantId"]>>>){
    return {grantId:saved.payload.grant_id,revision:saved.payload.revision,status:saved.payload.status,digest:encodeBase64Url(saved.digest),publication:"durable"};
  }
  private async revoke(session:AccountApiSession,row:Approval,payload:HailGrant){
    const current=await this.grants.findCurrentByGrantId(payload.grant_id);
    if(!current||current.localAccountId!==session.account_id||current.localRole!=="grantor"||current.signingPublicKey!==row.signing_key)throw new PermissionError(409);
    const original=encodeDeterministic(payload);
    const previous=await this.grants.findRevisionByGrantId(payload.grant_id,payload.revision);
    // A retry can recognize only the exact successor of the reviewed revision.
    if(current.payload.status==="revoked"&&current.payload.revision===payload.revision+1&&previous&&
      equal(encodeDeterministic(previous.payload),original)&&current.payload.previous&&equal(current.payload.previous,previous.digest))return current;
    if(current.payload.status!=="active"||!equal(encodeDeterministic(current.payload),original))throw new PermissionError(409,"Permission changed after review; review the current revision again");
    if(!previous)throw new PermissionError(409);
    return this.service.revoke(session.canonical_address,payload.grant_id,{revision:payload.revision,digest:previous.digest});
  }

  async commit(session:AccountApiSession,id:string,response?:AuthenticationResponseJSON){
    await this.live(session);
    if(!UUID.test(id))throw new PermissionError(400);
    const connection=await this.sql.reserve();let locked=false;
    try{
      // ponytail: one provider-wide approval at a time prevents pooled-connection
      // starvation during signing; use a bounded worker pool if pilot volume grows.
      locked=(await connection<{locked:boolean}[]>`SELECT pg_try_advisory_lock(684245162) AS locked`)[0]!.locked;
      if(!locked)throw new PermissionError(409,"Another permission approval is running. Retry this original approval");
      let row=await this.row(session,id);
      if(row.result)return this.summary(session,row);
      if(!row.approved_at){
        if(!response)throw new PermissionError(403,"Confirm this exact permission with your passkey");
        await this.sql.begin(async tx=>{
          await this.live(session,tx as SQL);
          const current=await this.row(session,id,tx as SQL);
          const credential=await this.passkeys.approveAction(tx as SQL,session,current.challenge,response);
          const updated=await tx`UPDATE account_grant_approvals SET approved_at=clock_timestamp(),credential_id=${credential}
            WHERE id=${id} AND approved_at IS NULL AND expires_at>clock_timestamp() RETURNING id`;
          if(!updated.length)throw new PermissionError(410);
        });
        row=await this.row(session,id);
      }
      await this.live(session);
      if(!(await this.sql`SELECT credential_id FROM account_passkeys WHERE credential_id=${row.credential_id!} AND account_id=${session.account_id}
        AND serving_generation=${session.serving_generation??1} AND revoked_at IS NULL`).length)throw new PermissionError(403,"The approving passkey is no longer current");
      const {payloads,batch}=this.payloads(row);
      let result:Record<string,unknown>;
      if(batch){
        const items:Record<string,unknown>[]=[];
        for(const payload of payloads){
          await this.live(session);
          try{items.push({grantId:payload.grant_id,result:this.savedResult(await this.revoke(session,row,payload)),error:null});}
          catch(error){
            // Only definitive revision conflicts are terminal item failures. An
            // uncertain write leaves the original approval recoverable; exact
            // successor detection below makes re-running the batch idempotent.
            if(!(error instanceof PermissionError||error instanceof UserGrantError)||error.status!==409)throw error;
            items.push({grantId:payload.grant_id,result:null,error:"Subscription changed after review. Refresh and review it again."});
          }
        }
        result={items};
      }else{
        const payload=payloads[0]!;
        const saved=row.action==="allow"?await this.service.updateManaged(session.canonical_address,payload,row.signing_key):await this.revoke(session,row,payload);
        result=this.savedResult(saved);
      }
      await this.sql`UPDATE account_grant_approvals SET result=(${JSON.stringify(result)}::text)::jsonb WHERE id=${id} AND result IS NULL`;
      return this.summary(session,await this.row(session,id));
    }finally{try{if(locked)await connection`SELECT pg_advisory_unlock(684245162)`;}finally{connection.release();}}
  }
}

export function registerPermissionRoutes(app:Hono,permissions:GrantPermissions,accounts:AccountApiRepository,origin:string){
  const rate=new FixedWindowRateLimit();
  app.all("/api/v1/account/permissions/:step?",async context=>{
    context.header("Cache-Control","no-store");context.header("Vary","Cookie");
    const suppliedOrigin=context.req.header("Origin");
    if(suppliedOrigin!==origin&&!(context.req.method==="GET"&&suppliedOrigin===undefined))return context.json({error:"Permission origin refused"},403);
    const retry=rate.take(clientAddress(context.req.raw),30);
    if(retry!==null){context.header("Retry-After",String(retry));return context.json({error:"Wait before retrying permission requests"},429);}
    try{
      if(context.req.header("Authorization"))throw new PermissionError(403);
      const session=await accounts.authenticate(undefined,getCookie(context,"hail_session"));
      if(!session)throw new PermissionError(401,"Sign in before managing allowed senders");
      return await withServingGeneration(session.account_id,session.serving_generation??1,async()=>{
        const step=context.req.param("step");
        if(context.req.method==="GET"&&step&&UUID.test(step))return context.json(await permissions.status(session,step));
        if(context.req.method!=="POST")throw new PermissionError(405);
        if(context.req.header("Content-Type")!=="application/json"||context.req.header("Content-Encoding"))throw new PermissionError(415);
        const raw=await accountRequestBytes(context.req.raw,65_536);if(!raw)throw new PermissionError(413);
        let input:Record<string,unknown>;
        try{input=parseJsonWithoutDuplicateKeys(new TextDecoder("utf-8",{fatal:true}).decode(raw)) as Record<string,unknown>;
          if(!input||typeof input!=="object"||Array.isArray(input))throw new Error();}catch{throw new PermissionError(400);}
        if(step==="review")return context.json(await permissions.review(session,input));
        if(step==="prepare")return context.json(await permissions.prepare(session,input));
        if(step==="commit"){
          if(Object.keys(input).some(k=>!["requestId","response"].includes(k))||typeof input.requestId!=="string"||
            input.response!==undefined&&(!input.response||typeof input.response!=="object"||Array.isArray(input.response)))throw new PermissionError(400);
          return context.json(await permissions.commit(session,input.requestId,input.response as AuthenticationResponseJSON|undefined));
        }
        throw new PermissionError(404);
      });
    }catch(error){
      const status=error instanceof PermissionError||error instanceof PasskeyError||error instanceof UserGrantError?error.status:503;
      return new Response(JSON.stringify({error:error instanceof PermissionError?error.message:"Permission not changed or not confirmed. Check the original approval before retrying"}),
        {status,headers:{"Content-Type":"application/json","Cache-Control":"no-store",...(status===503?{"Retry-After":"15"}:{})}});
    }
  });
}
