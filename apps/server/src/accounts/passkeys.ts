import {createHash,randomBytes,randomUUID} from "node:crypto";
import {generateAuthenticationOptions,generateRegistrationOptions,verifyAuthenticationResponse,
  verifyRegistrationResponse,type AuthenticationResponseJSON,type RegistrationResponseJSON} from "@simplewebauthn/server";
import {COSEALG} from "@simplewebauthn/server/helpers";
import {decodeBase64Url,encodeBase64Url} from "@hailproto/codec";
import type {SQL} from "bun";
import {tokenHash,type AccountApiSession,type AccountApiScope} from "./repository.js";

const UUID=/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/;
const ID=/^[A-Za-z0-9_-]{1,1366}$/;
const SESSION_SCOPES:AccountApiScope[]=["account:read","grants:read","messages:read","messages:write"];
const BROWSER_SCOPES=SESSION_SCOPES;

function uuidBytes(value:string){
  if(!UUID.test(value))throw new Error("Invalid account ID");
  return Uint8Array.from(Buffer.from(value.replaceAll("-",""),"hex"));
}
function loopback(value:string){
  const url=new URL(value),port=Number(url.port);
  if(url.protocol!=="http:"||url.hostname!=="127.0.0.1"||url.pathname!=="/callback"||url.username||url.password||
    url.search||url.hash||!Number.isSafeInteger(port)||port<1024||port>65535)throw new PasskeyError(400);
  return url;
}
function uniqueConflict(error:unknown){
  const value=error as {code?:unknown;errno?:unknown}|null;
  return value?.code==="23505"||value?.errno==="23505";
}

export class PasskeyError extends Error {
  constructor(readonly status:400|401|403|404|409|429){super("Passkey request refused");}
}

export class PasskeyAuth {
  constructor(private readonly sql:SQL,readonly rpId:string,readonly origin:string,
    private readonly verifyRegistration:typeof verifyRegistrationResponse=verifyRegistrationResponse){}

  private management(session:AccountApiSession){
    if(session.scopes.includes("credentials:write")||session.passkey_verified_at&&
      session.passkey_verified_at.getTime()>Date.now()-5*60_000)return;
    throw new PasskeyError(403);
  }

  async registrationOptions(session:AccountApiSession){
    this.management(session);
    const existing=await this.sql<{credential_id:string;transports:unknown}[]>`
      SELECT credential_id,transports FROM account_passkeys WHERE account_id=${session.account_id} AND revoked_at IS NULL`;
    const options=await generateRegistrationOptions({rpName:"Hail",rpID:this.rpId,userID:uuidBytes(session.account_id),
      userName:session.canonical_address,userDisplayName:session.canonical_address,attestationType:"none",
      timeout:300_000,
      authenticatorSelection:{residentKey:"required",userVerification:"required"},supportedAlgorithmIDs:[COSEALG.ES256,COSEALG.RS256],
      excludeCredentials:existing.map(row=>({id:row.credential_id,transports:Array.isArray(row.transports)?row.transports as string[]:[]}))});
    const challengeId=randomUUID();
    await this.sql`DELETE FROM account_passkey_challenges WHERE expires_at<=now()`;
    await this.sql`INSERT INTO account_passkey_challenges
      (id,challenge,purpose,account_id,serving_generation,expires_at)
      VALUES (${challengeId},${options.challenge},'registration',${session.account_id},${session.serving_generation??1},now()+interval '5 minutes')`;
    return {challengeId,options};
  }

  async register(session:AccountApiSession,challengeId:string,response:RegistrationResponseJSON,label:string){
    this.management(session);
    if(!UUID.test(challengeId)||!label.trim()||label.trim().length>80||!ID.test(response.id))throw new PasskeyError(400);
    const challenge=await this.challenge(challengeId,"registration",session.account_id,session.serving_generation??1);
    return this.completeRegistration(session.account_id,session.serving_generation??1,challengeId,challenge,response,label);
  }

