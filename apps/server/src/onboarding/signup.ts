import { registerStandaloneDomainRoutes } from "../accounts/standalone-domain-routes.js";
import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { SQL } from "bun";
import type { Hono } from "hono";
import { getCookie } from "hono/cookie";
import { assureValidSig, def, didForCreateOp, type Operation } from "@did-plc/lib";
import { encode as encodeDagCbor } from "@ipld/dag-cbor";
import { parseDidKey, P256_JWT_ALG, SECP256K1_JWT_ALG } from "@atproto/crypto";
import { decodeBase64Url, encodeBase64Url } from "@hailproto/codec/base64url";
import { canonicalizeHailAddress } from "../identity/address.js";
import { ed25519PublicKeyFromDidKey } from "../identity/did-key.js";
import { accountRequestBytes } from "../accounts/routes.js";
import { tokenHash, type AccountApiRepository, type AccountApiSession } from "../accounts/repository.js";
import { parseJsonWithoutDuplicateKeys } from "../discovery/strict-json.js";
import { clientAddress, FixedWindowRateLimit } from "../http/rate-limit.js";
import { SignupEmailError } from "./email.js";
import { SignupMonitorError, type SignupMonitorService } from "./monitor.js";
import { OnboardingRepository } from "./repository.js";
import type { AlphaMonitoringPolicy, PublicOnboarding, PublicOnboardingPreparation } from "./public.js";
import {RegistrationPolicy,RegistrationError} from "./registration.js";
import { CustomDomains, CustomDomainError } from "../accounts/custom-domains.js";

const UUID=/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/,TOKEN=/^hailp_[A-Za-z0-9_-]{43}$/;
const equal=(a:Uint8Array,b:Uint8Array)=>a.length===b.length&&timingSafeEqual(Buffer.from(a),Buffer.from(b));
interface SignupRequest {address:string;recoveryKey:string;identityKey:string;enrollmentHash:string;invitationDigest:string;addressAuthorizationDigest?:string;}
interface SignupRow {
  recovery_package:boolean;recovery_operation_digest:Uint8Array|null;backup_confirmed_at:Date|null;publication_started_at:Date|null;
  id:string;token_hash:Uint8Array;enrollment_hash:Uint8Array;request_digest:Uint8Array;request:SignupRequest|string;
  account_id:string|null;account_generation:number|string|null;preparation:PublicOnboardingPreparation|string|null;expires_at:Date;
  operation_bytes:Uint8Array|null;monitor_payload:Uint8Array|null;monitor_signature:Uint8Array|null;
  activation_epoch:string|null;enrollment_capability_id:string|null;enrollment_issued_at:Date|null;
  enrollment_expires_at:Date|null;enrollment_generation:number|string|null;
  enrolled_at:Date|null;enrolled_credential_id:string|null;completed_at:Date|null;
}
export class SignupError extends Error {constructor(readonly status:number,message="Signup not completed; retain the original setup state"){super(message);}}
const decoded=<T>(value:T|string):T=>typeof value==="string"?JSON.parse(value) as T:value;

export class SignupCoordinator {
  constructor(private readonly sql:SQL,private readonly onboarding:PublicOnboarding,private readonly monitor:SignupMonitorService,
    private readonly origin:string,private readonly policy:AlphaMonitoringPolicy,invitationKey:string,
    private readonly domains:CustomDomains=new CustomDomains(sql,origin)){this.registration=new RegistrationPolicy(sql,origin,invitationKey);}
  get domainSetup(){return this.domains.standalone;}
  private readonly registration:RegistrationPolicy;

