import {randomBytes,randomUUID} from "node:crypto";
import {mkdtemp,writeFile,readFile,rm} from "node:fs/promises";
import {join} from "node:path";
import {tmpdir} from "node:os";
import {cidForCbor} from "@atproto/common";
import {formatDidDoc,PlcClientError,type Operation} from "@did-plc/lib";
import {encodeBase64Url,inspectSignedPayload,signPayload,createWebCryptoSigner,type HailSenderProfile} from "@hailproto/codec";
import {createHash} from "node:crypto";
import {importEd25519PrivateKey} from "../src/identity/keys.js";
import {describe,it,expect,beforeAll,afterAll,vi} from "vitest";
import {createUserVault,unlockUserIdentity} from "../../hail-user-client-ts/src/vault.js";
import {createAccount} from "../../hail-user-client-ts/src/account-creation.js";
import {AccountApiClient} from "../../hail-user-client-ts/src/account-api.js";
import {createGrant} from "../../hail-user-client-ts/src/grant-creation.js";
import {ProviderDatabase} from "../src/db/database.js";
import {KeyEncryptor} from "../src/identity/key-encryption.js";
import {PrivatePocOnboarding} from "../src/onboarding/private-poc.js";
import {OnboardingRepository} from "../src/onboarding/repository.js";
import {ActivationService} from "../src/onboarding/activation.js";
import {AccountApiRepository} from "../src/accounts/repository.js";
import {GrantRepository} from "../src/grants/repository.js";
import {GrantService} from "../src/grants/service.js";
import {createApp} from "../src/app.js";
import {PlcHailDidResolver} from "../src/plc/resolver.js";
import type {PlcDirectoryClient} from "../src/plc/client.js";
import type {AppConfig} from "../src/config.js";
import {rotateCredential} from "../../hail-user-client-ts/src/credential-rotation.js";
import {renewBinding,showBinding} from "../../hail-user-client-ts/src/binding-renewal.js";
import {AccountBinding} from "../src/accounts/binding.js";