  private async completeRegistration(accountId:string,generation:number,challengeId:string,challenge:string,
    response:RegistrationResponseJSON,label:string,capabilityId?:string){
    let result;
    try{result=await this.verifyRegistration({response,expectedChallenge:challenge,expectedOrigin:this.origin,
      expectedRPID:this.rpId,requireUserVerification:true,supportedAlgorithmIDs:[COSEALG.ES256,COSEALG.RS256]});}
    catch{throw new PasskeyError(400);}
    if(!result.verified||!result.registrationInfo)throw new PasskeyError(400);
    const info=result.registrationInfo,credential=info.credential;
    try{return await this.sql.begin(async tx=>{
      if(capabilityId){
        const capability=await tx<{credential_id:string|null}[]>`SELECT capability.credential_id
          FROM account_passkey_enrollment_capabilities capability JOIN account_passkey_challenges challenge
            ON challenge.enrollment_capability_id=capability.id
          WHERE capability.id=${capabilityId} AND capability.account_id=${accountId} AND capability.serving_generation=${generation}
            AND capability.expires_at>now() AND challenge.id=${challengeId} AND challenge.challenge=${challenge}
            AND challenge.expires_at>now() FOR UPDATE OF capability`;
        if(!capability[0])throw new PasskeyError(400);
        if(capability[0].credential_id){
          const prior=await tx<{credential_id:string;label:string}[]>`SELECT capability.credential_id,key.label
            FROM account_passkey_enrollment_capabilities capability JOIN account_passkeys key ON key.credential_id=capability.credential_id
            WHERE capability.id=${capabilityId} AND capability.account_id=${accountId} AND capability.serving_generation=${generation}
              AND capability.expires_at>now() AND capability.credential_id=${response.id}`;
          if(!prior[0])throw new PasskeyError(400);
          return {registered:true,credentialId:prior[0].credential_id,label:prior[0].label};
        }
      }else{
        const consumed=await tx`DELETE FROM account_passkey_challenges WHERE id=${challengeId} AND challenge=${challenge}
          AND expires_at>now() AND enrollment_capability_id IS NULL RETURNING id`;
        if(!consumed.length)throw new PasskeyError(400);
      }
      await tx`INSERT INTO account_passkeys
        (credential_id,account_id,serving_generation,public_key,signature_counter,device_type,backed_up,transports,label)
        VALUES (${credential.id},${accountId},${generation},${credential.publicKey},${credential.counter},
          ${info.credentialDeviceType},${info.credentialBackedUp},(${JSON.stringify(credential.transports??response.response.transports??[])}::text)::jsonb,${label.trim()})`;
      if(capabilityId){
        await tx`UPDATE account_passkey_enrollment_capabilities SET consumed_at=now(),credential_id=${credential.id} WHERE id=${capabilityId}`;
        await tx`UPDATE account_signup_ceremonies SET enrolled_at=COALESCE(enrolled_at,clock_timestamp()),
          enrolled_credential_id=COALESCE(enrolled_credential_id,${credential.id}) WHERE enrollment_capability_id=${capabilityId}
          AND account_id=${accountId} AND enrollment_generation=${generation}`;
      }
      return {registered:true,credentialId:credential.id,label:label.trim()};
    });}
    catch(error){if(uniqueConflict(error))throw new PasskeyError(409);throw error;}
  }

  async recoveryOptions(token:string){
    if(!/^hailp_[A-Za-z0-9_-]{43}$/.test(token))throw new PasskeyError(401);
    await this.sql`DELETE FROM account_passkey_enrollment_capabilities WHERE expires_at<=now()`;
    const rows=await this.sql<{id:string;account_id:string;serving_generation:number|string;canonical_address:string}[]>`
      SELECT capability.id,capability.account_id,capability.serving_generation,account.canonical_address
      FROM account_passkey_enrollment_capabilities capability JOIN provider_accounts account ON account.id=capability.account_id
      JOIN account_serving_generations generation ON generation.account_id=account.id AND generation.generation=capability.serving_generation
      LEFT JOIN provider_migration_fences fence ON fence.account_id=account.id
      WHERE capability.token_hash=${tokenHash(token)} AND capability.consumed_at IS NULL AND capability.expires_at>now()
        AND account.closed_at IS NULL AND account.onboarding_state='active' AND account.did IS NOT NULL AND fence.account_id IS NULL`;
    const row=rows[0];if(!row)throw new PasskeyError(401);
    const existing=await this.sql<{credential_id:string;transports:unknown}[]>`SELECT credential_id,transports FROM account_passkeys
      WHERE account_id=${row.account_id} AND serving_generation=${Number(row.serving_generation)} AND revoked_at IS NULL`;
    const options=await generateRegistrationOptions({rpName:"Hail",rpID:this.rpId,userID:uuidBytes(row.account_id),
      userName:row.canonical_address,userDisplayName:row.canonical_address,attestationType:"none",timeout:300_000,
      authenticatorSelection:{residentKey:"required",userVerification:"required"},supportedAlgorithmIDs:[COSEALG.ES256,COSEALG.RS256],
      excludeCredentials:existing.map(key=>({id:key.credential_id,transports:Array.isArray(key.transports)?key.transports as string[]:[]}))});
    const challengeId=randomUUID();
    await this.sql`INSERT INTO account_passkey_challenges
      (id,challenge,purpose,account_id,serving_generation,expires_at,enrollment_capability_id)
      VALUES (${challengeId},${options.challenge},'registration',${row.account_id},${Number(row.serving_generation)},now()+interval '5 minutes',${row.id})`;
    return {challengeId,options};
  }

