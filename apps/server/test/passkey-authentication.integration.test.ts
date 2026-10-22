import {createHash,generateKeyPairSync,randomBytes,randomUUID,sign} from "node:crypto";
import {SQL} from "bun";
import {afterAll,beforeAll,describe,expect,it} from "vitest";
import {encodeBase64Url} from "@hailproto/codec";

import {PasskeyAuth} from "../src/accounts/passkeys.js";
import {ProviderDatabase} from "../src/db/database.js";
import {AccountApiRepository} from "../src/accounts/repository.js";
import type {AccountApiSession} from "../src/accounts/repository.js";

const integration=process.env.DATABASE_URL?describe:describe.skip;
integration("passkey authentication",()=>{
  let admin:SQL,db:ProviderDatabase,schema:string,account:string,credential:string,passkeys:PasskeyAuth;
  const keys=generateKeyPairSync("ec",{namedCurve:"prime256v1"}),jwk=keys.publicKey.export({format:"jwk"});
  const cose=Buffer.concat([Buffer.from("a5010203262001215820","hex"),Buffer.from(jwk.x!,"base64url"),
    Buffer.from("225820","hex"),Buffer.from(jwk.y!,"base64url")]);
  const text=(value:string)=>Buffer.concat([Buffer.from([0x60+value.length]),Buffer.from(value)]);
  const bytes=(value:Buffer)=>Buffer.concat([Buffer.from([0x58,value.length]),value]);
  const response=(challenge:string,change:{id?:string;origin?:string;rpId?:string;clientType?:string;flags?:number;
    badSignature?:boolean;counter?:number;userHandle?:string}={})=>{
    const client=Buffer.from(JSON.stringify({type:change.clientType??"webauthn.get",challenge,origin:change.origin??"https://example.com"}));
    const authenticator=Buffer.alloc(37);createHash("sha256").update(change.rpId??"example.com").digest().copy(authenticator);
    authenticator[32]=change.flags??5;authenticator.writeUInt32BE(change.counter??1,33);
    const signature=sign("sha256",Buffer.concat([authenticator,createHash("sha256").update(client).digest()]),keys.privateKey);
    if(change.badSignature)signature[signature.length-1]=signature[signature.length-1]!^1;
    const id=change.id??credential;return {id,rawId:id,type:"public-key" as const,response:{clientDataJSON:client.toString("base64url"),
      authenticatorData:authenticator.toString("base64url"),signature:signature.toString("base64url"),
      userHandle:Buffer.from((change.userHandle??account).replaceAll("-",""),"hex").toString("base64url")},clientExtensionResults:{}};
  };
  const registration=(challenge:string,id:string,change:{origin?:string;rpId?:string;clientType?:string;flags?:number}={})=>{
    const client=Buffer.from(JSON.stringify({type:change.clientType??"webauthn.create",challenge,origin:change.origin??"https://example.com"}));
    const credentialId=Buffer.from(id,"base64url"),authenticator=Buffer.alloc(55+credentialId.length+cose.length);
    createHash("sha256").update(change.rpId??"example.com").digest().copy(authenticator);authenticator[32]=change.flags??69;
    authenticator.writeUInt16BE(credentialId.length,53);credentialId.copy(authenticator,55);cose.copy(authenticator,55+credentialId.length);
    const attestation=Buffer.concat([Buffer.from([0xa3]),text("fmt"),text("none"),text("attStmt"),Buffer.from([0xa0]),text("authData"),bytes(authenticator)]);
    return {id,rawId:id,type:"public-key" as const,response:{clientDataJSON:client.toString("base64url"),attestationObject:attestation.toString("base64url"),transports:["usb" as const]},clientExtensionResults:{}};
  };

  beforeAll(async()=>{
    admin=new SQL(process.env.DATABASE_URL!);schema=`passkey_auth_${randomUUID().replaceAll("-","")}`;
    await admin.unsafe(`CREATE SCHEMA "${schema}"`);const url=new URL(process.env.DATABASE_URL!);url.searchParams.set("options",`-csearch_path=${schema}`);
    db=new ProviderDatabase(url.toString());await db.migrate();account=randomUUID();credential=encodeBase64Url(randomBytes(32));
    await db.sql`INSERT INTO provider_accounts(id,tenant_id,canonical_address,did,onboarding_state,activated_at,activation_binding_digest,activation_verification_mode)
      VALUES(${account},${randomUUID()},'passkey@example.com',${`did:plc:${"a".repeat(24)}`},'active',now(),${randomBytes(32)},'public')`;
    await db.sql`INSERT INTO account_passkeys(credential_id,account_id,serving_generation,public_key,device_type,backed_up,label)
      VALUES(${credential},${account},1,${cose},'singleDevice',false,'Test passkey')`;
    passkeys=new PasskeyAuth(db.sql,"example.com","https://example.com");
  });
  afterAll(async()=>{if(db)await db.close();if(admin){await admin.unsafe(`DROP SCHEMA "${schema}" CASCADE`);await admin.close();}});

  it("consumes one challenge once and updates the authenticator counter",async()=>{
    const start=await passkeys.authenticationOptions();passkeys=new PasskeyAuth(db.sql,"example.com","https://example.com");
    const attempts=await Promise.allSettled([
      passkeys.authenticate(start.challengeId,response(start.options.challenge)),passkeys.authenticate(start.challengeId,response(start.options.challenge))]);
    expect(attempts.filter(result=>result.status==="fulfilled")).toHaveLength(1);
    expect(attempts.filter(result=>result.status==="rejected")).toHaveLength(1);
    expect(Number((await db.sql<{signature_counter:number|string}[]>`SELECT signature_counter FROM account_passkeys WHERE credential_id=${credential}`)[0]?.signature_counter)).toBe(1);
    await expect(passkeys.authenticate(start.challengeId,response(start.options.challenge))).rejects.toMatchObject({status:400});
  });

  it("rejects wrong origin, RP ID, ceremony type, signature and user verification",async()=>{
    for(const change of [{origin:"https://evil.example"},{rpId:"evil.example"},{clientType:"webauthn.create"},{badSignature:true},{flags:1}]){
      const start=await passkeys.authenticationOptions();
      await expect(passkeys.authenticate(start.challengeId,response(start.options.challenge,{counter:2,...change}))).rejects.toMatchObject({status:401});
    }
  });

  it("verifies registration and rejects its wrong origin, RP ID, ceremony type and user verification",async()=>{
    const session={account_id:account,credential_id:randomUUID(),credential_expires_at:new Date(Date.now()+60_000),
      did:`did:plc:${"a".repeat(24)}`,canonical_address:"passkey@example.com",scopes:["credentials:write"],migration_state:null,
      serving_generation:1,passkey_credential_id:null,passkey_verified_at:null} satisfies AccountApiSession;
    const id=encodeBase64Url(randomBytes(32));
    for(const change of [{origin:"https://evil.example"},{rpId:"evil.example"},{clientType:"webauthn.get"},{flags:65}]){
      const start=await passkeys.registrationOptions(session);
      await expect(passkeys.register(session,start.challengeId,registration(start.options.challenge,id,change),"Rejected"))
        .rejects.toMatchObject({status:400});
    }
    const start=await passkeys.registrationOptions(session);
    passkeys=new PasskeyAuth(db.sql,"example.com","https://example.com");
    await expect(passkeys.register(session,start.challengeId,registration(start.options.challenge,id),"ES256 test passkey"))
      .resolves.toMatchObject({registered:true,credentialId:id});
    await expect(passkeys.register(session,start.challengeId,registration(start.options.challenge,id),"ES256 test passkey"))
      .rejects.toMatchObject({status:400});
    expect(await db.sql`SELECT credential_id FROM account_passkeys WHERE credential_id=${id}`).toHaveLength(1);
  });

  it("binds sessions to the credential account and logs out only the replaced session",async()=>{
    const other=randomUUID(),repository=new AccountApiRepository(db.sql);
    await db.sql`INSERT INTO provider_accounts(id,tenant_id,canonical_address,did,onboarding_state,activated_at,activation_binding_digest,activation_verification_mode)
      VALUES(${other},${randomUUID()},'other@example.com',${`did:plc:${"b".repeat(24)}`},'active',now(),${randomBytes(32)},'public')`;
    const first=await passkeys.authenticationOptions(),old=await passkeys.authenticate(first.challengeId,
      response(first.options.challenge,{counter:2,userHandle:other}));
    expect((await repository.authenticate(undefined,old.token))?.account_id).toBe(account);
    const next=await passkeys.authenticationOptions(),replacement=await passkeys.authenticate(next.challengeId,
      response(next.options.challenge,{counter:3,userHandle:other}));
    await passkeys.logout(old.token);
    expect(await repository.authenticate(undefined,old.token)).toBeNull();
    expect((await repository.authenticate(undefined,replacement.token))?.account_id).toBe(account);
    expect(Number((await db.sql<{signature_counter:number|string}[]>`SELECT signature_counter FROM account_passkeys WHERE credential_id=${credential}`)[0]?.signature_counter)).toBe(3);
  });

  it("accepts zero counters from a backed-up multi-device credential",async()=>{
    const synced=encodeBase64Url(randomBytes(32));
    await db.sql`INSERT INTO account_passkeys(credential_id,account_id,serving_generation,public_key,device_type,backed_up,label)
      VALUES(${synced},${account},1,${cose},'multiDevice',true,'Synced test passkey')`;
    for(let attempt=0;attempt<2;attempt++){
      const start=await passkeys.authenticationOptions();
      await expect(passkeys.authenticate(start.challengeId,response(start.options.challenge,{id:synced,counter:0,flags:29}))).resolves.toHaveProperty("token");
    }
    const row=(await db.sql<{signature_counter:number|string;backed_up:boolean}[]>`SELECT signature_counter,backed_up FROM account_passkeys WHERE credential_id=${synced}`)[0];
    expect(Number(row?.signature_counter)).toBe(0);expect(row?.backed_up).toBe(true);
  });

  it("rejects expired, wrong-purpose, unknown and inactive-generation attempts",async()=>{
    const expired=await passkeys.authenticationOptions();await db.sql`UPDATE account_passkey_challenges
      SET created_at=now()-interval '10 minutes',expires_at=now()-interval '5 minutes' WHERE id=${expired.challengeId}`;
    await expect(passkeys.authenticate(expired.challengeId,response(expired.options.challenge))).rejects.toMatchObject({status:400});
    const purpose=await passkeys.authenticationOptions();await db.sql`UPDATE account_passkey_challenges
      SET purpose='registration',account_id=${account},serving_generation=1 WHERE id=${purpose.challengeId}`;
    await expect(passkeys.authenticate(purpose.challengeId,response(purpose.options.challenge))).rejects.toMatchObject({status:400});
    const unknown=await passkeys.authenticationOptions();
    await expect(passkeys.authenticate(unknown.challengeId,response(unknown.options.challenge,{id:encodeBase64Url(randomBytes(32))}))).rejects.toMatchObject({status:401});
    await db.sql.begin(async tx=>{await tx`SELECT set_config('hail.returning_account',${account},true)`;await tx`UPDATE account_serving_generations SET generation=2 WHERE account_id=${account}`;});
    const stale=await passkeys.authenticationOptions();await expect(passkeys.authenticate(stale.challengeId,response(stale.options.challenge))).rejects.toMatchObject({status:401});
  });
});