  private async row(id:string,token:string,sql=this.sql):Promise<SignupRow>{
    const row=(await sql<(SignupRow&{live:boolean;current_generation:boolean})[]>`SELECT c.*,expires_at>clock_timestamp() AS live,
      (c.account_id IS NULL OR EXISTS (SELECT 1 FROM account_serving_generations g WHERE g.account_id=c.account_id AND g.generation=c.account_generation)) AS current_generation
      FROM account_signup_ceremonies c WHERE id=${id}`)[0];
    if(!row||!TOKEN.test(token)||!equal(row.token_hash,tokenHash(token)))throw new SignupError(401);
    if(row.completed_at)throw new SignupError(403,"Signup authority is retired; sign in with your passkey");
    if(!row.current_generation)throw new SignupError(403,"Signup generation retired; use current account authentication");
    if(!row.live||row.expires_at.getTime()<=Date.now())throw new SignupError(410,"Setup authority expired; retain the recovery kit and original signup artifacts for provider assistance or existing owner-proof access");
    return row;
  }
  private async prepareAccount(row:SignupRow,transaction?:SQL):Promise<SignupRow>{
    if(row.account_id)return row;
    const request=decoded(row.request);
    const prepared=await this.onboarding.prepare(request.address,request.recoveryKey,request.identityKey,!row.recovery_package,"managed",
      this.policy.monitorOrigin,this.policy.monitorPublicKey,row.token_hash,true,row.recovery_package,transaction);
    const sql=transaction??this.sql;
    await sql`UPDATE account_signup_ceremonies c SET account_id=${prepared.accountId},account_generation=g.generation,
      preparation=(${JSON.stringify(prepared)}::text)::jsonb FROM account_serving_generations g
      WHERE c.id=${row.id} AND g.account_id=${prepared.accountId} AND g.generation=1 AND c.account_id IS NULL
        AND c.completed_at IS NULL AND c.expires_at>clock_timestamp() RETURNING c.id`;
    const current=await this.rowById(row.id,sql);
    if(current.account_id!==prepared.accountId||Number(current.account_generation)!==1)throw new SignupError(403);
    return current;
  }
  private async rowById(id:string,sql=this.sql):Promise<SignupRow>{return (await sql<SignupRow[]>`SELECT * FROM account_signup_ceremonies WHERE id=${id}`)[0]!;}

  async checkAddress(input:Record<string,unknown>){
    if(!Object.hasOwn(input,"invitation"))input={...input,invitation:""};
    const hasAuthorization=Object.hasOwn(input,"addressAuthorization");
    if(Object.keys(input).length!==(hasAuthorization?3:2)||Object.keys(input).some(key=>!["address","invitation","addressAuthorization"].includes(key))||
      typeof input.address!=="string"||typeof input.invitation!=="string"||input.invitation.length>2048||
      hasAuthorization&&(typeof input.addressAuthorization!=="string"||!/^haild_[A-Za-z0-9_-]{43}$/.test(input.addressAuthorization)))
      throw new SignupError(400);
    let address:string;
    try{address=canonicalizeHailAddress(input.address);}catch{throw new SignupError(400,"Invalid address");}
    const custom=address.split("@")[1]!==new URL(this.origin).hostname;
    if(custom!==hasAuthorization)throw new SignupError(400,"Custom addresses require exact-address authorization");
    if(custom)await this.domains.checkAddressAuthorization(input.addressAuthorization as string,address);
    else await this.registration.check(input.invitation);
    const held=await this.sql`SELECT 1 FROM provider_accounts WHERE canonical_address=${address} AND (address_released_at IS NULL OR address_released_at>clock_timestamp()-interval '3630 seconds')
      UNION ALL SELECT 1 FROM transfer_address_reservations WHERE canonical_address=${address}
      UNION ALL SELECT 1 FROM provider_reserved_names WHERE local_part=split_part(${address}, '@', 1) LIMIT 1`;
    return {address,available:held.length===0};
  }