  async prepareAuthorization(input:Record<string,unknown>){
    if(Object.keys(input).length!==6||Object.keys(input).some(key=>!["clientId","redirectUri","state","code","codeChallenge","scopes"].includes(key))||
      input.clientId!=="hailp-cli-v1"||typeof input.redirectUri!=="string"||typeof input.state!=="string"||
      typeof input.code!=="string"||typeof input.codeChallenge!=="string"||!Array.isArray(input.scopes)||
      !/^[A-Za-z0-9_-]{43}$/.test(input.state)||!/^hailc_[A-Za-z0-9_-]{43}$/.test(input.code)||
      !/^[A-Za-z0-9_-]{43}$/.test(input.codeChallenge)||new Set(input.scopes).size!==input.scopes.length||
      input.scopes.some(scope=>!BROWSER_SCOPES.includes(scope as AccountApiScope)))throw new PasskeyError(400);
    const redirectUri=input.redirectUri as string,state=input.state as string,code=input.code as string,
      codeChallenge=input.codeChallenge as string,requested=input.scopes as unknown[];
    loopback(redirectUri);const scopes=BROWSER_SCOPES.filter(scope=>requested.includes(scope));
    if(!scopes.length||JSON.stringify(scopes)!==JSON.stringify(requested))throw new PasskeyError(400);
    return this.sql.begin(async tx=>{
      await tx`SELECT pg_advisory_xact_lock(684245135)`;
      await tx`DELETE FROM account_browser_authorizations WHERE expires_at<now()-interval '1 day'`;
      const prior=await tx<{id:string;client_id:string;redirect_uri:string;state:string;code_challenge:string;scopes:unknown;expires_at:Date}[]>`
        SELECT id,client_id,redirect_uri,state,code_challenge,scopes,expires_at FROM account_browser_authorizations
        WHERE code_hash=${tokenHash(code)} FOR UPDATE`;
      if(prior[0]){
        const priorScopes=typeof prior[0].scopes==="string"?JSON.parse(prior[0].scopes):prior[0].scopes;
        if(prior[0].client_id!==input.clientId||prior[0].redirect_uri!==redirectUri||prior[0].state!==state||
          prior[0].code_challenge!==codeChallenge||JSON.stringify(priorScopes)!==JSON.stringify(scopes)||prior[0].expires_at.getTime()<=Date.now())
          throw new PasskeyError(409);
        return {requestId:prior[0].id,authorizationUrl:`${this.origin}/auth/authorize?request=${prior[0].id}&state=${state}#code=${code}`,
          expiresAt:prior[0].expires_at.toISOString()};
      }
      const id=randomUUID(),inserted=await tx<{expires_at:Date}[]>`INSERT INTO account_browser_authorizations
        (id,client_id,redirect_uri,state,code_hash,code_challenge,scopes,expires_at)
        VALUES(${id},${input.clientId},${redirectUri},${state},${tokenHash(code)},${codeChallenge},
          (${JSON.stringify(scopes)}::text)::jsonb,now()+interval '5 minutes') RETURNING expires_at`;
      return {requestId:id,authorizationUrl:`${this.origin}/auth/authorize?request=${id}&state=${state}#code=${code}`,
        expiresAt:inserted[0]!.expires_at.toISOString()};
    });
  }

