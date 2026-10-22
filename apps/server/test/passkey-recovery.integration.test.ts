import {randomBytes,randomUUID} from "node:crypto";
import {SQL} from "bun";
import {afterAll,beforeAll,describe,expect,it} from "vitest";
import {encodeBase64Url} from "@hailproto/codec";

import {ProviderDatabase} from "../src/db/database.js";
import {PasskeyAuth} from "../src/accounts/passkeys.js";
import {tokenHash} from "../src/accounts/repository.js";

const integration=process.env.DATABASE_URL?describe:describe.skip;
integration("owner-proof passkey recovery",()=>{
  let admin:SQL,db:ProviderDatabase,schema:string,account:string,other:string,passkeys:PasskeyAuth;
  const token=()=>`hailp_${encodeBase64Url(randomBytes(32))}`;
  const response=(id:string)=>({id,rawId:id,type:"public-key" as const,response:{clientDataJSON:"AA",attestationObject:"AA",transports:[]},clientExtensionResults:{}});
  const capability=async(secret:string)=>{
    const id=randomUUID();
    await db.sql`INSERT INTO account_passkey_enrollment_capabilities(id,token_hash,account_id,serving_generation,expires_at)
      VALUES(${id},${tokenHash(secret)},${account},1,now()+interval '10 minutes')`;
    return {id,...await passkeys.recoveryOptions(secret)};
  };

  beforeAll(async()=>{
    admin=new SQL(process.env.DATABASE_URL!);schema=`recovery_${randomUUID().replaceAll("-","")}`;
    await admin.unsafe(`CREATE SCHEMA "${schema}"`);const url=new URL(process.env.DATABASE_URL!);url.searchParams.set("options",`-csearch_path=${schema}`);
    db=new ProviderDatabase(url.toString());await db.migrate();passkeys=new PasskeyAuth(db.sql,"example.com","https://example.com",
      async({response})=>({verified:true,registrationInfo:{credential:{id:response.id,publicKey:randomBytes(64),counter:0,transports:[]},
        credentialDeviceType:"multiDevice",credentialBackedUp:true,fmt:"none",aaguid:"00000000-0000-0000-0000-000000000000",
        credentialType:"public-key",attestationObject:new Uint8Array(),userVerified:true,credentialBackedUpStatus:false,
        origin:"https://example.com",rpID:"example.com"}}));
    account=randomUUID();other=randomUUID();
    for(const [id,address] of [[account,"owner@example.com"],[other,"other@example.com"]])await db.sql`
      INSERT INTO provider_accounts(id,tenant_id,canonical_address,did,onboarding_state,activated_at,activation_binding_digest,activation_verification_mode)
      VALUES(${id},${randomUUID()},${address},${`did:plc:${(id===account?"a":"b").repeat(24)}`},'active',now(),${randomBytes(32)},'public')`;
  });
  afterAll(async()=>{if(db)await db.close();if(admin){await admin.unsafe(`DROP SCHEMA "${schema}" CASCADE`);await admin.close();}});

  it("survives a lost response but rejects reuse for another credential",async()=>{
    const secret=token(),start=await capability(secret),credential=encodeBase64Url(randomBytes(32));
    const first=await passkeys.recover(secret,start.challengeId,response(credential),"Recovered phone");
    expect(first).toEqual({registered:true,credentialId:credential,label:"Recovered phone"});
    expect(await passkeys.recover(secret,start.challengeId,response(credential),"Changed label")).toEqual(first);
    await expect(passkeys.recover(secret,start.challengeId,response(encodeBase64Url(randomBytes(32))),"Other"))
      .rejects.toMatchObject({status:400});
    const duplicate=token(),duplicateStart=await capability(duplicate);
    await expect(passkeys.recover(duplicate,duplicateStart.challengeId,response(credential),"Duplicate"))
      .rejects.toMatchObject({status:409});
    expect(await db.sql`SELECT credential_id FROM account_passkeys WHERE account_id=${account}`).toHaveLength(1);
  });

  it("rejects expired, wrong-account, and wrong-generation capabilities",async()=>{
    const expired=token(),expiredStart=await capability(expired);
    await db.sql`UPDATE account_passkey_enrollment_capabilities SET created_at=now()-interval '20 minutes',expires_at=now()-interval '10 minutes' WHERE id=${expiredStart.id}`;
    await expect(passkeys.recoveryOptions(expired)).rejects.toMatchObject({status:401});

    const wrongAccount=token(),accountStart=await capability(wrongAccount);
    await db.sql`UPDATE account_passkey_challenges SET account_id=${other} WHERE id=${accountStart.challengeId}`;
    await expect(passkeys.recover(wrongAccount,accountStart.challengeId,response(encodeBase64Url(randomBytes(32))),"Wrong"))
      .rejects.toMatchObject({status:401});

    const wrongGeneration=token(),generationStart=await capability(wrongGeneration);
    await db.sql`UPDATE account_passkey_challenges SET serving_generation=2 WHERE id=${generationStart.challengeId}`;
    await expect(passkeys.recover(wrongGeneration,generationStart.challengeId,response(encodeBase64Url(randomBytes(32))),"Wrong"))
      .rejects.toMatchObject({status:401});
  });
});