  async prepare(input:Record<string,unknown>,token:string){
    if(!Object.hasOwn(input,"invitation"))input={...input,invitation:""};
    const allowed=["signupId","address","recoveryKey","identityKey","enrollmentHash","invitation","backupVerified","managedAccepted","alphaMonitoringAccepted"];
    const authorization=input.addressAuthorization;
    if(Object.hasOwn(input,"addressAuthorization")){
      if(typeof authorization!=="string"||!/^haild_[A-Za-z0-9_-]{43}$/.test(authorization))throw new SignupError(400,"Invalid address authorization");
      allowed.push("addressAuthorization");
    }
    if(Object.keys(input).length!==allowed.length||Object.keys(input).some(key=>!allowed.includes(key))||
      typeof input.signupId!=="string"||!UUID.test(input.signupId)||!TOKEN.test(token)||
      typeof input.address!=="string"||typeof input.recoveryKey!=="string"||input.recoveryKey.length>256||
      typeof input.identityKey!=="string"||input.identityKey.length>256||typeof input.enrollmentHash!=="string"||
      typeof input.invitation!=="string"||input.invitation.length>2048||typeof input.backupVerified!=="boolean"||input.managedAccepted!==true||input.alphaMonitoringAccepted!==true)
      throw new SignupError(400,"Explicit custody, recovery backup and reduced-assurance consent are required");
    try{
      if(![P256_JWT_ALG,SECP256K1_JWT_ALG].includes(parseDidKey(input.recoveryKey).jwtAlg))throw new Error();
      await ed25519PublicKeyFromDidKey(input.identityKey);
    }catch{throw new SignupError(400,"Use only the recovery and identity public did:key values");}
    const enrollmentHash=decodeBase64Url(input.enrollmentHash,32),signupHash=tokenHash(token);
    if(equal(enrollmentHash,signupHash))throw new SignupError(400,"Passkey enrollment and signup authority must be separate");
    const request:SignupRequest={address:canonicalizeHailAddress(input.address),recoveryKey:input.recoveryKey,identityKey:input.identityKey,
      enrollmentHash:input.enrollmentHash,invitationDigest:createHash("sha256").update(input.invitation).digest("base64url")};
    const custom=request.address.split("@")[1]!==new URL(this.origin).hostname;
    if(custom!==(typeof authorization==="string"))throw new SignupError(400,"Custom addresses require exact-address authorization");
    if(custom)request.addressAuthorizationDigest=createHash("sha256").update(authorization as string).digest("base64url");
    const digest=new Uint8Array(createHash("sha256").update(JSON.stringify(request)).digest());
    const prior=(await this.sql<SignupRow[]>`SELECT * FROM account_signup_ceremonies WHERE id=${input.signupId}`)[0];
    if(!prior){
      await this.sql.begin(async tx=>{
        // Keep custom authority consumption, admission and reservation atomic.
        // This never issues a reusable invitation for another address.
        if(custom)await this.domains.consumeAddressAuthorization(tx,authorization as string,request.address,input.signupId as string,signupHash,digest);
        const invitationId=custom
          ?await this.registration.admitCustomAddress(tx,input.signupId as string,request.address,signupHash,digest)
          :await this.registration.admit(signupHash,digest,"browser",input.invitation as string,tx as unknown as SQL);
        if((await tx`SELECT id FROM account_api_credentials WHERE token_hash IN (${signupHash},${enrollmentHash})`).length||
          (await tx`SELECT id FROM account_passkey_enrollment_capabilities WHERE token_hash IN (${signupHash},${enrollmentHash})`).length)
          throw new SignupError(409,"Existing account credentials cannot be used as setup authority");
        await tx`INSERT INTO account_signup_ceremonies(id,invitation_id,token_hash,enrollment_hash,request_digest,request,recovery_package)
          VALUES(${input.signupId as string},${invitationId},${signupHash},${enrollmentHash},${digest},(${JSON.stringify(request)}::text)::jsonb,${!input.backupVerified})
          ON CONFLICT (id) DO NOTHING`;
        if(custom){
          const row=await this.row(input.signupId as string,token,tx);
          if(row.recovery_package!==!input.backupVerified||!equal(row.request_digest,digest))throw new SignupError(409,"Signup retry differs from its original intent");
          if(!row.account_id){
            const prepared=await this.prepareAccount(row,tx);
            if(await this.domains.standalone.exists(authorization as string,tx))
              await this.domains.standalone.attach(tx,authorization as string,row.id,prepared.account_id!);
          }
        }
      });
    }
    let row=await this.row(input.signupId,token);
    if(row.recovery_package !== !input.backupVerified || !equal(row.request_digest,digest))throw new SignupError(409,"Signup retry differs from its original intent");
    row=await this.prepareAccount(row);
    return this.summary(row);
  }