  async authorizationDetails(requestId:string,state:string){
    if(!UUID.test(requestId)||!/^[A-Za-z0-9_-]{43}$/.test(state))throw new PasskeyError(400);
    const rows=await this.sql<{client_id:string;redirect_uri:string;scopes:unknown;expires_at:Date}[]>`
      SELECT client_id,redirect_uri,scopes,expires_at FROM account_browser_authorizations
      WHERE id=${requestId} AND state=${state} AND exchanged_at IS NULL AND expires_at>now()`;
    const row=rows[0];if(!row)throw new PasskeyError(404);
    return {clientId:row.client_id,redirectUri:row.redirect_uri,scopes:typeof row.scopes==="string"?JSON.parse(row.scopes):row.scopes,
      expiresAt:row.expires_at.toISOString()};
  }

  async completeAuthorization(session:AccountApiSession,requestId:string,state:string,code:string){
    if(!session.passkey_credential_id||!session.passkey_verified_at||session.passkey_verified_at.getTime()<=Date.now()-5*60_000)
      throw new PasskeyError(403);
    if(!UUID.test(requestId)||!/^[A-Za-z0-9_-]{43}$/.test(state)||!/^hailc_[A-Za-z0-9_-]{43}$/.test(code))throw new PasskeyError(400);
    return this.sql.begin(async tx=>{
      const rows=await tx<{redirect_uri:string;account_id:string|null;serving_generation:number|string|null}[]>`
        SELECT redirect_uri,account_id,serving_generation FROM account_browser_authorizations
        WHERE id=${requestId} AND state=${state} AND code_hash=${tokenHash(code)} AND exchanged_at IS NULL AND expires_at>now() FOR UPDATE`;
      const row=rows[0];if(!row)throw new PasskeyError(404);const generation=session.serving_generation??1;
      if(row.account_id&&(row.account_id!==session.account_id||Number(row.serving_generation)!==generation))throw new PasskeyError(409);
      if(!row.account_id)await tx`UPDATE account_browser_authorizations SET account_id=${session.account_id},serving_generation=${generation},completed_at=now()
        WHERE id=${requestId}`;
      const redirect=loopback(row.redirect_uri);redirect.searchParams.set("code",code);redirect.searchParams.set("state",state);
      return {redirectUri:redirect.toString()};
    });
  }

  async exchangeAuthorization(input:Record<string,unknown>){
    if(Object.keys(input).length!==5||Object.keys(input).some(key=>!["clientId","redirectUri","code","verifier","token"].includes(key))||
      input.clientId!=="hailp-cli-v1"||typeof input.redirectUri!=="string"||typeof input.code!=="string"||
      typeof input.verifier!=="string"||typeof input.token!=="string"||!/^hailc_[A-Za-z0-9_-]{43}$/.test(input.code)||
      !/^[A-Za-z0-9_-]{43}$/.test(input.verifier)||!/^hailp_[A-Za-z0-9_-]{43}$/.test(input.token))throw new PasskeyError(400);
    const redirectUri=input.redirectUri as string,code=input.code as string,verifier=input.verifier as string,token=input.token as string;
    loopback(redirectUri);const challenge=encodeBase64Url(new Uint8Array(createHash("sha256").update(verifier).digest()));
    try{return await this.sql.begin(async tx=>{
      const rows=await tx<{id:string;account_id:string;serving_generation:number|string;scopes:unknown;credential_id:string|null}[]>`
        SELECT auth.id,auth.account_id,auth.serving_generation,auth.scopes,auth.credential_id
        FROM account_browser_authorizations auth JOIN provider_accounts account ON account.id=auth.account_id
        JOIN account_serving_generations generation ON generation.account_id=account.id AND generation.generation=auth.serving_generation
        LEFT JOIN provider_migration_fences fence ON fence.account_id=account.id
        WHERE auth.code_hash=${tokenHash(code)} AND auth.client_id=${input.clientId}
          AND auth.redirect_uri=${redirectUri} AND auth.code_challenge=${challenge}
          AND auth.completed_at IS NOT NULL AND auth.expires_at>now()
          AND account.closed_at IS NULL AND account.onboarding_state='active' AND account.did IS NOT NULL AND fence.account_id IS NULL FOR UPDATE OF auth`;
      const row=rows[0];if(!row)throw new PasskeyError(401);const scopes=typeof row.scopes==="string"?JSON.parse(row.scopes) as AccountApiScope[]:row.scopes as AccountApiScope[];
      let credentialId=row.credential_id;
      if(!credentialId){
        if((await tx`SELECT id FROM account_api_credentials WHERE token_hash=${tokenHash(token)}`).length)throw new PasskeyError(409);
        credentialId=randomUUID();await tx`INSERT INTO account_api_credentials(id,account_id,token_hash,scopes,expires_at)
          VALUES(${credentialId},${row.account_id},${tokenHash(token)},(${JSON.stringify(scopes)}::text)::jsonb,now()+interval '30 days')`;
        await tx`UPDATE account_browser_authorizations SET exchanged_at=now(),credential_id=${credentialId} WHERE id=${row.id}`;
      }
      const credential=await tx<{expires_at:Date}[]>`SELECT expires_at FROM account_api_credentials WHERE id=${credentialId}
        AND account_id=${row.account_id} AND token_hash=${tokenHash(token)} AND revoked_at IS NULL AND expires_at>now()`;
      if(!credential[0])throw new PasskeyError(401);
      return {type:"hailp.api-credential",version:1,provider:this.origin,accountId:row.account_id,credentialId,token,
        scopes,expiresAt:credential[0].expires_at.toISOString()};
    });}catch(error){if(uniqueConflict(error))throw new PasskeyError(409);throw error;}
  }

