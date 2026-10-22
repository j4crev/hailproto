import {randomBytes,randomUUID} from "node:crypto";
import {generateAuthenticationOptions,generateRegistrationOptions,verifyAuthenticationResponse,
  verifyRegistrationResponse,type AuthenticationResponseJSON,type RegistrationResponseJSON} from "@simplewebauthn/server";
import {COSEALG} from "@simplewebauthn/server/helpers";
import {encodeBase64Url} from "@hailproto/codec";
import type {SQL} from "bun";
import {tokenHash,type AccountApiSession,type AccountApiScope} from "./repository.js";

const UUID=/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/;
const ID=/^[A-Za-z0-9_-]{1,1366}$/;
const SESSION_SCOPES:AccountApiScope[]=["account:read","grants:read","messages:read","messages:write"];

function uuidBytes(value:string){
  if(!UUID.test(value))throw new Error("Invalid account ID");
  return Uint8Array.from(Buffer.from(value.replaceAll("-",""),"hex"));
}

export class PasskeyError extends Error {
  constructor(readonly status:400|401|403|404|409|429){super("Passkey request refused");}
}

export class PasskeyAuth {
  constructor(private readonly sql:SQL,readonly rpId:string,readonly origin:string){}

  async registrationOptions(session:AccountApiSession){
    if(!session.scopes.includes("credentials:write"))throw new PasskeyError(403);
    const existing=await this.sql<{credential_id:string;transports:unknown}[]>`
      SELECT credential_id,transports FROM account_passkeys WHERE account_id=${session.account_id} AND revoked_at IS NULL`;
    const options=await generateRegistrationOptions({rpName:"Hail",rpID:this.rpId,userID:uuidBytes(session.account_id),
      userName:session.canonical_address,userDisplayName:session.canonical_address,attestationType:"none",
      timeout:300_000,
      authenticatorSelection:{residentKey:"required",userVerification:"required"},supportedAlgorithmIDs:[COSEALG.ES256],
      excludeCredentials:existing.map(row=>({id:row.credential_id,transports:Array.isArray(row.transports)?row.transports as string[]:[]}))});
    const challengeId=randomUUID();
    await this.sql`DELETE FROM account_passkey_challenges WHERE expires_at<=now()`;
    await this.sql`INSERT INTO account_passkey_challenges
      (id,challenge,purpose,account_id,serving_generation,expires_at)
      VALUES (${challengeId},${options.challenge},'registration',${session.account_id},${session.serving_generation??1},now()+interval '5 minutes')`;
    return {challengeId,options};
  }

  async register(session:AccountApiSession,challengeId:string,response:RegistrationResponseJSON,label:string){
    if(!session.scopes.includes("credentials:write"))throw new PasskeyError(403);
    if(!UUID.test(challengeId)||!label.trim()||label.trim().length>80||!ID.test(response.id))throw new PasskeyError(400);
    const challenge=await this.challenge(challengeId,"registration",session.account_id,session.serving_generation??1);
    let result;
    try{result=await verifyRegistrationResponse({response,expectedChallenge:challenge,expectedOrigin:this.origin,
      expectedRPID:this.rpId,requireUserVerification:true,supportedAlgorithmIDs:[COSEALG.ES256]});}
    catch{throw new PasskeyError(400);}
    if(!result.verified||!result.registrationInfo)throw new PasskeyError(400);
    const info=result.registrationInfo,credential=info.credential;
    try{await this.sql.begin(async tx=>{
      const consumed=await tx`DELETE FROM account_passkey_challenges WHERE id=${challengeId} AND challenge=${challenge} AND expires_at>now() RETURNING id`;
      if(!consumed.length)throw new PasskeyError(400);
      await tx`INSERT INTO account_passkeys
        (credential_id,account_id,serving_generation,public_key,signature_counter,device_type,backed_up,transports,label)
        VALUES (${credential.id},${session.account_id},${session.serving_generation??1},${credential.publicKey},${credential.counter},
          ${info.credentialDeviceType},${info.credentialBackedUp},(${JSON.stringify(credential.transports??response.response.transports??[])}::text)::jsonb,${label.trim()})`;
    });}
    catch(error){if(error&&typeof error==="object"&&"code" in error&&(error as {code?:string}).code==="23505")throw new PasskeyError(409);throw error;}
    return {registered:true,credentialId:credential.id,label:label.trim()};
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
    const rows=await this.sql<{credential_id:string;account_id:string;serving_generation:number|string;public_key:Uint8Array;
      signature_counter:number|string;transports:unknown;device_type:"singleDevice"|"multiDevice";backed_up:boolean}[]>`
      SELECT key.credential_id,key.account_id,key.serving_generation,key.public_key,key.signature_counter,key.transports,key.device_type,key.backed_up
      FROM account_passkeys key JOIN provider_accounts account ON account.id=key.account_id
      JOIN account_serving_generations generation ON generation.account_id=account.id AND generation.generation=key.serving_generation
      LEFT JOIN provider_migration_fences fence ON fence.account_id=account.id
      WHERE key.credential_id=${response.id} AND key.revoked_at IS NULL AND account.onboarding_state='active'
        AND account.did IS NOT NULL AND fence.account_id IS NULL`;
    const row=rows[0];if(!row)throw new PasskeyError(401);
    let result;
    try{result=await verifyAuthenticationResponse({response,expectedChallenge:challenge,expectedOrigin:this.origin,
      expectedRPID:this.rpId,requireUserVerification:true,credential:{id:row.credential_id,publicKey:new Uint8Array(row.public_key),
        counter:Number(row.signature_counter),transports:Array.isArray(row.transports)?row.transports as string[]:[]}});}
    catch{throw new PasskeyError(401);}
    if(!result.verified)throw new PasskeyError(401);
    const token=`hails_${encodeBase64Url(randomBytes(32))}`,id=randomUUID(),generation=Number(row.serving_generation);
    await this.sql.begin(async tx=>{
      const consumed=await tx`DELETE FROM account_passkey_challenges WHERE id=${challengeId} AND challenge=${challenge} AND expires_at>now() RETURNING id`;
      if(!consumed.length)throw new PasskeyError(401);
      const updated=await tx`UPDATE account_passkeys SET signature_counter=${result.authenticationInfo.newCounter},
        backed_up=${result.authenticationInfo.credentialBackedUp},last_used_at=now()
        WHERE credential_id=${row.credential_id} AND revoked_at IS NULL AND serving_generation=${generation}
          AND signature_counter=${Number(row.signature_counter)} RETURNING credential_id`;
      if(!updated.length)throw new PasskeyError(401);
      await tx`INSERT INTO account_passkey_sessions
        (id,token_hash,account_id,credential_id,serving_generation,scopes,expires_at)
        VALUES (${id},${tokenHash(token)},${row.account_id},${row.credential_id},${generation},
          (${JSON.stringify(SESSION_SCOPES)}::text)::jsonb,now()+interval '12 hours')`;
    });
    return {token,expiresAt:new Date(Date.now()+12*60*60*1000)};
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