  async status(id:string,token:string){return this.summary(await this.row(id,token));}
  private async summary(row:SignupRow){
    const account=row.account_id?await new OnboardingRepository(this.sql).getAccount(row.account_id):null;
    const hasPasskey=row.account_id&&(await this.sql`SELECT credential_id FROM account_passkeys WHERE account_id=${row.account_id}`).length>0;
    const state=row.recovery_package&&!row.backup_confirmed_at?"recovery-required":row.completed_at?"complete":row.enrolled_at||hasPasskey?"sign-in-required":account?.state==="active"?
      row.enrollment_expires_at&&row.enrollment_expires_at.getTime()<=Date.now()?"enrollment-expired":"passkey-enrollment":
      (row.recovery_package?row.publication_started_at:row.operation_bytes)?"awaiting-monitor":row.preparation?"prepared":"preparing";
    const operation=row.operation_bytes?JSON.parse(new TextDecoder().decode(row.operation_bytes)) as Operation:null;
    return {type:"hail.signup",version:1,signupId:row.id,accountId:row.account_id,operation,did:account?.did??(operation?await didForCreateOp(operation):null),address:account?.canonicalAddress??decoded(row.request).address,
      state,expiresAt:row.expires_at.toISOString(),preparation:row.preparation?decoded(row.preparation):null,
      enrollmentExpiresAt:row.enrollment_expires_at?.toISOString()??null};
  }

  private async validateOperation(row:SignupRow, input:unknown):Promise<Operation> {
    let operation:Operation;
    try{
      operation=def.operation.strict().parse(input);const prepared=decoded(row.preparation!);
      const {sig,...unsigned}=operation;
      if(!isDeepStrictEqual(unsigned,{type:"plc_operation",prev:null,rotationKeys:[prepared.userRecoveryKey,prepared.providerRotationKey],
        verificationMethods:{"hail-identity":prepared.userIdentityKey,"hail-messaging":prepared.providerMessagingKey},
        alsoKnownAs:[],services:{hail:{type:"HailMessaging",endpoint:prepared.sourceServiceBase}}})||encodeDagCbor(operation).length>7500)throw new Error();
      await assureValidSig([prepared.userRecoveryKey],operation);
    }catch{throw new SignupError(400,"Use the exact prepared genesis with a valid owner signature");}
    return operation;
  }

  async verifyBackup(id:string,token:string,input:Record<string,unknown>){
    if(Object.keys(input).length!==2||input.backupVerified!==true||typeof input.operationDigest!=="string"||
      !/^[A-Za-z0-9_-]{43}$/.test(input.operationDigest))throw new SignupError(400,"Verify the saved recovery package first");
    const digest=decodeBase64Url(input.operationDigest,32),row=await this.row(id,token);
    if(!row.recovery_package)throw new SignupError(409,"Continue the original signup format");
    if(!row.account_id||!row.preparation)throw new SignupError(409,"Finish the original provisional preparation first");
    await this.sql.begin(async tx=>{
      // The ceremony lock serializes verification and makes lost responses safe to retry.
      await tx`SELECT id FROM account_signup_ceremonies WHERE id=${id} FOR UPDATE`;
      const retained=await this.row(id,token,tx as SQL);
      if(retained.recovery_operation_digest&&!equal(retained.recovery_operation_digest,digest))throw new SignupError(409,"The saved package belongs to another identity");
      if(retained.backup_confirmed_at)return;
      await tx`UPDATE account_signup_ceremonies SET backup_confirmed_at=clock_timestamp(),recovery_operation_digest=${digest} WHERE id=${id}`;
      const promoted=await tx`INSERT INTO public_onboarding_preparations
        (account_id,owner_recovery_public_key,owner_identity_public_key,provider_rotation_public_key,provider_messaging_public_key,
         monitor_origin,monitor_public_key,custody_profile,managed_profile_version,backup_confirmed_at,signup_token_hash,monitor_assurance)
        SELECT account_id,owner_recovery_public_key,owner_identity_public_key,provider_rotation_public_key,provider_messaging_public_key,
         monitor_origin,monitor_public_key,custody_profile,managed_profile_version,clock_timestamp(),signup_token_hash,monitor_assurance
        FROM public_onboarding_drafts WHERE account_id=${retained.account_id} RETURNING account_id`;
      if(promoted.length!==1)throw new SignupError(409,"Original provisional preparation is unavailable");
    });
    return this.status(id,token);
  }