  async recover(token:string,challengeId:string,response:RegistrationResponseJSON,label:string){
    if(!/^hailp_[A-Za-z0-9_-]{43}$/.test(token)||!UUID.test(challengeId)||!label.trim()||label.trim().length>80||!ID.test(response.id))
      throw new PasskeyError(400);
    const rows=await this.sql<{challenge:string;account_id:string;serving_generation:number|string;capability_id:string}[]>`
      SELECT challenge.challenge,challenge.account_id,challenge.serving_generation,capability.id AS capability_id
      FROM account_passkey_challenges challenge JOIN account_passkey_enrollment_capabilities capability
        ON capability.id=challenge.enrollment_capability_id AND capability.account_id=challenge.account_id
          AND capability.serving_generation=challenge.serving_generation
      JOIN account_serving_generations generation ON generation.account_id=capability.account_id AND generation.generation=capability.serving_generation
      JOIN provider_accounts account ON account.id=capability.account_id
      LEFT JOIN provider_migration_fences fence ON fence.account_id=account.id
      WHERE challenge.id=${challengeId} AND challenge.purpose='registration' AND challenge.expires_at>now()
        AND capability.token_hash=${tokenHash(token)} AND capability.expires_at>now()
        AND account.closed_at IS NULL AND account.onboarding_state='active' AND account.did IS NOT NULL AND fence.account_id IS NULL`;
    const row=rows[0];if(!row)throw new PasskeyError(401);
    return this.completeRegistration(row.account_id,Number(row.serving_generation),challengeId,row.challenge,response,label,row.capability_id);
  }

  async list(session:AccountApiSession){
    if(!session.passkey_credential_id&&!session.scopes.includes("credentials:write"))throw new PasskeyError(403);
    const rows=await this.sql<{credential_id:string;label:string;device_type:string;backed_up:boolean;created_at:Date;last_used_at:Date|null}[]>`
      SELECT credential_id,label,device_type,backed_up,created_at,last_used_at FROM account_passkeys
      WHERE account_id=${session.account_id} AND serving_generation=${session.serving_generation??1} AND revoked_at IS NULL
      ORDER BY created_at,credential_id`;
    const sessions=await this.sql<{id:string;label:string;created_at:Date;last_seen_at:Date}[]>`
      SELECT s.id,p.label,s.created_at,s.last_seen_at FROM account_passkey_sessions s
      JOIN account_passkeys p ON p.credential_id=s.credential_id AND p.revoked_at IS NULL
      WHERE s.account_id=${session.account_id} AND s.serving_generation=${session.serving_generation??1}
        AND s.revoked_at IS NULL AND s.expires_at>now() AND s.last_seen_at>now()-interval '30 minutes'
      ORDER BY s.created_at DESC,s.id`;
    return {sessions:sessions.map(row=>({id:row.id,label:row.label,createdAt:row.created_at.toISOString(),
      lastSeenAt:row.last_seen_at.toISOString(),current:row.id===session.credential_id})),recentlyVerified:session.scopes.includes("credentials:write")||Boolean(session.passkey_verified_at&&
      session.passkey_verified_at.getTime()>Date.now()-5*60_000),passkeys:rows.map(row=>({credentialId:row.credential_id,label:row.label,
      deviceType:row.device_type,backedUp:row.backed_up,createdAt:row.created_at.toISOString(),
      lastUsedAt:row.last_used_at?.toISOString()??null,current:row.credential_id===session.passkey_credential_id}))};
  }