const integration=process.env.DATABASE_URL?describe:describe.skip;
integration("self-service custody profiles and credentials",()=>{
  let db:ProviderDatabase;
  const origin="https://source.example.com",base=`${origin}/hail`;
  const log=new Map<string,Operation>();let writes=0;
  const encryptor=new KeyEncryptor(encodeBase64Url(randomBytes(32)));
  const plc:PlcDirectoryClient={health:async()=>({status:"ok"}),
    async getOperationLog(did){if(!log.has(did))throw new PlcClientError(404,null,"Missing");return [log.get(did)!];},
    async getDocumentData(did){const op=log.get(did);if(!op)throw new Error("Missing");return {did,rotationKeys:op.rotationKeys,verificationMethods:op.verificationMethods,alsoKnownAs:op.alsoKnownAs,services:op.services};},
    async getDocument(did){return formatDidDoc(await this.getDocumentData(did));},
    async getAuditableLog(did){const operation=(await this.getOperationLog(did))[0]!;return [{did,operation,cid:(await cidForCbor(operation)).toString(),nullified:false,createdAt:new Date().toISOString()}];},
    async sendOperation(did,operation){log.set(did,operation);writes++;}};
  beforeAll(async()=>{db=new ProviderDatabase(process.env.DATABASE_URL!);await db.migrate();});
  afterAll(async()=>{vi.unstubAllGlobals();if(db){
    for(const did of log.keys()){
      const account=await new OnboardingRepository(db.sql).getAccountByDid(did);if(!account)continue;
      const rows=await db.sql<{grant_id:string}[]>`SELECT grant_id FROM grant_lineages WHERE local_account_id=${account.id}`;
      for(const row of rows)for(const table of ["grant_publications","grant_consent_evidence","grant_revisions","grant_lineages"])
        await db.sql.unsafe(`DELETE FROM ${table} WHERE grant_id=$1`,[row.grant_id]);
      for(const table of ["account_api_credentials","managed_custody_evidence","portable_custody_evidence","address_bindings","plc_operation_evidence","private_poc_onboarding_preparations","account_keys"])
        await db.sql.unsafe(`DELETE FROM ${table} WHERE account_id=$1`,[account.id]);
      await db.sql`DELETE FROM provider_accounts WHERE id=${account.id}`;
    }
    await db.close();}});
  it.each(["owner-controlled","managed"] as const)("creates %s with owner recovery, resumes exact signup and rotates scoped credentials",async custody=>{
    const directory=await mkdtemp(join(tmpdir(),"hailp-signup-"));
    const vault=await createUserVault();
    const repository=new OnboardingRepository(db.sql),accounts=new AccountApiRepository(db.sql),grants=new GrantRepository(db.sql);
    const resolver=new PlcHailDidResolver(plc);
    const onboarding=new PrivatePocOnboarding(db.sql,plc,encryptor,"http://plc.fixture:2582",base);
    let verificationUnavailable=false;
    const addressVerifier={async verify(address:string){
       if(verificationUnavailable)throw new Error("Publication verifier unavailable");
      const account=await repository.getAccountByAddress(address),binding=await repository.findPublishedByAddress(address);
      if(!binding)throw new Error("No selected binding");
      const resolved=await resolver.resolve(account.did!);
      return {address,did:account.did!,serviceBase:base,messagingDidKey:resolved.messagingDidKey,identityDidKey:resolved.identityDidKey,
        plcEvidence:resolved.evidence,verifiedAt:new Date(),binding:inspectSignedPayload("hail.address-binding",binding.cose).payload,representation:binding.cose,digest:binding.digest};}};
    const activation=new ActivationService(repository,addressVerifier,base,"public");
    let peer:string|undefined;
    let verifiedProfile:Awaited<ReturnType<import("../src/profiles/verifier.js").SenderProfileVerifier["verify"]>>|undefined;
    const service=new GrantService(repository,grants,encryptor,resolver,{async verify(){
      const account=await repository.getAccountByDid(peer!);const binding=await repository.getBindingForAccount(account!.id);const resolved=await resolver.resolve(peer!);
      return {address:account!.canonicalAddress,did:peer!,serviceBase:base,identityDidKey:resolved.identityDidKey,messagingDidKey:resolved.messagingDidKey,
        plcEvidence:resolved.evidence,verifiedAt:new Date(),binding:inspectSignedPayload("hail.address-binding",binding.cose).payload,representation:binding.cose,digest:binding.digest};}},
      {async verify(){return verifiedProfile!;}},base);
    const binding=new AccountBinding(db.sql,resolver,encryptor,origin,addressVerifier);
    const app=createApp({publicOrigin:origin,hailServiceBase:base,providerId:"test"} as AppConfig,{accountApi:{accounts,grants,service,binding},discoveryStore:repository,
      selfServiceOnboarding:{sql:db.sql,onboarding,activation,provider:origin},async checkReadiness(){return {ready:true};}});
    vi.stubGlobal("fetch",(input:RequestInfo|URL,init?:RequestInit)=>app.fetch(input instanceof Request?input:new Request(String(input),init)));
    const paths={vault:join(directory,"vault.json"),state:join(directory,"state.json"),credential:join(directory,"credential.json")};
    await writeFile(paths.vault,JSON.stringify(vault.vault),{mode:0o600});
    const address=`signup-${randomUUID()}@source.example.com`;
    try {
      const input=async()=>encodeBase64Url(vault.recoverySecret);
      const created=await createAccount(origin,address,custody,paths.vault,paths.state,paths.credential,input);
      const before=writes;
      expect(await createAccount(origin,address,custody,paths.vault,paths.state,paths.credential,input)).toEqual(created);
      expect(writes).toBe(before);
      const client=await AccountApiClient.fromCredentialFile(paths.credential),summary=await client.account();
      expect(summary.custodyProfile).toBe(custody);expect(summary.ownerRecoveryPublicKey).toBe(vault.vault.recovery.publicDidKey);
      const op=log.get(created.did!)!;expect(op.rotationKeys[0]).toBe(vault.vault.recovery.publicDidKey);
      const keys=await db.sql<{role:string;public_key:string}[]>`SELECT role,public_key FROM account_keys WHERE account_id=${summary.accountId}`;
      expect(keys.some(key=>key.public_key===vault.vault.recovery.publicDidKey)).toBe(false);
      expect(keys.some(key=>key.role==="hail-identity")).toBe(custody==="managed");
      expect(summary.scopes).toContain("credentials:write");
      if(custody==="managed") {
        peer=[...log.keys()].find(value=>value!==created.did)!;
        const peerAccount=(await repository.getAccountByDid(peer))!,key=await repository.getKey(peerAccount.id,"hail-messaging"),resolved=await resolver.resolve(peer);
        const secret=await encryptor.decrypt(peerAccount.id,key.role,key.algorithm,key.publicKey,key);
        const profile:HailSenderProfile={type:"hail.sender-profile",version:1,did:peer,revision:1,display_name:"Peer",offers_uncategorized:false,
          categories:[{id:"updates",label:"Updates"}],updated_at:Math.floor(Date.now()/1000),key_id:`${peer}#hail-messaging`};
        const bytes=await signPayload("hail.sender-profile",profile,createWebCryptoSigner(profile.key_id,await importEd25519PrivateKey(secret)));secret.fill(0);
        verifiedProfile={did:peer,serviceBase:base,messagingDidKey:key.publicKey,profile,representation:bytes,
          digest:new Uint8Array(createHash("sha256").update(bytes).digest()),plcEvidence:resolved.evidence,verifiedAt:new Date(),etag:"fixture"};
        const request={sender:peerAccount.canonicalAddress,category:"updates",expiresAt:null};
        const grant=await createGrant(client,request.sender,request.category,"",join(directory,"managed.cose"),null);
        expect((await createGrant(client,request.sender,request.category,"",join(directory,"managed.cose"),null)).grantId).toBe(grant.grantId);
        expect((await client.request("/grants/managed",request)).grantId).toBe(grant.grantId);
        expect((await client.request(`/grants/${grant.grantId}/revoke`,{})).status).toBe("revoked");
        expect((await client.request(`/grants/${grant.grantId}/revoke`,{})).revision).toBe(2);
        expect(await db.sql`SELECT revision FROM grant_revisions WHERE grant_id=${grant.grantId as string}`).toHaveLength(2);
      }
      const state=JSON.parse(await readFile(paths.state,"utf8"));
      const denied=await app.request(`${origin}/api/v1/onboarding/${summary.accountId}`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({operation:state.operation,binding:state.binding})});
      expect(denied.status).toBe(401);
      const newToken=`hailp_${encodeBase64Url(randomBytes(32))}`;
      const credential=await client.request("/credentials",{token:newToken});
      expect((await client.request("/credentials",{token:newToken})).credentialId).toBe(credential.credentialId);
      expect((await client.request("/credentials",{revoke:credential.credentialId})).revoked).toBe(true);
      const initial=await showBinding(client),oldBytes=(await repository.getBindingForAccount(summary.accountId)).cose;
      const renewal=join(directory,"renewed.cose"),expiry=Number(initial.expiresAt)+1;
      const boundSource=await readFile(paths.vault,"utf8"),boundVault=JSON.parse(boundSource);
      if(custody==="owner-controlled")await writeFile(paths.vault,JSON.stringify({...boundVault,recovery:{...boundVault.recovery,ciphertext:"AA"}}));
      const renew=()=>renewBinding(client,renewal,expiry,custody==="owner-controlled"?paths.vault:undefined,input);
      verificationUnavailable=true;
      await expect(renew()).rejects.toThrow("HTTP 503");verificationUnavailable=false;
      const resumed=await renew();expect(await renew()).toEqual(resumed);expect(resumed.status).toBe("active");
      expect((await showBinding(client)).digest).toBe(resumed.digest);
      expect((await repository.findPublishedById(initial.bindingId as string))!.cose).toEqual(oldBytes);
      const selected=await db.sql`SELECT id FROM address_bindings WHERE canonical_address=${address} AND selected_at IS NOT NULL`;
      expect(selected).toHaveLength(1);expect(selected[0]!.id).toBe(resumed.bindingId);
      // Original signup artifacts still resolve their original immutable binding.
      await writeFile(paths.vault,boundSource);
      expect(await createAccount(origin,address,custody,paths.vault,paths.state,paths.credential,input)).toEqual(created);
      await expect(renewBinding(client,renewal,expiry+1,custody==="owner-controlled"?paths.vault:undefined,input)).rejects.toThrow("changed");
      await expect(renewBinding(client,join(directory,"too-long.cose"),Math.floor(Date.now()/1000)+91*86400,
        custody==="owner-controlled"?paths.vault:undefined,input)).rejects.toThrow("90 days");
      const second=await renewBinding(client,join(directory,"second.cose"),expiry+1,custody==="owner-controlled"?paths.vault:undefined,input);
      const superseded=await renew();expect(superseded.status).toBe("superseded");expect((await showBinding(client)).digest).toBe(second.digest);
      const requestState=JSON.parse(await readFile(`${join(directory,"second.cose")}.request.json`,"utf8"));
      const conflictPayload={...requestState.payload,issued_at:requestState.payload.issued_at+1,expires_at:requestState.payload.expires_at+1};
      const signedOwner=custody==="owner-controlled"?await (await unlockUserIdentity(boundVault,vault.recoverySecret)).signAddressBinding(conflictPayload):undefined;
      const conflicting={previous:encodeBase64Url(randomBytes(32)),signingKey:summary.identityPublicKey,
        ...(custody==="managed"?{payload:conflictPayload}:{cose:encodeBase64Url(signedOwner!)})};
      await expect(client.request("/binding",conflicting)).rejects.toThrow("HTTP 409");
      expect((await showBinding(client)).digest).toBe(second.digest);
      if(custody==="managed")await expect(client.request("/binding",{...conflicting,payload:{...conflictPayload,expires_at:conflictPayload.issued_at+91*86400}})).rejects.toThrow("HTTP 400");
      const session=(await accounts.authenticate(`Bearer ${state.token}`))!;
      await expect(binding.renew(session,{...conflicting,signingKey:vault.vault.recovery.publicDidKey})).rejects.toThrow("authority");
      await db.sql`INSERT INTO provider_migration_fences (did,account_id,transfer_id,destination_service_base,state)
        VALUES (${created.did!},${summary.accountId},${randomUUID()},'https://other.example.com/hail','fenced')`;
      await expect(binding.renew(session,conflicting)).rejects.toThrow("cannot renew");
      await db.sql`DELETE FROM provider_migration_fences WHERE account_id=${summary.accountId}`;
      const deniedCredential=await accounts.issue(address,false,undefined,["account:read","grants:write"]);
      await writeFile(join(directory,"limited.json"),JSON.stringify({type:"hailp.api-credential",version:1,provider:origin,...deniedCredential}),{mode:0o600});
      const limited=await AccountApiClient.fromCredentialFile(join(directory,"limited.json"));
      await expect(renewBinding(limited,join(directory,"denied.cose"),expiry+2,paths.vault,input)).rejects.toThrow("cannot renew");
      const limitedSession=(await accounts.authenticate(`Bearer ${deniedCredential.token}`))!;
      await expect(binding.renew(limitedSession,conflicting)).rejects.toThrow("credential");
      const expiredCredential=await accounts.issue(address,false,undefined,["account:read","account:write"]);
      const expiredSession=(await accounts.authenticate(`Bearer ${expiredCredential.token}`))!;
      await db.sql`UPDATE account_api_credentials SET created_at=now()-interval '2 days',expires_at=now()-interval '1 day' WHERE id=${expiredCredential.credentialId}`;
      await expect(binding.renew(expiredSession,conflicting)).rejects.toThrow("credential");
      const revokedCredential=await accounts.issue(address,false,undefined,["account:read","account:write"]);
      const revokedSession=(await accounts.authenticate(`Bearer ${revokedCredential.token}`))!;
      await accounts.revoke(revokedCredential.credentialId);
      await expect(binding.renew(revokedSession,conflicting)).rejects.toThrow("credential");
      const now=Math.floor(Date.now()/1000),expiredPayload={...requestState.payload,issued_at:now-7200,expires_at:now-3600};
      let expiredBytes:Uint8Array;
      if(custody==="owner-controlled")expiredBytes=await (await unlockUserIdentity(boundVault,vault.recoverySecret)).signAddressBinding(expiredPayload);
      else {const key=await repository.getKey(summary.accountId,"hail-identity"),raw=await encryptor.decrypt(summary.accountId,key.role,key.algorithm,key.publicKey,key);
        try {expiredBytes=await signPayload("hail.address-binding",expiredPayload,createWebCryptoSigner(expiredPayload.key_id,await importEd25519PrivateKey(raw)));}finally{raw.fill(0);}}
      const grantSnapshot=await db.sql`SELECT grant_id,current_revision,current_status FROM grant_lineages
        WHERE grantor_did=${created.did!} OR grantee_did=${created.did!} ORDER BY grant_id`;
      await db.sql.begin(async tx=>{
        await tx`UPDATE address_bindings SET selected_at=NULL WHERE account_id=${summary.accountId}`;
        // Legacy overlapping selection must not become an expiry fallback.
        await tx`UPDATE address_bindings SET selected_at=now()-interval '1 day' WHERE id=${initial.bindingId as string}`;
        await tx`INSERT INTO address_bindings (id,account_id,canonical_address,did,cose,representation_digest,issued_at,expires_at,hosted_at,selected_at,published_at)
          VALUES (${randomUUID()},${summary.accountId},${address},${created.did!},${expiredBytes},${new Uint8Array(createHash("sha256").update(expiredBytes).digest())},
            ${new Date(expiredPayload.issued_at*1000)},${new Date(expiredPayload.expires_at*1000)},now(),now(),now())`;
      });
      expect(await showBinding(client)).toMatchObject({status:"expired",renewalDue:true});
      const webfinger=`${origin}/.well-known/webfinger?resource=${encodeURIComponent(`acct:${address}`)}&rel=${encodeURIComponent("https://hailproto.com/rel/address-binding")}`;
      expect((await app.request(webfinger)).status).toBe(404); // Never fall back to a superseded unexpired binding.
      expect((await renewBinding(client,join(directory,"after-expiry.cose"),now+86400,custody==="owner-controlled"?paths.vault:undefined,input)).status).toBe("active");
      expect((await app.request(webfinger)).status).toBe(200);
      expect(await db.sql`SELECT grant_id,current_revision,current_status FROM grant_lineages
        WHERE grantor_did=${created.did!} OR grantee_did=${created.did!} ORDER BY grant_id`).toEqual(grantSnapshot);
      const directoryWrites = writes;
      const rotation = await rotateCredential(paths.credential, join(directory, "rotated.json"));
      expect(await rotateCredential(paths.credential, join(directory, "rotated.json"))).toEqual(rotation);
      const rotatedAccount = await (await AccountApiClient.fromCredentialFile(join(directory, "rotated.json"))).account();
      expect(rotatedAccount.credential?.credentialId).toBe(rotation.credentialId);
      expect(rotatedAccount.credential?.expiresAt).toBe(rotation.expiresAt);
      expect(rotatedAccount.custodyProfile).toBe(custody);
      expect(rotatedAccount.ownerRecoveryPublicKey).toBe(vault.vault.recovery.publicDidKey);
      expect(rotatedAccount.scopes).toEqual(summary.scopes);
      expect(writes).toBe(directoryWrites);
    } finally {vault.recoverySecret.fill(0);vi.unstubAllGlobals();await rm(directory,{recursive:true,force:true});}
  });
});