  async advance(id:string,token:string,input:Record<string,unknown>){
    let row=await this.row(id,token);
    if(Object.keys(input).some(key=>!["operation","enrollmentToken"].includes(key))||typeof input.enrollmentToken!=="string"||
      !TOKEN.test(input.enrollmentToken)||!equal(tokenHash(input.enrollmentToken),row.enrollment_hash))throw new SignupError(400,"Use the original independent enrollment token");
    const enrollmentToken=input.enrollmentToken;
    const connection=await this.sql.reserve();let locked=false;
    try{
      // ponytail: one connection-held global signup lock; partition with a bounded worker pool if alpha throughput requires it.
      locked=(await connection<{locked:boolean}[]>`SELECT pg_try_advisory_lock(684245160) AS locked`)[0]!.locked;
      if(!locked)throw new SignupError(202,"Another signup step is running; retry with the same state");
      row=await this.row(id,token,connection as SQL);row=await this.prepareAccount(row);
      if(row.recovery_package&&!row.backup_confirmed_at)throw new SignupError(409,"Verify the saved recovery package before publication");
      const epoch=randomUUID();
      const admitted=await connection`UPDATE account_signup_ceremonies SET activation_epoch=${epoch}
        WHERE id=${id} AND completed_at IS NULL AND expires_at>clock_timestamp() RETURNING id`;
      if(!admitted.length)throw new SignupError(410);
      if(input.operation!==undefined){
        const operation=await this.validateOperation(row,input.operation);
        const bytes=new TextEncoder().encode(JSON.stringify(row.recovery_package?input.operation:operation));
        if(row.recovery_package&&(!row.recovery_operation_digest||!equal(new Uint8Array(createHash("sha256").update(bytes).digest()),row.recovery_operation_digest)))
          throw new SignupError(409,"Publish only the identity in the verified recovery package");
        if(bytes.length>16384)throw new SignupError(400);
        if(row.operation_bytes&&!equal(row.operation_bytes,bytes))throw new SignupError(409,"Retain the original signed genesis; do not generate another identity");
        if(!row.operation_bytes){await connection`UPDATE account_signup_ceremonies SET operation_bytes=${bytes} WHERE id=${id}`;row.operation_bytes=bytes;}
      }
      if(!row.operation_bytes)return this.summary(row);
      await connection`UPDATE account_signup_ceremonies SET publication_started_at=COALESCE(publication_started_at,clock_timestamp()) WHERE id=${id}`;
      const repository=new OnboardingRepository(this.sql);
      let account=await repository.getAccount(row.account_id!);
      if(account.state!=="active"){
        // A new epoch fences any abandoned controller before its activation can commit.
        if(account.state==="activating"&&account.activationAttemptId){
          const binding=await repository.getBindingForAccount(account.id);
          await repository.cancelActivation(account.id,binding.id,account.activationAttemptId);
        }
        await this.onboarding.register(account.id,row.operation_bytes,new Uint8Array());
        const monitored=await this.monitor.enroll(account.id,id,token);
        if(monitored.status===202)return {...await this.summary(await this.rowById(id)),state:"awaiting-monitor"};
        const signed=monitored.body.attestation as {payload:string;signature:string};
        const payload=decodeBase64Url(signed.payload),signature=decodeBase64Url(signed.signature,64);
        await connection`UPDATE account_signup_ceremonies SET monitor_payload=${payload},monitor_signature=${signature} WHERE id=${id}`;
        await this.onboarding.activate(account.id,{payloadBytes:payload,signature},{id,epoch});
        account=await repository.getAccount(account.id);
      }
      return await this.sql.begin(async tx=>{
        const current=(await tx<SignupRow[]>`SELECT * FROM account_signup_ceremonies WHERE id=${id}
          AND completed_at IS NULL AND expires_at>clock_timestamp() FOR UPDATE`)[0];
        if(!current||current.activation_epoch!==epoch||current.expires_at.getTime()<=Date.now())throw new SignupError(403);
        const generation=(await tx<{generation:number|string}[]>`SELECT g.generation FROM account_serving_generations g
          JOIN provider_accounts account ON account.id=g.account_id WHERE account.id=${account.id} AND account.onboarding_state='active'
          FOR UPDATE OF g,account`)[0];
        if(!generation||Number(current.account_generation)!==Number(generation.generation)||
          current.enrollment_generation!==null&&Number(current.enrollment_generation)!==Number(generation.generation)||
          (await tx`SELECT did FROM provider_migration_fences WHERE account_id=${account.id}`).length)throw new SignupError(403);
        if(current.enrolled_at||(await tx`SELECT credential_id FROM account_passkeys WHERE account_id=${account.id}`).length)
          return {...await this.summary(current),state:"sign-in-required"};
        if(current.enrollment_issued_at){
          if(current.enrollment_expires_at!.getTime()<=Date.now())return {...await this.summary(current),state:"enrollment-expired"};
          const capability=await tx`SELECT id FROM account_passkey_enrollment_capabilities WHERE id=${current.enrollment_capability_id}
            AND token_hash=${current.enrollment_hash} AND consumed_at IS NULL AND expires_at>clock_timestamp()`;
          if(!capability.length)throw new SignupError(409,"Enrollment is terminal; sign in or use owner-proof recovery");
        }else{
          if((await tx`SELECT id FROM account_api_credentials WHERE token_hash IN (${current.token_hash},${current.enrollment_hash})`).length)
            throw new SignupError(409);
          const capabilityId=randomUUID(),issued=(await tx<{instant:Date}[]>`SELECT clock_timestamp() AS instant`)[0]!.instant;
          const expires=new Date(issued.getTime()+600_000);
          await tx`INSERT INTO account_passkey_enrollment_capabilities(id,token_hash,account_id,serving_generation,created_at,expires_at)
            VALUES(${capabilityId},${current.enrollment_hash},${account.id},${generation.generation},${issued},${expires})`;
          await tx`UPDATE account_signup_ceremonies SET enrollment_capability_id=${capabilityId},enrollment_issued_at=${issued},
            enrollment_expires_at=${expires},enrollment_generation=${generation.generation} WHERE id=${id}`;
          current.enrollment_expires_at=expires;
        }
        return {...await this.summary(current),state:"passkey-enrollment",enrollment:{url:`${this.origin}/auth/recover#token=${encodeURIComponent(enrollmentToken)}`,
          expiresAt:current.enrollment_expires_at!.toISOString()}};
      });
    }finally{
      try{if(locked)await connection`SELECT pg_advisory_unlock(684245160)`;}finally{connection.release();}
    }
  }

