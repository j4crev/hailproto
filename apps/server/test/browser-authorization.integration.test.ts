import {createHash,randomBytes,randomUUID} from "node:crypto";
import {mkdtemp,readFile,rm} from "node:fs/promises";
import {join} from "node:path";
import {tmpdir} from "node:os";
import {SQL} from "bun";
import {afterAll,beforeAll,describe,expect,it} from "vitest";
import {Hono} from "hono";
import {encodeBase64Url} from "@hailproto/codec";
import {browserLogin} from "../../cli/src/browser-login.js";
import {PasskeyAuth} from "../src/accounts/passkeys.js";
import {registerPasskeyRoutes} from "../src/accounts/passkey-routes.js";
import {ProviderDatabase} from "../src/db/database.js";
import type {AccountApiRepository,AccountApiSession} from "../src/accounts/repository.js";

const integration=process.env.DATABASE_URL?describe:describe.skip;
integration("browser authorization code and PKCE",()=>{
  let admin:SQL,db:ProviderDatabase,otherDb:ProviderDatabase,schema:string,otherSchema:string,directory:string,passkeys:PasskeyAuth,app:Hono;
  const origin="https://example.com";
  let session:AccountApiSession;
  const secret=(prefix:string)=>`${prefix}_${encodeBase64Url(randomBytes(32))}`;
  const prepare=async()=>{
    const verifier=encodeBase64Url(randomBytes(32)),code=secret("hailc"),state=encodeBase64Url(randomBytes(32)),redirectUri="http://127.0.0.1:45678/callback";
    const input={clientId:"hailp-cli-v1",redirectUri,state,code,
      codeChallenge:encodeBase64Url(new Uint8Array(createHash("sha256").update(verifier).digest())),scopes:["account:read"]};
    const result=await passkeys.prepareAuthorization(input);return {verifier,code,state,redirectUri,input,...result};
  };
  beforeAll(async()=>{
    admin=new SQL(process.env.DATABASE_URL!);schema=`browser_${randomUUID().replaceAll("-","")}`;otherSchema=`browser_other_${randomUUID().replaceAll("-","")}`;
    await admin.unsafe(`CREATE SCHEMA "${schema}"`);await admin.unsafe(`CREATE SCHEMA "${otherSchema}"`);
    const url=new URL(process.env.DATABASE_URL!);url.searchParams.set("options",`-csearch_path=${schema}`);db=new ProviderDatabase(url.toString());await db.migrate();
    const otherUrl=new URL(process.env.DATABASE_URL!);otherUrl.searchParams.set("options",`-csearch_path=${otherSchema}`);otherDb=new ProviderDatabase(otherUrl.toString());await otherDb.migrate();
    const account=randomUUID();await db.sql`INSERT INTO provider_accounts(id,tenant_id,canonical_address,did,onboarding_state,activated_at,activation_binding_digest,activation_verification_mode)
      VALUES(${account},${randomUUID()},'browser@example.com',${`did:plc:${"a".repeat(24)}`},'active',now(),${randomBytes(32)},'public')`;
    session={account_id:account,credential_id:randomUUID(),credential_expires_at:new Date(Date.now()+60_000),did:`did:plc:${"a".repeat(24)}`,
      canonical_address:"browser@example.com",scopes:["account:read"],migration_state:null,serving_generation:1,
      passkey_credential_id:encodeBase64Url(randomBytes(32)),passkey_verified_at:new Date()};
    directory=await mkdtemp(join(tmpdir(),"hail-browser-login-"));app=new Hono();passkeys=new PasskeyAuth(db.sql,"example.com",origin);
    registerPasskeyRoutes(app,passkeys,{authenticate:async()=>session} as unknown as AccountApiRepository);
  });
  afterAll(async()=>{if(db)await db.close();if(otherDb)await otherDb.close();if(admin){await admin.unsafe(`DROP SCHEMA "${schema}" CASCADE`);
    await admin.unsafe(`DROP SCHEMA "${otherSchema}" CASCADE`);await admin.close();}if(directory)await rm(directory,{recursive:true,force:true});});

  it("exchanges one exact code with PKCE and makes lost responses idempotent",async()=>{
    const request=await prepare(),token=secret("hailp");
    expect(await passkeys.prepareAuthorization(request.input)).toMatchObject({requestId:request.requestId,expiresAt:request.expiresAt});
    const restarted=new PasskeyAuth(db.sql,"example.com",origin);
    expect(await restarted.authorizationDetails(request.requestId,request.state)).toMatchObject({clientId:"hailp-cli-v1",scopes:["account:read"]});
    const redirect=await restarted.completeAuthorization(session,request.requestId,request.state,request.code);
    expect(new URL(redirect.redirectUri).searchParams.get("code")).toBe(request.code);
    const credential=await restarted.exchangeAuthorization({clientId:"hailp-cli-v1",redirectUri:request.redirectUri,code:request.code,verifier:request.verifier,token});
    expect(credential).toMatchObject({type:"hailp.api-credential",accountId:session.account_id,token,scopes:["account:read"]});
    expect(await restarted.exchangeAuthorization({clientId:"hailp-cli-v1",redirectUri:request.redirectUri,code:request.code,verifier:request.verifier,token})).toEqual(credential);
    await expect(restarted.exchangeAuthorization({clientId:"hailp-cli-v1",redirectUri:request.redirectUri,code:request.code,verifier:request.verifier,token:secret("hailp")}))
      .rejects.toMatchObject({status:401});
  });

  it("rejects wrong verifier, account, generation, redirect, expiry and stale verification",async()=>{
    const wrong=await prepare();await expect(passkeys.completeAuthorization({...session,passkey_verified_at:new Date(Date.now()-301_000)},wrong.requestId,wrong.state,wrong.code))
      .rejects.toMatchObject({status:403});
    await passkeys.completeAuthorization(session,wrong.requestId,wrong.state,wrong.code);
    await expect(passkeys.completeAuthorization({...session,account_id:randomUUID()},wrong.requestId,wrong.state,wrong.code)).rejects.toMatchObject({status:409});
    for(const changed of [{verifier:encodeBase64Url(randomBytes(32))},{redirectUri:"http://127.0.0.1:45679/callback"}])
      await expect(passkeys.exchangeAuthorization({clientId:"hailp-cli-v1",redirectUri:wrong.redirectUri,code:wrong.code,verifier:wrong.verifier,token:secret("hailp"),...changed}))
        .rejects.toMatchObject({status:401});
    const expired=await prepare();await db.sql`UPDATE account_browser_authorizations SET created_at=now()-interval '10 minutes',expires_at=now()-interval '5 minutes' WHERE id=${expired.requestId}`;
    await expect(passkeys.completeAuthorization(session,expired.requestId,expired.state,expired.code)).rejects.toMatchObject({status:404});
  });

  it("runs the CLI loopback flow without exposing secrets in its result",async()=>{
    const statePath=join(directory,"browser.state.json"),output=join(directory,"browser.credential.json"),result=await browserLogin(origin,[],statePath,output,async value=>{
      const url=new URL(value),fragment=new URLSearchParams(url.hash.slice(1)),completed=await passkeys.completeAuthorization(session,url.searchParams.get("request")!,url.searchParams.get("state")!,fragment.get("code")!);
      expect((await fetch(completed.redirectUri)).ok).toBe(true);
    },async(url,init)=>app.request(url,init));
    expect(result.credentialFile).toBe(output);expect(result).not.toHaveProperty("token");
    const saved=JSON.parse(await readFile(output,"utf8"));expect(saved.token).toMatch(/^hailp_/);
    expect(await browserLogin(origin,[],statePath,output,async()=>{},async(url,init)=>app.request(url,init))).toEqual(result);
  });

  it("rejects exchange after the serving generation advances",async()=>{
    const generation=await prepare();await passkeys.completeAuthorization(session,generation.requestId,generation.state,generation.code);
    await db.sql.begin(async tx=>{await tx`SELECT set_config('hail.returning_account',${session.account_id},true)`;
      await tx`UPDATE account_serving_generations SET generation=2 WHERE account_id=${session.account_id}`;});
    await expect(passkeys.exchangeAuthorization({clientId:"hailp-cli-v1",redirectUri:generation.redirectUri,code:generation.code,
      verifier:generation.verifier,token:secret("hailp")})).rejects.toMatchObject({status:401});
    const rollback=await db.sql.reserve();try{
      await rollback.unsafe(await Bun.file(new URL("../migrations/rollback/0060_provider_role_addresses.sql",import.meta.url)).text());
      await rollback.unsafe(await Bun.file(new URL("../migrations/rollback/0059_grant_approvals.sql",import.meta.url)).text());
      await rollback.unsafe(await Bun.file(new URL("../migrations/rollback/0058_signup_ceremonies.sql",import.meta.url)).text());
      await rollback.unsafe(await Bun.file(new URL("../migrations/rollback/0057_alpha_monitoring.sql",import.meta.url)).text());
      await expect(rollback.unsafe(await Bun.file(new URL("../migrations/rollback/0056_browser_authorization.sql",import.meta.url)).text()))
        .rejects.toThrow("active browser authorization");await rollback.unsafe("ROLLBACK");
    }finally{rollback.release();}
  });

  it("rejects a code at a separate provider database",async()=>{
    const request=await prepare();await passkeys.completeAuthorization(session,request.requestId,request.state,request.code);
    const other=new PasskeyAuth(otherDb.sql,"other.example","https://other.example");
    await expect(other.exchangeAuthorization({clientId:"hailp-cli-v1",redirectUri:request.redirectUri,code:request.code,
      verifier:request.verifier,token:secret("hailp")})).rejects.toMatchObject({status:401});
  });
});