  async rename(session:AccountApiSession,credentialId:string,label:string){
    this.management(session);
    if(!ID.test(credentialId)||!label.trim()||label.trim().length>80)throw new PasskeyError(400);
    const rows=await this.sql`UPDATE account_passkeys SET label=${label.trim()} WHERE credential_id=${credentialId}
      AND account_id=${session.account_id} AND serving_generation=${session.serving_generation??1} AND revoked_at IS NULL RETURNING credential_id`;
    if(!rows.length)throw new PasskeyError(404);return {renamed:true};
  }

  async revoke(session:AccountApiSession,credentialId:string){
    this.management(session);
    if(!ID.test(credentialId))throw new PasskeyError(400);
    await this.sql.begin(async tx=>{
      const rows=await tx<{credential_id:string}[]>`SELECT credential_id FROM account_passkeys WHERE account_id=${session.account_id}
        AND serving_generation=${session.serving_generation??1} AND revoked_at IS NULL FOR UPDATE`;
      if(!rows.some(row=>row.credential_id===credentialId))throw new PasskeyError(404);
      if(credentialId===session.passkey_credential_id||rows.length===1)throw new PasskeyError(409);
      await tx`UPDATE account_passkeys SET revoked_at=now() WHERE credential_id=${credentialId}`;
      await tx`UPDATE account_passkey_sessions SET revoked_at=COALESCE(revoked_at,now()) WHERE credential_id=${credentialId} AND revoked_at IS NULL`;
    });
    return {revoked:true};
  }

  async revokeSessions(session:AccountApiSession,sessionIds?:string[]){
    this.management(session);
    if(sessionIds!==undefined&&(!Array.isArray(sessionIds)||!sessionIds.length||
      sessionIds.some(id=>typeof id!=="string"||!UUID.test(id))))throw new PasskeyError(400);
    if(sessionIds){
      await this.sql`UPDATE account_passkey_sessions SET revoked_at=COALESCE(revoked_at,now())
        WHERE account_id=${session.account_id} AND serving_generation=${session.serving_generation??1}
          AND id IN ${this.sql(sessionIds)} AND revoked_at IS NULL`;
    }else{
      await this.sql`UPDATE account_passkey_sessions SET revoked_at=COALESCE(revoked_at,now())
        WHERE account_id=${session.account_id} AND serving_generation=${session.serving_generation??1} AND revoked_at IS NULL`;
    }
    return {revoked:true};
  }

  async authenticationOptions(){
    const options=await generateAuthenticationOptions({rpID:this.rpId,userVerification:"required",timeout:300_000}),challengeId=randomUUID();
    await this.sql`DELETE FROM account_passkey_challenges WHERE expires_at<=now()`;
    await this.sql`INSERT INTO account_passkey_challenges (id,challenge,purpose,expires_at)
      VALUES (${challengeId},${options.challenge},'authentication',now()+interval '5 minutes')`;
    return {challengeId,options};
  }

  async authenticate(challengeId:string,response:AuthenticationResponseJSON){
    if(!UUID.test(challengeId)||!ID.test(response.id))throw new PasskeyError(400);
    const challenge=await this.challenge(challengeId,"authentication");
    const {row,result}=await this.verifyAssertion(challenge,response);
    const token=`hails_${encodeBase64Url(randomBytes(32))}`,id=randomUUID(),generation=Number(row.serving_generation);
    await this.sql.begin(async tx=>{
      const consumed=await tx`DELETE FROM account_passkey_challenges WHERE id=${challengeId} AND challenge=${challenge} AND expires_at>now() RETURNING id`;
      if(!consumed.length)throw new PasskeyError(401);
      await this.recordAssertion(tx,row,result.authenticationInfo);
      await tx`INSERT INTO account_passkey_sessions
        (id,token_hash,account_id,credential_id,serving_generation,scopes,expires_at)
        VALUES (${id},${tokenHash(token)},${row.account_id},${row.credential_id},${generation},
          (${JSON.stringify(SESSION_SCOPES)}::text)::jsonb,now()+interval '12 hours')`;
    });
    return {token,expiresAt:new Date(Date.now()+12*60*60*1000)};
  }