  async complete(id:string,session:AccountApiSession){
    if(!session.passkey_credential_id)throw new SignupError(403,"Sign in with a passkey before retiring setup authority");
    return this.sql.begin(async tx=>{
      const row=(await tx<(SignupRow&{login_at:Date})[]>`SELECT c.*,s.created_at AS login_at FROM account_signup_ceremonies c
        JOIN provider_accounts account ON account.id=c.account_id AND account.onboarding_state='active'
        JOIN account_serving_generations g ON g.account_id=account.id AND g.generation=c.account_generation
        JOIN account_passkey_sessions s ON s.account_id=account.id AND s.serving_generation=g.generation
        JOIN account_passkeys key ON key.credential_id=s.credential_id AND key.account_id=account.id AND key.serving_generation=g.generation
        WHERE c.id=${id} AND account.id=${session.account_id} AND s.id=${session.credential_id} AND s.credential_id=${session.passkey_credential_id}
          AND s.revoked_at IS NULL AND s.expires_at>clock_timestamp() AND s.last_seen_at>clock_timestamp()-interval '30 minutes'
          AND key.revoked_at IS NULL AND (c.enrollment_generation IS NULL OR c.enrollment_generation=g.generation)
          AND NOT EXISTS (SELECT 1 FROM provider_migration_fences WHERE account_id=account.id)
        FOR UPDATE OF c,account,g,s,key`)[0];
      if(!row)throw new SignupError(403);
      if(row.completed_at)return {state:"complete",signupId:id,accountId:row.account_id};
      if(row.login_at.getTime()<=Date.now()-300_000)throw new SignupError(403,"Use a fresh passkey sign-in to finish setup");
      const retired=await tx`UPDATE public_onboarding_preparations SET signup_token_hash=NULL WHERE account_id=${row.account_id}
        AND signup_token_hash=${row.token_hash} RETURNING account_id`;
      if(!retired.length)throw new SignupError(409);
      if(row.enrollment_capability_id)await tx`UPDATE account_passkey_enrollment_capabilities
        SET expires_at=GREATEST(created_at+interval '1 microsecond',LEAST(expires_at,clock_timestamp())) WHERE id=${row.enrollment_capability_id}`;
      await tx`UPDATE account_signup_ceremonies SET enrolled_at=COALESCE(enrolled_at,clock_timestamp()),
        enrolled_credential_id=COALESCE(enrolled_credential_id,${session.passkey_credential_id}),completed_at=clock_timestamp(),completed_by=${session.passkey_credential_id}
        WHERE id=${id}`;
      return {state:"complete",signupId:id,accountId:row.account_id};
    });
  }
}

