import {createHash,randomBytes,randomUUID} from "node:crypto";
import {mkdtemp,readFile,rm,writeFile} from "node:fs/promises";
import {join} from "node:path";
import {tmpdir} from "node:os";
import {createWebCryptoSigner,encodeBase64Url,inspectSignedPayload,signPayload,toDiagnosticJson,type HailAddressBinding,type HailGrant,type HailSenderProfile} from "@hailproto/codec";
import {base58btc} from "multiformats/bases/base58";
import {Hono} from "hono";
import {afterAll,beforeAll,describe,expect,it} from "vitest";
import {createUserVault,unlockUserIdentity} from "../../hail-user-client-ts/src/vault.js";
import {ProviderDatabase} from "../src/db/database.js";
import {AccountApiRepository} from "../src/accounts/repository.js";
import {registerAccountApiRoutes} from "../src/accounts/routes.js";
import {GrantRepository} from "../src/grants/repository.js";
import {GrantService} from "../src/grants/service.js";
import {OnboardingRepository} from "../src/onboarding/repository.js";
import {KeyEncryptor} from "../src/identity/key-encryption.js";
import type {HailDidResolver} from "../src/plc/resolver.js";
import type {VerifiedAddress} from "../src/discovery/verifier.js";
import type {VerifiedSenderProfile} from "../src/profiles/store.js";