  async actionOptions(session:AccountApiSession,challenge:string){
    const keys=await this.sql<{credential_id:string;transports:unknown}[]>`SELECT credential_id,transports FROM account_passkeys
      WHERE account_id=${session.account_id} AND serving_generation=${session.serving_generation??1} AND revoked_at IS NULL`;
    if(!session.passkey_credential_id||!keys.length)throw new PasskeyError(403);
    return generateAuthenticationOptions({rpID:this.rpId,challenge:Uint8Array.from(decodeBase64Url(challenge,32)),userVerification:"required",timeout:300_000,
      allowCredentials:keys.map(key=>({id:key.credential_id,transports:Array.isArray(key.transports)?key.transports as string[]:[]}))});
  }

  // The caller atomically consumes its own exact-action challenge. This issues
  // neither a session nor an API credential and cannot be used for login.
  async approveAction(sql:SQL,session:AccountApiSession,challenge:string,response:AuthenticationResponseJSON){
    const {row,result}=await this.verifyAssertion(challenge,response,sql);
    if(!session.passkey_credential_id||row.account_id!==session.account_id||Number(row.serving_generation)!==(session.serving_generation??1))throw new PasskeyError(403);
    await this.recordAssertion(sql,row,result.authenticationInfo);
    return row.credential_id;
  }

  private async verifyAssertion(challenge:string,response:AuthenticationResponseJSON,sql=this.sql){
    if(!response||!ID.test(response.id))throw new PasskeyError(400);
    const rows=await sql<{credential_id:string;account_id:string;serving_generation:number|string;public_key:Uint8Array;
      signature_counter:number|string;transports:unknown;device_type:"singleDevice"|"multiDevice";backed_up:boolean}[]>`
      SELECT key.credential_id,key.account_id,key.serving_generation,key.public_key,key.signature_counter,key.transports,key.device_type,key.backed_up
      FROM account_passkeys key JOIN provider_accounts account ON account.id=key.account_id
      JOIN account_serving_generations generation ON generation.account_id=account.id AND generation.generation=key.serving_generation
      LEFT JOIN provider_migration_fences fence ON fence.account_id=account.id
      WHERE key.credential_id=${response.id} AND key.revoked_at IS NULL AND account.closed_at IS NULL AND account.onboarding_state='active'
        AND account.did IS NOT NULL AND fence.account_id IS NULL`;
    const row=rows[0];if(!row)throw new PasskeyError(401);
    let result;
    try{result=await verifyAuthenticationResponse({response,expectedChallenge:challenge,expectedOrigin:this.origin,
      expectedRPID:this.rpId,requireUserVerification:true,credential:{id:row.credential_id,publicKey:new Uint8Array(row.public_key),
        counter:Number(row.signature_counter),transports:Array.isArray(row.transports)?row.transports as string[]:[]}});}
    catch{throw new PasskeyError(401);}
    if(!result.verified)throw new PasskeyError(401);
    return {row,result};
  }

  private async recordAssertion(sql:SQL,row:{credential_id:string;serving_generation:number|string;signature_counter:number|string},info:{newCounter:number;credentialBackedUp:boolean}){
      const updated=await sql`UPDATE account_passkeys SET signature_counter=${info.newCounter},
        backed_up=${info.credentialBackedUp},last_used_at=now()
        WHERE credential_id=${row.credential_id} AND revoked_at IS NULL AND serving_generation=${Number(row.serving_generation)}
          AND signature_counter=${Number(row.signature_counter)} RETURNING credential_id`;
      if(!updated.length)throw new PasskeyError(401);
  }

  async logout(token:string|undefined){
    if(/^hails_[A-Za-z0-9_-]{43}$/.test(token??""))await this.sql`
      UPDATE account_passkey_sessions SET revoked_at=COALESCE(revoked_at,now()) WHERE token_hash=${tokenHash(token!)}`;
  }

  private async challenge(id:string,purpose:"registration"|"authentication",accountId?:string,generation?:number){
    const rows=await this.sql<{challenge:string}[]>`SELECT challenge FROM account_passkey_challenges WHERE id=${id} AND purpose=${purpose}
      AND expires_at>now() AND (${accountId??null}::uuid IS NULL OR account_id=${accountId??null}::uuid)
      AND (${generation??null}::bigint IS NULL OR serving_generation=${generation??null}::bigint)`;
    if(!rows[0])throw new PasskeyError(400);return rows[0].challenge;
  }
}