export function registerSignupRoutes(app:Hono,signup:SignupCoordinator,accounts:AccountApiRepository,origin:string){
  registerStandaloneDomainRoutes(app,signup.domainSetup,origin);
  const rate=new FixedWindowRateLimit();
  app.all("/api/v1/signup/:id?/:step?",async context=>{
    context.header("Cache-Control","no-store");
    const suppliedOrigin=context.req.header("Origin");
    if(suppliedOrigin!==origin&&!(context.req.method==="GET"&&suppliedOrigin===undefined))return context.json({error:"Signup origin refused"},403);
    const retry=rate.take(clientAddress(context.req.raw),20);
    if(retry!==null){context.header("Retry-After",String(retry));return context.json({error:"Rate limited"},429);}
    const id=context.req.param("id"),step=context.req.param("step"),token=/^Bearer (hailp_[A-Za-z0-9_-]{43})$/.exec(context.req.header("Authorization")??"")?.[1];
    try{
      if(id&&id!=="check-address"&&!UUID.test(id))throw new SignupError(400);
      if(id==="check-address"&&(context.req.method!=="POST"||step))throw new SignupError(405);
      if(id&&step==="complete"&&context.req.method==="POST"){
        const session=await accounts.authenticate(undefined,getCookie(context,"hail_session"));
        if(!session)throw new SignupError(401);
        return context.json(await signup.complete(id,session));
      }
      if(!token)throw new SignupError(401);
      if(id&&!step&&context.req.method==="GET")return context.json(await signup.status(id,token));
      if(context.req.method!=="POST")throw new SignupError(405);
      if(context.req.header("Content-Type")!=="application/json"||context.req.header("Content-Encoding")!==undefined)throw new SignupError(415);
      const bytes=await accountRequestBytes(context.req.raw,32_768);if(!bytes)throw new SignupError(413);
      let input:Record<string,unknown>;
      try{input=parseJsonWithoutDuplicateKeys(new TextDecoder("utf-8",{fatal:true}).decode(bytes)) as Record<string,unknown>;}
      catch{throw new SignupError(400);}
      if(!input||typeof input!=="object"||Array.isArray(input))throw new SignupError(400);
      if(id==="check-address"&&!step)return context.json(await signup.checkAddress(input));
      if(!id&&!step)return context.json(await signup.prepare(input,token));
      if(id&&step==="verify-backup")return context.json(await signup.verifyBackup(id,token,input));
      if(id&&step==="advance"){
        const result=await signup.advance(id,token,input);
        const pending=result.state==="awaiting-monitor";
        if(pending)context.header("Retry-After","15");
        return context.json(result,pending?202:200);
      }
      throw new SignupError(404);
    }catch(error){
      const postgres=error as {code?:unknown;errno?:unknown}|null;
      const status=error instanceof SignupError||error instanceof RegistrationError||error instanceof SignupMonitorError||error instanceof SignupEmailError||error instanceof CustomDomainError?error.status:
        postgres?.code==="23505"||postgres?.errno==="23505"?409:503;
      if(status===202||status===503)context.header("Retry-After","15");
      return new Response(JSON.stringify({error:error instanceof SignupError||error instanceof RegistrationError?error.message:"Signup not completed; retain the original setup state"}),{
        status,headers:{"Content-Type":"application/json","Cache-Control":"no-store",...(status===202||status===503?{"Retry-After":"15"}:{})}});
    }
  });
}
