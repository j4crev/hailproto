import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { P256Keypair } from "@atproto/crypto";
import { createUpdateOp, formatDidDoc, type Operation } from "@did-plc/lib";
import { encodeBase64Url } from "@hailproto/codec";
import { base58btc } from "multiformats/bases/base58";
import { Hono } from "hono";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createUserVault, unlockUserIdentity, unlockUserVault } from "../../hail-user-client-ts/src/vault.js";
import { accountAccessInput, type AccountAccessChallenge } from "../../hail-user-client-ts/src/account-access-proof.js";
import { AccountAccess } from "../src/accounts/access.js";
import { registerAccountAccess } from "../src/accounts/access-routes.js";
import { AccountApiRepository, ALL_ACCOUNT_SCOPES } from "../src/accounts/repository.js";
import { registerAccountApiRoutes } from "../src/accounts/routes.js";
import { GrantRepository } from "../src/grants/repository.js";
import type { GrantService } from "../src/grants/service.js";
import { ProviderDatabase } from "../src/db/database.js";
import { PlcHailDidResolver } from "../src/plc/resolver.js";
import type { PlcDirectoryClient } from "../src/plc/client.js";

const integration = process.env.DATABASE_URL ? describe : describe.skip;
integration("post-expiry owner account access", () => {
  let db: ProviderDatabase, accounts: AccountApiRepository, directory: string, origin: string, access: AccountAccess, app: Hono;
  let server: ReturnType<typeof Bun.serve>, losePrepare = false, loseComplete = false;
  let tamper: "provider" | "scopes" | "purpose" | null = null;
  const logs = new Map<string, Operation[]>();
  const fixtures: { id:string;address:string;vault:Awaited<ReturnType<typeof createUserVault>>;mode:"owner-controlled"|"managed";
    rotation:P256Keypair;providerIdentity:CryptoKeyPair }[] = [];
  const plc: PlcDirectoryClient = { health:async()=>({status:"ok"}),
    async getOperationLog(did) { if (!logs.has(did)) throw new Error("Missing DID"); return logs.get(did)!; },
    async getDocumentData(did) { const operation = (await this.getOperationLog(did)).at(-1)! as Operation;
      return {did,rotationKeys:operation.rotationKeys,verificationMethods:operation.verificationMethods,alsoKnownAs:operation.alsoKnownAs,services:operation.services}; },
    async getDocument(did) { return formatDidDoc(await this.getDocumentData(did)); },
    async getAuditableLog() { throw new Error("Not needed"); }, async sendOperation() { throw new Error("Login must never write PLC"); } };
  const resolver = new PlcHailDidResolver(plc);
  const restart = () => {
    access = new AccountAccess(db.sql, resolver, origin); app = new Hono(); registerAccountAccess(app, access, db.sql);
    registerAccountApiRoutes(app, accounts, new GrantRepository(db.sql), {} as GrantService, origin);
  };
  const publicKey = async (key:CryptoKey) => { const raw = new Uint8Array(34); raw.set([0xed,1]);
    raw.set(new Uint8Array(await crypto.subtle.exportKey("raw",key)),2); return `did:key:${base58btc.encode(raw)}`; };
  const token = () => `hailp_${encodeBase64Url(randomBytes(32))}`;
  const prepare = async (fixture:typeof fixtures[number], signer:"identity"|"owner-recovery", secret=token(), key?:string) => {
    const publicDidKey = key ?? (signer === "identity" ? fixture.vault.vault.identity.publicDidKey : fixture.vault.vault.recovery.publicDidKey);
    const input = {did:fixture.vault.vault.did!,signer,publicKey:publicDidKey,scopes:["account:read"],
      tokenHash:encodeBase64Url(new Uint8Array(createHash("sha256").update(secret).digest()))};
    return { secret, input, challenge: await access.prepare(input) as AccountAccessChallenge };
  };
  const sign = async (fixture:typeof fixtures[number], challenge:AccountAccessChallenge) => encodeBase64Url(challenge.signer === "identity" ?
    await (await unlockUserIdentity(fixture.vault.vault,fixture.vault.recoverySecret)).signAccountAccess(challenge) :
    await (await unlockUserVault(fixture.vault.vault,fixture.vault.recoverySecret)).signAccountRecovery(challenge));
  const login = async (fixture:typeof fixtures[number], name:string, signer:"identity"|"owner-recovery", vaultFile?:string, scopes=["account:read"]) => {
    const child = Bun.spawn(["bun","src/cli/hailp.ts","account","login","--provider",origin,"--did",fixture.vault.vault.did!,
      "--signer",signer,"--vault",vaultFile ?? join(directory,`${fixture.mode}.vault.json`),"--state",join(directory,`${name}.state.json`),
      "--credentials",join(directory,`${name}.credential.json`),...scopes.flatMap(scope=>["--scope",scope])], {
      cwd:new URL("../../hail-user-client-ts/",import.meta.url).pathname,env:{...Bun.env,NODE_EXTRA_CA_CERTS:join(directory,"cert.pem")},
      stdin:"pipe",stdout:"pipe",stderr:"pipe"});
    child.stdin.write(`${encodeBase64Url(fixture.vault.recoverySecret)}\n`); child.stdin.end();
    const [code,stdout,stderr]=await Promise.all([child.exited,new Response(child.stdout).text(),new Response(child.stderr).text()]);
    const state=JSON.parse(await readFile(join(directory,`${name}.state.json`),"utf8"));
    expect(stdout+stderr).not.toContain(state.token);expect(stdout+stderr).not.toContain(encodeBase64Url(fixture.vault.recoverySecret));
    return {code,stdout,stderr,state};
  };
  beforeAll(async()=>{
    db=new ProviderDatabase(process.env.DATABASE_URL!);await db.migrate();await db.migrate();accounts=new AccountApiRepository(db.sql);
    directory=await mkdtemp(join(tmpdir(),"hail-access-"));
    const cert=Bun.spawn(["openssl","req","-x509","-newkey","rsa:2048","-nodes","-days","1","-subj","/CN=localhost",
      "-addext","subjectAltName=DNS:localhost","-addext","basicConstraints=critical,CA:TRUE","-keyout",join(directory,"key.pem"),"-out",join(directory,"cert.pem")],{stdout:"pipe",stderr:"pipe"});
    if(await cert.exited!==0)throw new Error(await new Response(cert.stderr).text());
    server=Bun.serve({hostname:"localhost",port:0,tls:{cert:Bun.file(join(directory,"cert.pem")),key:Bun.file(join(directory,"key.pem"))},async fetch(request){
      const response=await app.fetch(request),path=new URL(request.url).pathname;
      if (response.ok && path.endsWith("/prepare") && tamper) {
        const challenge=await response.json();
        if(tamper==="provider")challenge.provider="https://attacker.example.com";
        else if(tamper==="scopes")challenge.scopes=["credentials:write"];
        else challenge.purpose="plc-operation";
        return new Response(JSON.stringify(challenge),{headers:{"Content-Type":"application/json"}});
      }
      if(response.ok&&((path.endsWith("/prepare")&&losePrepare)||(path.endsWith("/complete")&&loseComplete))){
        if(path.endsWith("/prepare"))losePrepare=false;else loseComplete=false;return new Response(null,{status:503});}
      return response;}});origin=`https://localhost:${server.port}`;restart();
    for(const mode of ["owner-controlled","managed"] as const){
      const vault=await createUserVault(),rotation=await P256Keypair.create(),providerIdentity=await crypto.subtle.generateKey("Ed25519",true,["sign","verify"]) as CryptoKeyPair;
      const messaging=await crypto.subtle.generateKey("Ed25519",true,["sign","verify"]) as CryptoKeyPair;
      const identity=mode==="managed"?await publicKey(providerIdentity.publicKey):vault.vault.identity.publicDidKey;
      const messagingKey=await publicKey(messaging.publicKey),full=await unlockUserVault(vault.vault,vault.recoverySecret);
      const unsigned={type:"plc_operation" as const,prev:null,rotationKeys:[vault.vault.recovery.publicDidKey,rotation.did()],
        verificationMethods:{"hail-identity":identity,"hail-messaging":messagingKey},alsoKnownAs:[],services:{hail:{type:"HailMessaging",endpoint:`${origin}/hail`}}};
      const genesis=mode==="managed"?await full.signManagedGenesis(unsigned):await full.signPlcOperation(unsigned);
      await full.bindDid(genesis.did,genesis.operation,mode==="managed");logs.set(genesis.did,[genesis.operation]);
      const id=randomUUID(),address=`access-${id}@example.com`;
      fixtures.push({id,address,vault,mode,rotation,providerIdentity});
      await db.sql`INSERT INTO provider_accounts (id,tenant_id,canonical_address,did,onboarding_state,activated_at,activation_binding_digest,activation_verification_mode)
        VALUES (${id},${randomUUID()},${address},${genesis.did},'active',now(),${randomBytes(32)},'public')`;
      for(const [role,key,algorithm] of [["plc-rotation",rotation.did(),"p256"],["hail-messaging",messagingKey,"ed25519"],...(mode==="managed"?[["hail-identity",identity,"ed25519"]]:[])])
        await db.sql`INSERT INTO account_keys (account_id,role,algorithm,public_key,encrypted_private_key,encryption_nonce)
          VALUES (${id},${role!},${algorithm!},${key!},${randomBytes(32)},${randomBytes(12)})`;
      if(mode==="managed")await db.sql`INSERT INTO managed_custody_evidence
        (account_id,owner_recovery_public_key,provider_identity_public_key,verification_mode,managed_profile_version)
        VALUES (${id},${vault.vault.recovery.publicDidKey},${identity},'poc-local','hail-managed-custody-v1')`;
      else await db.sql`INSERT INTO portable_custody_evidence (account_id,user_recovery_public_key,user_identity_public_key,monitor_origin,monitor_confirmed_at,backup_confirmed_at,monitor_verification_mode)
        VALUES (${id},${vault.vault.recovery.publicDidKey},${identity},'https://monitor.example.com',now(),now(),'poc-local')`;
      await writeFile(join(directory,`${mode}.vault.json`),JSON.stringify(vault.vault),{mode:0o600});
    }
  });
  afterAll(async()=>{server?.stop(true);if(db){await db.sql`DELETE FROM account_access_challenges`;
    for(const fixture of fixtures){await db.sql`DELETE FROM provider_migration_fences WHERE account_id=${fixture.id}`;
      for(const table of ["account_api_credentials","managed_custody_evidence","portable_custody_evidence","account_keys","provider_accounts"])
        await db.sql.unsafe(`DELETE FROM ${table} WHERE ${table==="provider_accounts"?"id":"account_id"}=$1`,[fixture.id]);fixture.vault.recoverySecret.fill(0);}
    await db.close();}if(directory)await rm(directory,{recursive:true,force:true});});

  it.each(["owner-controlled","managed"] as const)("restores %s access after expiry with persisted challenge/proof retries and no custody or PLC changes",async mode=>{
    const fixture=fixtures.find(value=>value.mode===mode)!,old=await accounts.issue(fixture.address,false,undefined,[...ALL_ACCOUNT_SCOPES]);
    await db.sql`UPDATE account_api_credentials SET created_at=now()-interval '2 days',expires_at=now()-interval '1 day' WHERE id=${old.credentialId}`;
    expect(await accounts.authenticate(`Bearer ${old.token}`)).toBeNull();
    const before=JSON.stringify(logs.get(fixture.vault.vault.did!));
    let vaultFile:string|undefined;
    if(mode==="owner-controlled"){vaultFile=join(directory,"identity-only.json");await writeFile(vaultFile,JSON.stringify({...fixture.vault.vault,
      recovery:{...fixture.vault.vault.recovery,ciphertext:"AA"}}),{mode:0o600});losePrepare=true;}
    const signer=mode==="managed"?"owner-recovery":"identity";
    if(mode==="owner-controlled"){const failed=await login(fixture,mode,signer,vaultFile);expect(failed.code).toBe(1);expect(failed.stderr).toContain("HTTP_503");restart();}
    loseComplete=true;const ambiguous=await login(fixture,mode,signer,vaultFile);
    expect(ambiguous.code).toBe(1);expect(ambiguous.stderr).toContain("HTTP_503");
    const session=await accounts.authenticate(`Bearer ${ambiguous.state.token}`);expect(session).not.toBeNull();
    restart();const completed=await login(fixture,mode,signer,vaultFile);expect(completed.code,completed.stderr).toBe(0);
    expect(JSON.parse(completed.stdout).credentialId).toBe(session!.credential_id);
    const record=JSON.parse(await readFile(join(directory,`${mode}.credential.json`),"utf8"));
    expect(record.scopes).toEqual(["account:read"]);expect(record.expiresAt).toBe(session!.credential_expires_at.toISOString());
    expect((await login(fixture,mode,signer,vaultFile)).code).toBe(0);
    const changed=await login(fixture,mode,signer,vaultFile,["credentials:write"]);
    expect(changed.code).toBe(1);expect(changed.stderr).toContain("Login state differs");
    expect(changed.state.token).toBe(record.token);
    expect(await accounts.authenticate(`Bearer ${old.token}`)).toBeNull();expect(JSON.stringify(logs.get(fixture.vault.vault.did!))).toBe(before);
    expect(await db.sql`SELECT role FROM account_keys WHERE account_id=${fixture.id} AND public_key=${fixture.vault.vault.recovery.publicDidKey}`).toHaveLength(0);
    const denied=await app.request(`${origin}/api/v1/account/credentials`,{method:"POST",headers:{Authorization:`Bearer ${record.token}`,"Content-Type":"application/json"},body:JSON.stringify({token:token()})});expect(denied.status).toBe(403);
    await accounts.revoke(record.credentialId);expect((await login(fixture,mode,signer,vaultFile)).code).toBe(1);
    expect(await accounts.authenticate(`Bearer ${record.token}`)).toBeNull();
  }, 30_000);

  it("rejects changed provider, scopes and purpose before persisting a signature",async()=>{
    const owner=fixtures[0]!;
    for(const field of ["provider","scopes","purpose"] as const){
      tamper=field;
      try {const failed=await login(owner,`tampered-${field}`,"identity");expect(failed.code).toBe(1);
        expect(failed.state.signature).toBeUndefined();expect(await accounts.authenticate(`Bearer ${failed.state.token}`)).toBeNull();}
      finally {tamper=null;}
    }
  });

  it("atomically consumes concurrent completion and rejects tampering, stale authority, expired challenges and fences",async()=>{
    const owner=fixtures[0]!,managed=fixtures[1]!;
    const request=await prepare(owner,"identity"),signature=await sign(owner,request.challenge);
    const results=await Promise.all([access.complete(request.challenge.challengeId,request.secret,signature),access.complete(request.challenge.challengeId,request.secret,signature)]);
    expect(results[0]).toEqual(results[1]);
    await expect(access.complete(request.challenge.challengeId,token(),signature)).rejects.toThrow();
    const altered={...request.challenge,scopes:["credentials:write"]};
    await expect(access.complete(request.challenge.challengeId,request.secret,await sign(owner,altered))).rejects.toThrow();
    await expect(access.prepare({...request.input,scopes:["credentials:write"]})).rejects.toThrow();
    await expect(accounts.issue(owner.address,false,request.secret,[...ALL_ACCOUNT_SCOPES])).rejects.toThrow("scopes");
    const expired=await prepare(owner,"identity"),expiredSig=await sign(owner,expired.challenge);
    await db.sql`UPDATE account_access_challenges SET created_at=clock_timestamp()-interval '10 minutes',expires_at=clock_timestamp()-interval '6 minutes' WHERE id=${expired.challenge.challengeId}`;
    await expect(access.complete(expired.challenge.challengeId,expired.secret,expiredSig)).rejects.toThrow();
    await expect(access.prepare(expired.input)).rejects.toThrow();
    const framed=await prepare(owner,"owner-recovery"),framedSig=await sign(owner,framed.challenge);
    for (const state of ["fenced", "exported", "retired"]) {
      const transferId=randomUUID(),snapshotDigest=state==="fenced"?null:randomBytes(32);
      await db.sql`INSERT INTO provider_migration_fences (did,account_id,transfer_id,destination_service_base,state,snapshot_digest,retirement_receipt_bytes,retired_at)
        VALUES (${owner.vault.vault.did!},${owner.id},${transferId},'https://target.example.com/hail',${state==="retired"?"exported":state},${snapshotDigest},NULL,NULL)`;
      if(state==="retired") {
        // Synthetic retired fixtures must retain an export too; migration 36 archives that evidence atomically.
        await db.sql`INSERT INTO provider_migration_exports
          (transfer_id,did,manifest_bytes,manifest_digest,source_messaging_public_key,signature,signing_plc_document,signing_plc_data,signing_plc_operation_log)
          VALUES (${transferId},${owner.vault.vault.did!},${new Uint8Array([1])},${snapshotDigest},${owner.vault.vault.identity.publicDidKey},${randomBytes(64)},'{}','{}','[]')`;
        await db.sql`UPDATE provider_migration_fences SET state='retired',retirement_receipt_bytes=${new Uint8Array([1])},retired_at=clock_timestamp() WHERE transfer_id=${transferId}`;
      }
      await expect(access.complete(framed.challenge.challengeId,framed.secret,framedSig)).rejects.toThrow("fenced");
      expect(await accounts.authenticate(`Bearer ${framed.secret}`)).toBeNull();
      // Test-only projection cleanup; normal APIs cannot reopen this source or delete archived history.
      await db.sql`DELETE FROM provider_migration_exports WHERE transfer_id=${transferId}`;
      await db.sql`DELETE FROM provider_migration_fences WHERE account_id=${owner.id}`;
    }
    const badManaged=await prepare(managed,"identity",token(),await publicKey(managed.providerIdentity.publicKey));
    const providerSig=encodeBase64Url(new Uint8Array(await crypto.subtle.sign("Ed25519",managed.providerIdentity.privateKey,Uint8Array.from(accountAccessInput(badManaged.challenge)))));
    await expect(access.complete(badManaged.challenge.challengeId,badManaged.secret,providerSig)).rejects.toThrow("authority");
    const lower=await prepare(owner,"owner-recovery",token(),owner.rotation.did());
    await expect(access.complete(lower.challenge.challengeId,lower.secret,encodeBase64Url(await owner.rotation.sign(accountAccessInput(lower.challenge))))).rejects.toThrow("authority");
    const currentLog=logs.get(owner.vault.vault.did!)!;
    const update=await createUpdateOp(currentLog[0]!,owner.rotation,unsigned=>({...unsigned,services:{hail:{type:"HailMessaging",endpoint:"https://other.example.com/hail"}}}));
    logs.set(owner.vault.vault.did!,[...currentLog,update]);
    await expect(access.complete(request.challenge.challengeId,request.secret,signature)).rejects.toThrow("authority");
    await expect(new AccountAccess(db.sql,resolver,"https://other.example.com").complete(request.challenge.challengeId,request.secret,signature)).rejects.toThrow("another provider");
    logs.set(owner.vault.vault.did!,currentLog);
    const changedIdentity=await createUpdateOp(currentLog[0]!,owner.rotation,unsigned=>({...unsigned,
      verificationMethods:{...unsigned.verificationMethods,"hail-identity":badManaged.challenge.publicKey}}));
    logs.set(owner.vault.vault.did!,[...currentLog,changedIdentity]);
    await expect(access.complete(request.challenge.challengeId,request.secret,signature)).rejects.toThrow("authority");
    const replacementRecovery=await P256Keypair.create();
    const changedRecovery=await createUpdateOp(currentLog[0]!,owner.rotation,unsigned=>({...unsigned,
      rotationKeys:[replacementRecovery.did(),owner.rotation.did()]}));
    logs.set(owner.vault.vault.did!,[...currentLog,changedRecovery]);
    await expect(access.complete(framed.challenge.challengeId,framed.secret,framedSig)).rejects.toThrow("authority");
    logs.delete(owner.vault.vault.did!);
    await expect(access.complete(request.challenge.challengeId,request.secret,signature)).rejects.toThrow();
    logs.set(owner.vault.vault.did!,currentLog);
    const unknown=await access.prepare({...request.input,did:`did:plc:${"a".repeat(24)}`,tokenHash:encodeBase64Url(randomBytes(32))});
    expect(Object.keys(unknown)).toEqual(Object.keys(request.challenge));
    const refused=await app.request(`${origin}/api/v1/account-access/complete`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({challengeId:unknown.challengeId,token:token(),signature})});
    expect(refused.status).toBe(401);expect(refused.headers.get("Cache-Control")).toBe("no-store");
  });
});
