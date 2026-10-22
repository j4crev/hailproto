import {randomBytes,randomUUID} from "node:crypto";
import {SQL} from "bun";
import {afterAll,beforeAll,describe,expect,it,vi} from "vitest";
import {encodeBase64Url} from "@hailproto/codec";

import {PasskeyAuth} from "../src/accounts/passkeys.js";
import {ProviderDatabase} from "../src/db/database.js";

const integration=process.env.DATABASE_URL?describe:describe.skip;
integration("passkey authentication",()=>{
  let admin:SQL,db:ProviderDatabase,schema:string,account:string,credential:string,passkeys:PasskeyAuth;
  const response=()=>({id:credential,rawId:credential,type:"public-key" as const,response:{clientDataJSON:"AA",authenticatorData:"AA",signature:"AA"},clientExtensionResults:{}});
  const verify=vi.fn(async()=>({verified:true,authenticationInfo:{credentialID:credential,newCounter:1,userVerified:true,credentialDeviceType:"singleDevice" as const,
    credentialBackedUp:false,origin:"https://example.com",rpID:"example.com"}}));

  beforeAll(async()=>{
    admin=new SQL(process.env.DATABASE_URL!);schema=`passkey_auth_${randomUUID().replaceAll("-","")}`;
    await admin.unsafe(`CREATE SCHEMA "${schema}"`);const url=new URL(process.env.DATABASE_URL!);url.searchParams.set("options",`-csearch_path=${schema}`);
    db=new ProviderDatabase(url.toString());await db.migrate();account=randomUUID();credential=encodeBase64Url(randomBytes(32));
    await db.sql`INSERT INTO provider_accounts(id,tenant_id,canonical_address,did,onboarding_state,activated_at,activation_binding_digest,activation_verification_mode)
      VALUES(${account},${randomUUID()},'passkey@example.com',${`did:plc:${"a".repeat(24)}`},'active',now(),${randomBytes(32)},'public')`;
    await db.sql`INSERT INTO account_passkeys(credential_id,account_id,serving_generation,public_key,device_type,backed_up,label)
      VALUES(${credential},${account},1,${randomBytes(64)},'singleDevice',false,'Test passkey')`;
    passkeys=new PasskeyAuth(db.sql,"example.com","https://example.com",undefined,verify);
  });
  afterAll(async()=>{if(db)await db.close();if(admin){await admin.unsafe(`DROP SCHEMA "${schema}" CASCADE`);await admin.close();}});

  it("consumes one challenge once and updates the authenticator counter",async()=>{
    const start=await passkeys.authenticationOptions(),attempts=await Promise.allSettled([
      passkeys.authenticate(start.challengeId,response()),passkeys.authenticate(start.challengeId,response())]);
    expect(attempts.filter(result=>result.status==="fulfilled")).toHaveLength(1);
    expect(attempts.filter(result=>result.status==="rejected")).toHaveLength(1);
    expect(Number((await db.sql<{signature_counter:number|string}[]>`SELECT signature_counter FROM account_passkeys WHERE credential_id=${credential}`)[0]?.signature_counter)).toBe(1);
    await expect(passkeys.authenticate(start.challengeId,response())).rejects.toMatchObject({status:400});
    expect(verify).toHaveBeenCalledWith(expect.objectContaining({expectedOrigin:"https://example.com",expectedRPID:"example.com",requireUserVerification:true}));
  });

  it("rejects expired, wrong-purpose, unknown and inactive-generation attempts",async()=>{
    const expired=await passkeys.authenticationOptions();await db.sql`UPDATE account_passkey_challenges
      SET created_at=now()-interval '10 minutes',expires_at=now()-interval '5 minutes' WHERE id=${expired.challengeId}`;
    await expect(passkeys.authenticate(expired.challengeId,response())).rejects.toMatchObject({status:400});
    const purpose=await passkeys.authenticationOptions();await db.sql`UPDATE account_passkey_challenges
      SET purpose='registration',account_id=${account},serving_generation=1 WHERE id=${purpose.challengeId}`;
    await expect(passkeys.authenticate(purpose.challengeId,response())).rejects.toMatchObject({status:400});
    const unknown=await passkeys.authenticationOptions(),known=credential;credential=encodeBase64Url(randomBytes(32));
    await expect(passkeys.authenticate(unknown.challengeId,response())).rejects.toMatchObject({status:401});credential=known;
    await db.sql.begin(async tx=>{await tx`SELECT set_config('hail.returning_account',${account},true)`;await tx`UPDATE account_serving_generations SET generation=2 WHERE account_id=${account}`;});
    const stale=await passkeys.authenticationOptions();await expect(passkeys.authenticate(stale.challengeId,response())).rejects.toMatchObject({status:401});
  });
});