const integration=process.env.DATABASE_URL?describe:describe.skip;
const freshDid=()=>`did:plc:${Array.from(randomBytes(24),b=>"abcdefghijklmnopqrstuvwxyz234567"[b%32]).join("")}`;
const hash=(bytes:Uint8Array)=>new Uint8Array(createHash("sha256").update(bytes).digest());
integration("active Grant updates and consent refresh through HTTPS hailp",()=>{
  let db:ProviderDatabase,accounts:AccountApiRepository,grants:GrantRepository,directory:string,origin:string,app:Hono;
  let server:ReturnType<typeof Bun.serve>,address:VerifiedAddress,profile:VerifiedSenderProfile;
  let available=true,reads=0,loseResponse=false,changeEvidence=false,changedOwnerKey=false;
  const senderDid=freshDid(),senderAddress="updates@sender.example.com",senderBase="https://sender.example.com/hail";
  const evidence={document:{},data:{},log:[]},encryptor=new KeyEncryptor(encodeBase64Url(randomBytes(32)));
  const fixtures:{id:string;did:string;address:string;managed:boolean;vault:Awaited<ReturnType<typeof createUserVault>>;key:string;token:string}[]=[];
  const keyId=async(key:CryptoKey)=>{const bytes=new Uint8Array(34);bytes.set([0xed,1]);bytes.set(new Uint8Array(await crypto.subtle.exportKey("raw",key)),2);return `did:key:${base58btc.encode(bytes)}`;};
  let senderMessaging:CryptoKeyPair;
  const refreshProfile=async()=>{const payload:HailSenderProfile={...profile.profile,revision:profile.profile.revision+1,updated_at:profile.profile.updated_at+1};
    const bytes=await signPayload("hail.sender-profile",payload,createWebCryptoSigner(payload.key_id,senderMessaging.privateKey));
    profile={...profile,profile:payload,representation:bytes,digest:hash(bytes),verifiedAt:new Date()};};
  const cli=async(fixture:typeof fixtures[number],args:string[])=>{
    const child=Bun.spawn(["bun","src/cli/hailp.ts",...args,"--credentials",join(directory,`${fixture.id}.credential.json`)],{
      cwd:new URL("../../hail-user-client-ts/",import.meta.url).pathname,env:{...Bun.env,NODE_EXTRA_CA_CERTS:join(directory,"cert.pem")},stdin:"pipe",stdout:"pipe",stderr:"pipe"});
    child.stdin.write(`${encodeBase64Url(fixture.vault.recoverySecret)}\n`);child.stdin.end();
    const [code,stdout,stderr]=await Promise.all([child.exited,new Response(child.stdout).text(),new Response(child.stderr).text()]);
    expect(stdout+stderr).not.toContain(fixture.token);expect(stdout+stderr).not.toContain(encodeBase64Url(fixture.vault.recoverySecret));return {code,stdout,stderr};};
  beforeAll(async()=>{
    db=new ProviderDatabase(process.env.DATABASE_URL!);await db.migrate();accounts=new AccountApiRepository(db.sql);grants=new GrantRepository(db.sql);
    directory=await mkdtemp(join(tmpdir(),"hail-grant-update-"));
    const cert=Bun.spawn(["openssl","req","-x509","-newkey","rsa:2048","-nodes","-days","1","-subj","/CN=localhost","-addext","subjectAltName=DNS:localhost",
      "-addext","basicConstraints=critical,CA:TRUE","-keyout",join(directory,"key.pem"),"-out",join(directory,"cert.pem")],{stdout:"pipe",stderr:"pipe"});
    if(await cert.exited!==0)throw new Error(await new Response(cert.stderr).text());
    server=Bun.serve({hostname:"localhost",port:0,tls:{cert:Bun.file(join(directory,"cert.pem")),key:Bun.file(join(directory,"key.pem"))},async fetch(request){
      const response=await app.fetch(request),path=new URL(request.url).pathname;
      if(changeEvidence&&path.endsWith("/proposals")&&response.ok){changeEvidence=false;await refreshProfile();}
      if(loseResponse&&response.ok&&(request.method==="PUT"||path.endsWith("/update"))){loseResponse=false;return new Response(null,{status:503});}
      return response;}});origin=`https://localhost:${server.port}`;
    const senderIdentity=await crypto.subtle.generateKey("Ed25519",true,["sign","verify"]) as CryptoKeyPair;
    senderMessaging=await crypto.subtle.generateKey("Ed25519",true,["sign","verify"]) as CryptoKeyPair;
    const now=Math.floor(Date.now()/1000),identity=await keyId(senderIdentity.publicKey),messaging=await keyId(senderMessaging.publicKey);
    const binding:HailAddressBinding={type:"hail.address-binding",version:1,address:senderAddress,did:senderDid,issued_at:now,expires_at:now+86400,key_id:`${senderDid}#hail-identity`};
    const bindingBytes=await signPayload("hail.address-binding",binding,createWebCryptoSigner(binding.key_id,senderIdentity.privateKey));
    address={address:senderAddress,did:senderDid,serviceBase:senderBase,identityDidKey:identity,messagingDidKey:messaging,plcEvidence:evidence,verifiedAt:new Date(),binding,representation:bindingBytes,digest:hash(bindingBytes)};
    const payload:HailSenderProfile={type:"hail.sender-profile",version:1,did:senderDid,revision:1,updated_at:now,display_name:"Sender",offers_uncategorized:true,
      categories:[{id:"receipts",label:"Receipts"},{id:"security",label:"Security"},{id:"updates",label:"Updates"}],key_id:`${senderDid}#hail-messaging`};
    const bytes=await signPayload("hail.sender-profile",payload,createWebCryptoSigner(payload.key_id,senderMessaging.privateKey));
    profile={did:senderDid,serviceBase:senderBase,messagingDidKey:messaging,profile:payload,representation:bytes,digest:hash(bytes),plcEvidence:evidence,verifiedAt:new Date(),etag:"profile"};
    for(const managed of [false,true]) {
      const vault=await createUserVault(),did=freshDid(),id=randomUUID(),ownerAddress=`owner-${id}@example.com`;vault.vault.did=did;
      let key=vault.vault.identity.publicDidKey;
      await db.sql`INSERT INTO provider_accounts (id,tenant_id,canonical_address,did,onboarding_state,activated_at,activation_binding_digest,activation_verification_mode)
        VALUES (${id},${randomUUID()},${ownerAddress},${did},'active',now(),${randomBytes(32)},'public')`;
      if(managed){const pair=await crypto.subtle.generateKey("Ed25519",true,["sign","verify"]) as CryptoKeyPair;key=await keyId(pair.publicKey);
        const raw=new Uint8Array(await crypto.subtle.exportKey("pkcs8",pair.privateKey)),encrypted=await encryptor.encrypt(id,"hail-identity","ed25519",key,raw);raw.fill(0);
        await db.sql`INSERT INTO account_keys (account_id,role,algorithm,public_key,encrypted_private_key,encryption_nonce)
          VALUES (${id},'hail-identity','ed25519',${key},${encrypted.ciphertext},${encrypted.nonce})`;
        await db.sql`INSERT INTO managed_custody_evidence
          (account_id,owner_recovery_public_key,provider_identity_public_key,verification_mode,managed_profile_version)
          VALUES (${id},${vault.vault.recovery.publicDidKey},${key},'poc-local','hail-managed-custody-v1')`;
      }else await db.sql`INSERT INTO portable_custody_evidence (account_id,user_recovery_public_key,user_identity_public_key,monitor_origin,monitor_confirmed_at,backup_confirmed_at,monitor_verification_mode)
        VALUES (${id},${vault.vault.recovery.publicDidKey},${key},'https://monitor.example.com',now(),now(),'poc-local')`;
      const credential=await accounts.issue(ownerAddress,false,undefined,["account:read","grants:read","grants:write"]);
      fixtures.push({id,did,address:ownerAddress,managed,vault,key,token:credential.token});
      await writeFile(join(directory,`${id}.credential.json`),JSON.stringify({type:"hailp.api-credential",version:1,provider:origin,...credential}),{mode:0o600});
      await writeFile(join(directory,`${id}.vault.json`),JSON.stringify(vault.vault),{mode:0o600});
    }
  });
  const reset=(fixture:typeof fixtures[number])=>{
    available=true;changedOwnerKey=false;
    const resolver:HailDidResolver={async resolve(did){return {did,identityDidKey:changedOwnerKey?address.identityDidKey:fixture.key,
      messagingDidKey:address.messagingDidKey,serviceBase:`${origin}/hail`,evidence};}};
    const service=new GrantService(new OnboardingRepository(db.sql),grants,encryptor,resolver,
      {async verify(){reads++;if(!available)throw new Error("Sender unavailable");return address;}},
      {async verify(){reads++;if(!available)throw new Error("Profile unavailable");return profile;}},`${origin}/hail`);
    app=new Hono();registerAccountApiRoutes(app,accounts,grants,service,origin);
  };
  afterAll(async()=>{server?.stop(true);if(db){for(const fixture of fixtures){
    const ids=await db.sql<{grant_id:string}[]>`SELECT grant_id FROM grant_lineages WHERE local_account_id=${fixture.id}`;
    for(const row of ids)for(const table of ["grant_publications","grant_consent_evidence","grant_revisions","grant_lineages"])await db.sql.unsafe(`DELETE FROM ${table} WHERE grant_id=$1`,[row.grant_id]);
    for(const table of ["account_api_credentials","managed_custody_evidence","portable_custody_evidence","account_keys","provider_accounts"])
      await db.sql.unsafe(`DELETE FROM ${table} WHERE ${table==="provider_accounts"?"id":"account_id"}=$1`,[fixture.id]);fixture.vault.recoverySecret.fill(0);}
    await db.close();}if(directory)await rm(directory,{recursive:true,force:true});});

  it.each([false,true])("updates and refreshes managed=%s without sender-dependent restrictions, forks or silent renewal",async managed=>{
    const fixture=fixtures.find(f=>f.managed===managed)!;reset(fixture);
    const signing=managed?[]:["--vault",join(directory,`${fixture.id}.vault.json`)];
    const initialPath=join(directory,`${fixture.id}.initial.cose`),created=await cli(fixture,["grant","create",senderAddress,"--category","updates","--category","receipts",
      "--expires-at",String(Math.floor(Date.now()/1000)+3600),"--output",initialPath,...signing]);expect(created.code,created.stderr).toBe(0);
    const grantId=JSON.parse(created.stdout).grantId,initial=(await grants.findCurrentByGrantId(grantId))!;
    expect(initial.payload.scope).toEqual([{type:"categories",values:["receipts","updates"]}]);
    await new Promise(resolve=>setTimeout(resolve,1200));available=false;
    const oldReads=reads,restrictedPath=join(directory,`${fixture.id}.restricted.cose`);
    const restricted=await cli(fixture,["grant","update",grantId,"--category","receipts","--expires-at",String(initial.payload.issued_at+1),"--output",restrictedPath,...signing]);
    expect(restricted.code,restricted.stderr).toBe(0);expect(reads).toBe(oldReads);
    const revision2=(await grants.findCurrentByGrantId(grantId))!;expect(revision2.payload.revision).toBe(2);
    expect(revision2.payload.consent_context).toEqual(initial.payload.consent_context);
    expect((await cli(fixture,["grant","update",grantId,"--category","receipts","--category","security","--output",join(directory,`${fixture.id}.silent.cose`),...signing])).code).toBe(1);
    const expandedPath=join(directory,`${fixture.id}.expanded.cose`),expiry=initial.payload.issued_at+7200;
    const expand=["grant","update",grantId,"--category","security","--category","receipts","--expires-at",String(expiry),"--output",expandedPath,...signing];
    expect((await cli(fixture,expand)).code).toBe(1);available=true;await refreshProfile();loseResponse=true;
    const lost=await cli(fixture,expand);expect(lost.code).toBe(1);expect(lost.stderr).toContain("HTTP_503");
    const revision3=(await grants.findCurrentByGrantId(grantId))!;expect(revision3.payload.revision).toBe(3);available=false;
    const retried=await cli(fixture,expand);expect(retried.code,retried.stderr).toBe(0);expect(JSON.parse(retried.stdout).digest).toBe(encodeBase64Url(revision3.digest));
    expect(inspectSignedPayload("hail.grant",new Uint8Array(await readFile(expandedPath))).payload).toEqual(revision3.payload);
    expect(revision3.payload.consent_context.sender_profile_hash.value).toEqual(profile.digest);
    expect(revision3.payload.previous).toEqual(revision2.digest);expect(revision3.payload.issued_at).toBe(initial.payload.issued_at);
    const fork:HailGrant={...revision3.payload,updated_at:revision3.payload.updated_at+1,scope:[{type:"categories",values:["updates"]}]};
    const headers={Authorization:`Bearer ${fixture.token}`};
    const rejected=managed?await app.request(`${origin}/api/v1/account/grants/${grantId}/update`,{method:"POST",headers:{...headers,"Content-Type":"application/json"},
      body:JSON.stringify({payload:toDiagnosticJson("hail.grant",fork),signingKey:fixture.key})}):
      await app.request(`${origin}/api/v1/account/grants/${grantId}`,{method:"PUT",headers:{...headers,"Content-Type":'application/cose; cose-type="cose-sign1"'},
        body:Uint8Array.from(await (await unlockUserIdentity(fixture.vault.vault,fixture.vault.recoverySecret)).signGrant(fork))});
    expect(rejected.status).toBe(409);expect((await grants.findCurrentByGrantId(grantId))!.digest).toEqual(revision3.digest);
    const reader=await accounts.issue(fixture.address);
    expect((await app.request(`${origin}/api/v1/account/grants/${grantId}/proposals`,{method:"POST",headers:{Authorization:`Bearer ${reader.token}`,"Content-Type":"application/json"},body:"{}"})).status).toBe(403);
    available=true;const refreshedPath=join(directory,`${fixture.id}.refresh.cose`);
    const originalAddress=address;address={...address,did:freshDid()};
    const reassigned=await cli(fixture,["grant","update",grantId,"--category","receipts","--category","security","--refresh-consent","--output",join(directory,`${fixture.id}.reassigned.cose`),...signing]);
    expect(reassigned.code).toBe(1);expect((await grants.findCurrentByGrantId(grantId))!.payload.grantee).toBe(senderDid);address=originalAddress;
    const unknown=await cli(fixture,["grant","update",grantId,"--category","receipts","--category","unknown-choice","--expires-at",String(expiry+3600),"--output",join(directory,`${fixture.id}.unknown.cose`),...signing]);expect(unknown.code).toBe(1);
    const refreshed=await cli(fixture,["grant","update",grantId,"--category","receipts","--category","security","--refresh-consent","--output",refreshedPath,...signing]);
    expect(refreshed.code,refreshed.stderr).toBe(0);expect((await grants.findCurrentByGrantId(grantId))!.payload.revision).toBe(4);
    expect((await cli(fixture,expand)).code).toBe(0);expect((await grants.findCurrentByGrantId(grantId))!.payload.revision).toBe(4);
    changeEvidence=true;
    const stale=await cli(fixture,["grant","update",grantId,"--category","receipts","--category","security","--expires-at",String(expiry+3600),"--output",join(directory,`${fixture.id}.stale.cose`),...signing]);
    expect(stale.code).toBe(1);expect(stale.stderr).toContain("HTTP_400");expect((await grants.findCurrentByGrantId(grantId))!.payload.revision).toBe(4);
    const switched=await cli(fixture,["grant","update",grantId,"--uncategorized","--expires-at",String(expiry+3600),"--output",join(directory,`${fixture.id}.uncategorized.cose`),...signing]);
    expect(switched.code,switched.stderr).toBe(0);expect((await grants.findCurrentByGrantId(grantId))!.payload.scope).toEqual([{type:"uncategorized"}]);
    changedOwnerKey=true;
    const epoch=await cli(fixture,["grant","update",grantId,"--uncategorized","--refresh-consent","--output",join(directory,`${fixture.id}.epoch.cose`),...signing]);
    expect(epoch.code).toBe(1);expect(epoch.stderr).toContain("HTTP_409");changedOwnerKey=false;available=false;
    const revoked=await cli(fixture,["grant","revoke",grantId,...(managed?[]:[...signing,"--output",join(directory,`${fixture.id}.revoked.cose`)])]);
    expect(revoked.code,revoked.stderr).toBe(0);expect((await grants.findCurrentByGrantId(grantId))!.payload.status).toBe("revoked");
    const terminal=await cli(fixture,["grant","update",grantId,"--uncategorized","--refresh-consent","--output",join(directory,`${fixture.id}.terminal.cose`),...signing]);expect(terminal.code).toBe(1);
    const history=await db.sql<{revision:number}[]>`SELECT revision FROM grant_revisions WHERE grant_id=${grantId} ORDER BY revision`;expect(history.map(row=>row.revision)).toEqual([1,2,3,4,5,6]);
    const publication=await db.sql<{revision:number}[]>`SELECT revision FROM grant_publications WHERE grant_id=${grantId} ORDER BY revision`;expect(publication.map(row=>row.revision)).toEqual([1,2,3,4,5,6]);
    expect((await grants.findRevisionByGrantId(grantId,1))!.representation).toEqual(initial.representation);
  },30_000);
});
