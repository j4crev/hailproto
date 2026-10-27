import {createHash,generateKeyPairSync,randomBytes,randomUUID,sign} from "node:crypto";
import {SQL} from "bun";
import {Hono} from "hono";
import {expect,it,vi} from "vitest";
import {P256Keypair} from "@atproto/crypto";
import {base58btc} from "multiformats/bases/base58";
import {createWebCryptoSigner,signPayload,encodeBase64Url,fromDiagnosticJson,type HailGrant} from "@hailproto/codec";
import {ProviderDatabase} from "../src/db/database.js";
import {AccountApiRepository} from "../src/accounts/repository.js";
import {PasskeyAuth} from "../src/accounts/passkeys.js";
import {GrantPermissions,registerPermissionRoutes} from "../src/accounts/permissions.js";
import {registerAccountApiRoutes} from "../src/accounts/routes.js";
import {GrantRepository} from "../src/grants/repository.js";
import {GrantService} from "../src/grants/service.js";
import {OnboardingRepository} from "../src/onboarding/repository.js";
import {KeyEncryptor} from "../src/identity/key-encryption.js";
import type {HailDidResolver} from "../src/plc/resolver.js";
import type {VerifiedAddress} from "../src/discovery/verifier.js";
import type {VerifiedSenderProfile} from "../src/profiles/store.js";

it.skipIf(!process.env.DATABASE_URL)("approves only exact managed permissions with account-bound passkeys, safe retries, revocation and retained rollback proof",async()=>{
  const admin=new SQL(process.env.DATABASE_URL!),schema="permissions_"+randomUUID().replaceAll("-","");
  await admin.unsafe(`CREATE SCHEMA "${schema}"`);const url=new URL(process.env.DATABASE_URL!);url.searchParams.set("options",`-csearch_path=${schema}`);
  const db=new ProviderDatabase(url.toString()),origin="https://provider.example.com",base=origin+"/hail",owner=randomUUID(),other=randomUUID();
  const ownerDid="did:plc:"+"a".repeat(24),otherDid="did:plc:"+"b".repeat(24),peerDid="did:plc:"+"c".repeat(24);
  const key=generateKeyPairSync("ec",{namedCurve:"prime256v1"}),jwk=key.publicKey.export({format:"jwk"}),credential=encodeBase64Url(randomBytes(32)),otherCredential=encodeBase64Url(randomBytes(32));
  const cose=Buffer.concat([Buffer.from("a5010203262001215820","hex"),Buffer.from(jwk.x!,"base64url"),Buffer.from("225820","hex"),Buffer.from(jwk.y!,"base64url")]);
  let counter=0,peerDown=false,profileChanged=false;
  const assertion=(challenge:string,change:{origin?:string;flags?:number;id?:string}={})=>{
    const client=Buffer.from(JSON.stringify({type:"webauthn.get",challenge,origin:change.origin??origin})),auth=Buffer.alloc(37);
    createHash("sha256").update("provider.example.com").digest().copy(auth);auth[32]=change.flags??5;auth.writeUInt32BE(++counter,33);
    const signature=sign("sha256",Buffer.concat([auth,createHash("sha256").update(client).digest()]),key.privateKey),id=change.id??credential;
    return {id,rawId:id,type:"public-key" as const,clientExtensionResults:{},response:{clientDataJSON:client.toString("base64url"),authenticatorData:auth.toString("base64url"),signature:signature.toString("base64url"),userHandle:Buffer.from(owner.replaceAll("-",""),"hex").toString("base64url")}};
  };
  const identity=await crypto.subtle.generateKey("Ed25519",true,["sign","verify"]),publicBytes=new Uint8Array(await crypto.subtle.exportKey("raw",identity.publicKey));
  const didKey="did:key:"+base58btc.encode(new Uint8Array([0xed,1,...publicBytes])),encryptor=new KeyEncryptor(encodeBase64Url(randomBytes(32)));
  const evidence={document:{},data:{},log:[]},digest=(bytes:Uint8Array)=>new Uint8Array(createHash("sha256").update(bytes).digest());
  try{
    await db.migrate();
    for(const [id,did,address] of [[owner,ownerDid,"owner@provider.example.com"],[other,otherDid,"other@provider.example.com"]]){
      await db.sql`INSERT INTO provider_accounts(id,tenant_id,canonical_address,did,onboarding_state,activated_at,activation_binding_digest,activation_verification_mode)
        VALUES(${id!},${randomUUID()},${address!},${did!},'active',now(),${randomBytes(32)},'public')`;
      const raw=new Uint8Array(await crypto.subtle.exportKey("pkcs8",identity.privateKey)),sealed=await encryptor.encrypt(id!,"hail-identity","ed25519",didKey,raw);raw.fill(0);
      await db.sql`INSERT INTO account_keys(account_id,role,algorithm,public_key,encrypted_private_key,encryption_nonce,encryption_version,kek_id)
        VALUES(${id!},'hail-identity','ed25519',${didKey},${sealed.ciphertext},${sealed.nonce},1,'poc-v1')`;
      await db.sql`INSERT INTO managed_custody_evidence(account_id,owner_recovery_public_key,provider_identity_public_key,verification_mode,managed_profile_version)
        VALUES(${id!},${(await P256Keypair.create()).did()},${didKey},'reduced-assurance-alpha-v1','hail-managed-custody-v1')`;
    }
    await db.sql`INSERT INTO account_passkeys(credential_id,account_id,serving_generation,public_key,device_type,backed_up,label)
      VALUES(${credential},${owner},1,${cose},'singleDevice',false,'Permission test')`;
    await db.sql`INSERT INTO account_passkeys(credential_id,account_id,serving_generation,public_key,device_type,backed_up,label)
      VALUES(${otherCredential},${other},1,${cose},'singleDevice',false,'Other account test')`;
    const passkeys=new PasskeyAuth(db.sql,"provider.example.com",origin),accounts=new AccountApiRepository(db.sql),grants=new GrantRepository(db.sql);
    const login=await passkeys.authenticationOptions(),signedIn=await passkeys.authenticate(login.challengeId,assertion(login.options.challenge));
    const session=(await accounts.authenticate(undefined,signedIn.token))!;
    const anotherLogin=await passkeys.authenticationOptions(),anotherToken=await passkeys.authenticate(anotherLogin.challengeId,assertion(anotherLogin.options.challenge));
    const anotherSession=(await accounts.authenticate(undefined,anotherToken.token))!;
    const foreignLogin=await passkeys.authenticationOptions(),foreignToken=await passkeys.authenticate(foreignLogin.challengeId,assertion(foreignLogin.options.challenge,{id:otherCredential}));
    const foreignSession=(await accounts.authenticate(undefined,foreignToken.token))!;
    expect(session.scopes).not.toContain("grants:write");
    const before=await db.sql`SELECT id,account_id,scopes FROM account_passkey_sessions ORDER BY id`;
    const snapshot=async()=>JSON.stringify(await db.sql`SELECT account_id,role,public_key,encrypted_private_key,encryption_nonce FROM account_keys ORDER BY account_id,role`);
    const keysBefore=await snapshot();
    const emptyRollback=await db.sql.reserve();try{
      const rollbackDirectory=new URL("../migrations/rollback/",import.meta.url).pathname;
      for(const file of [...new Bun.Glob("*.sql").scanSync(rollbackDirectory)].filter(file=>Number(file.slice(0,4))>65).sort().reverse())
        await emptyRollback.unsafe(await Bun.file(rollbackDirectory+file).text());
      await emptyRollback.unsafe(await Bun.file(new URL("../migrations/rollback/0065_connection_messages.sql",import.meta.url)).text());
      await emptyRollback.unsafe(await Bun.file(new URL("../migrations/rollback/0064_connection_federation.sql",import.meta.url)).text());
      await emptyRollback.unsafe(await Bun.file(new URL("../migrations/rollback/0063_connection_owner_signing.sql",import.meta.url)).text());
      await emptyRollback.unsafe(await Bun.file(new URL("../migrations/rollback/0062_connection_preview.sql",import.meta.url)).text());
      await emptyRollback.unsafe(await Bun.file(new URL("../migrations/rollback/0061_publications.sql",import.meta.url)).text());
      await emptyRollback.unsafe(await Bun.file(new URL("../migrations/rollback/0060_provider_role_addresses.sql",import.meta.url)).text());
      await emptyRollback.unsafe(await Bun.file(new URL("../migrations/rollback/0059_grant_approvals.sql",import.meta.url)).text());
    }finally{emptyRollback.release();}
    await db.migrate();expect(await snapshot()).toBe(keysBefore);
    const now=Math.floor(Date.now()/1000),profile={type:"hail.sender-profile" as const,version:1 as const,did:peerDid,revision:1,updated_at:now,display_name:"Peer",offers_uncategorized:true,
      categories:[{id:"receipts",label:"Receipts"},{id:"updates",label:"Updates"}],key_id:peerDid+"#hail-messaging"};
    const binding={type:"hail.address-binding" as const,version:1 as const,address:"peer@peer.example.com",did:peerDid,issued_at:now,expires_at:now+86400,key_id:peerDid+"#hail-identity"};
    const signer=createWebCryptoSigner(peerDid+"#hail-identity",identity.privateKey),profileBytes=await signPayload("hail.sender-profile",profile,createWebCryptoSigner(peerDid+"#hail-messaging",identity.privateKey)),bindingBytes=await signPayload("hail.address-binding",binding,signer);
    const address:VerifiedAddress={address:binding.address,did:peerDid,serviceBase:"https://peer.example.com/hail",identityDidKey:didKey,messagingDidKey:didKey,
      binding,representation:bindingBytes,digest:digest(bindingBytes),plcEvidence:evidence,verifiedAt:new Date()};
    let senderProfile:VerifiedSenderProfile={did:peerDid,serviceBase:address.serviceBase,messagingDidKey:didKey,profile,representation:profileBytes,
      digest:digest(profileBytes),etag:encodeBase64Url(digest(profileBytes)),plcEvidence:evidence,verifiedAt:new Date()};
    const resolver={async resolve(did:string){if(did===peerDid&&peerDown)throw new Error("Peer offline");return {did,identityDidKey:didKey,messagingDidKey:didKey,serviceBase:did===peerDid?address.serviceBase:base,evidence};}} as HailDidResolver;
    const service=new GrantService(new OnboardingRepository(db.sql),grants,encryptor,resolver,{async verify(){if(peerDown)throw new Error("Peer offline");return address;}},
      {async verify(){if(peerDown)throw new Error("Peer offline");return profileChanged?{...senderProfile,digest:randomBytes(32)}:senderProfile;}},base);
    let permissions=new GrantPermissions(db.sql,accounts,grants,service,passkeys,origin);
    const app=new Hono();registerPermissionRoutes(app,permissions,accounts,origin);registerAccountApiRoutes(app,accounts,grants,service,origin,undefined,undefined,undefined,undefined,undefined,undefined,undefined,origin);
    const call=(path:string,body?:unknown,headers:Record<string,string>={})=>app.request(origin+"/api/v1/account/"+path,{method:body===undefined?"GET":"POST",
      headers:{Origin:origin,"Content-Type":"application/json",Cookie:`hail_session=${signedIn.token}`,...headers},...(body===undefined?{}:{body:JSON.stringify(body)})});
    expect((await call("grants/managed",{sender:binding.address,category:"updates",expiresAt:now+86400})).status).toBe(403);
    expect((await call("permissions/review",{sender:binding.address},{Origin:"https://evil.example"})).status).toBe(403);
    expect((await call("permissions/review",{sender:binding.address,senderDid:otherDid})).status).toBe(409);
    const review=await permissions.review(session,{sender:binding.address,senderDid:peerDid});expect(review.categories).toHaveLength(2);
    const input={requestId:randomUUID(),action:"allow",sender:binding.address,senderDid:peerDid,addressDigest:review.addressDigest,profileDigest:review.profileDigest,
      scope:{type:"categories",values:["updates"]},expiresAt:now+86400};
    profileChanged=true;await expect(permissions.prepare(session,input)).rejects.toMatchObject({status:409});profileChanged=false;
    const started=await call("permissions/prepare",input);expect(started.status).toBe(200);
    const prepared=await started.json() as Awaited<ReturnType<GrantPermissions["prepare"]>>;
    expect(await permissions.prepare(session,input)).toEqual(prepared);
    await expect(permissions.prepare(session,{...input,expiresAt:now+90000})).rejects.toMatchObject({status:409});
    await expect(permissions.status(foreignSession,prepared.requestId)).rejects.toMatchObject({status:404});
    await expect(permissions.status(anotherSession,prepared.requestId)).rejects.toMatchObject({status:404});
    await expect(permissions.commit(session,prepared.requestId)).rejects.toMatchObject({status:403});
    await expect(passkeys.authenticate(prepared.requestId,assertion(prepared.options!.challenge))).rejects.toMatchObject({status:400});
    for(const change of [{origin:"https://evil.example"},{flags:1},{id:"wrong-credential"}])
      await expect(permissions.commit(session,prepared.requestId,assertion(prepared.options!.challenge,change))).rejects.toMatchObject({status:401});
    await expect(permissions.commit(session,prepared.requestId,assertion(prepared.options!.challenge,{id:otherCredential}))).rejects.toMatchObject({status:403});
    await expect(permissions.commit(session,prepared.requestId,assertion(login.options.challenge))).rejects.toMatchObject({status:401});
    expect(await db.sql`SELECT grant_id FROM grant_lineages`).toHaveLength(0);
    const proof=assertion(prepared.options!.challenge),attempts=await Promise.all([call("permissions/commit",{requestId:prepared.requestId,response:proof}),call("permissions/commit",{requestId:prepared.requestId,response:proof})]);
    expect(attempts.every(r=>[200,409].includes(r.status))).toBe(true);const committed=attempts.find(r=>r.status===200)!;expect(committed).toBeDefined();
    const accepted=await committed.json() as Awaited<ReturnType<GrantPermissions["commit"]>>;expect(accepted.result).toMatchObject({status:"active",revision:1});
    expect((await app.request(origin+"/api/v1/account/permissions/"+prepared.requestId,{headers:{Cookie:`hail_session=${signedIn.token}`}})).status).toBe(200);
    permissions=new GrantPermissions(db.sql,accounts,grants,service,passkeys,origin);
    expect((await permissions.commit(session,prepared.requestId)).result).toEqual(accepted.result);
    expect(await db.sql`SELECT grant_id FROM grant_lineages`).toHaveLength(1);expect(await db.sql`SELECT grant_id FROM grant_publications`).toHaveLength(1);
    expect(await db.sql`SELECT id,account_id,scopes FROM account_passkey_sessions ORDER BY id`).toEqual(before);
    expect(await db.sql`SELECT id FROM account_api_credentials`).toHaveLength(0);expect(await snapshot()).toBe(keysBefore);
    const payload=fromDiagnosticJson("hail.grant",prepared.permission),current=(await grants.findCurrentByGrantId(payload.grant_id))!;
    const revoke={requestId:randomUUID(),action:"revoke",grantId:payload.grant_id,revision:1,digest:encodeBase64Url(current.digest)};
    const stale=await permissions.prepare(session,revoke);
    const updated=await service.prepareUserSignedUpdate(session.canonical_address,payload.grant_id,{scope:payload.scope[0]!,expiresAt:now+80000,expectedRevision:1,expectedDigest:current.digest,refreshConsent:false});
    const beforeRace=service.revoke.bind(service);let changeBeforeSigning=true;
    service.revoke=async(...args)=>{if(changeBeforeSigning){changeBeforeSigning=false;await service.updateManaged(session.canonical_address,updated,didKey);}return beforeRace(...args);};
    await expect(permissions.commit(session,stale.requestId,assertion(stale.options!.challenge))).rejects.toMatchObject({status:409});
    service.revoke=beforeRace;
    const latest=(await grants.findCurrentByGrantId(payload.grant_id))!;
    const revocation=await permissions.prepare(session,{...revoke,requestId:randomUUID(),revision:2,digest:encodeBase64Url(latest.digest)});
    await expect(permissions.commit(session,revocation.requestId,assertion(prepared.options!.challenge))).rejects.toMatchObject({status:401});
    peerDown=true;const realRevoke=service.revoke.bind(service);let loseReply=true;
    service.revoke=async(...args)=>{const result=await realRevoke(...args);if(loseReply){loseReply=false;throw new Error("Lost committed reply");}return result;};
    await expect(permissions.commit(session,revocation.requestId,assertion(revocation.options!.challenge))).rejects.toThrow("Lost committed reply");
    expect((await permissions.status(session,revocation.requestId)).approved).toBe(true);
    const done=await permissions.commit(session,revocation.requestId);expect(done.result).toMatchObject({status:"revoked",revision:3});
    expect((await permissions.commit(session,prepared.requestId)).result).toEqual(accepted.result);
    expect((await grants.findCurrentByGrantId(payload.grant_id))?.payload.status).toBe("revoked");
    expect(await db.sql`SELECT grant_id FROM grant_revisions`).toHaveLength(3);
    const expiry=vi.spyOn(Date,"now").mockReturnValue(Date.now()+7*60_000);
    try{await expect(permissions.commit(session,stale.requestId)).rejects.toMatchObject({status:410});expect((await permissions.status(session,revocation.requestId)).result).toEqual(done.result);}finally{expiry.mockRestore();}
    peerDown=false;
    await expect(permissions.prepare(session,{...input,requestId:randomUUID(),scope:{type:"uncategorized"}})).rejects.toMatchObject({status:400});
    await expect(service.prepareUserSignedGrant(session.canonical_address,binding.address,{scope:{type:"uncategorized"},expiresAt:null})).rejects.toMatchObject({status:400});
    const generalProfile={...profile,revision:2,updated_at:now+1,offers_uncategorized:false,categories:[{id:"general",label:"General"},...profile.categories]};
    const generalBytes=await signPayload("hail.sender-profile",generalProfile,createWebCryptoSigner(peerDid+"#hail-messaging",identity.privateKey));
    senderProfile={...senderProfile,profile:generalProfile,representation:generalBytes,digest:digest(generalBytes),etag:encodeBase64Url(digest(generalBytes))};
    const generalReview=await permissions.review(session,{sender:binding.address});
    const generalInput={...input,requestId:randomUUID(),profileDigest:generalReview.profileDigest,scope:{type:"categories",values:["general"]}};
    const generalApproval=await permissions.prepare(session,generalInput),generalPayload=fromDiagnosticJson("hail.grant",generalApproval.permission);
    expect(generalPayload).toMatchObject({revision:1,scope:[{type:"categories",values:["general"]}],expires_at:input.expiresAt});
    await expect(permissions.commit(session,generalApproval.requestId)).rejects.toMatchObject({status:403});
    const general=await permissions.commit(session,generalApproval.requestId,assertion(generalApproval.options!.challenge));
    expect(general.result).toMatchObject({status:"active",revision:1});
    expect((await grants.findCurrentByGrantId(generalPayload.grant_id))?.payload.scope).toEqual([{type:"categories",values:["general"]}]);
    // One immutable batch challenge covers exactly the reviewed subscriptions.
    service.revoke=realRevoke;
    let senderIndex=3;
    const makeGrant=async()=>{
      const did="did:plc:"+String.fromCharCode(97+senderIndex++).repeat(24),sender=`${did.slice(-1)}@peer.example.com`;
      const binding={...address.binding,did,address:sender,key_id:did+"#hail-identity"};
      const profile={...senderProfile.profile,did,key_id:did+"#hail-messaging"};
      const bindingBytes=await signPayload("hail.address-binding",binding,createWebCryptoSigner(did+"#hail-identity",identity.privateKey));
      const profileBytes=await signPayload("hail.sender-profile",profile,createWebCryptoSigner(did+"#hail-messaging",identity.privateKey));
      const newAddress={...address,did,address:sender,binding,representation:bindingBytes,digest:digest(bindingBytes)};
      const newProfile={...senderProfile,did,profile,representation:profileBytes,digest:digest(profileBytes),etag:encodeBase64Url(digest(profileBytes))};
      const creator=new GrantService(new OnboardingRepository(db.sql),grants,encryptor,resolver,{async verify(){return newAddress;}},{async verify(){return newProfile;}},base);
      const payload=await creator.prepareUserSignedGrant(session.canonical_address,sender,{scope:{type:"categories",values:["general"]},expiresAt:now+86400});
      return creator.updateManaged(session.canonical_address,payload,didKey);
    };
    const batchGrants=await Promise.all([makeGrant(),makeGrant(),makeGrant()]);
    const selections=batchGrants.map(grant=>({grantId:grant.payload.grant_id,revision:grant.payload.revision,digest:encodeBase64Url(grant.digest)}));
    const batchInput={requestId:randomUUID(),action:"revoke",grants:selections.slice(0,2)};
    const batch=await permissions.prepare(session,batchInput);
    expect(batch.permissions).toHaveLength(2);
    expect(await permissions.prepare(session,batchInput)).toEqual(batch);
    await expect(permissions.prepare(session,{...batchInput,grants:selections})).rejects.toMatchObject({status:409});
    await expect(permissions.prepare(session,{...batchInput,requestId:randomUUID(),grants:[selections[0],selections[0]]})).rejects.toMatchObject({status:400});
    await expect(permissions.prepare(session,{...batchInput,requestId:randomUUID(),grants:[selections[0],{...selections[1],revision:999}]})).rejects.toMatchObject({status:409});
    await expect(permissions.status(anotherSession,batch.requestId)).rejects.toMatchObject({status:404});
    await expect(permissions.status(foreignSession,batch.requestId)).rejects.toMatchObject({status:404});
    await expect(permissions.commit(session,batch.requestId)).rejects.toMatchObject({status:403});
    await expect(permissions.commit(session,batch.requestId,assertion(revocation.options!.challenge))).rejects.toMatchObject({status:401});
    const batchBefore=await db.sql`SELECT grant_id FROM grant_revisions`;
    const verify=vi.spyOn(passkeys,"approveAction");
    let loseBatchReply=true;
    service.revoke=async(...args)=>{const saved=await realRevoke(...args);if(loseBatchReply){loseBatchReply=false;throw new Error("Lost batch reply");}return saved;};
    await expect(permissions.commit(session,batch.requestId,assertion(batch.options!.challenge))).rejects.toThrow("Lost batch reply");
    const batchDone=await permissions.commit(session,batch.requestId);
    expect(batchDone.result).toMatchObject({items:selections.slice(0,2).map(item=>({grantId:item.grantId,result:{status:"revoked",revision:2},error:null}))});
    expect(verify).toHaveBeenCalledTimes(1);verify.mockRestore();
    expect(await db.sql`SELECT grant_id FROM grant_revisions`).toHaveLength(batchBefore.length+2);
    expect((await permissions.commit(session,batch.requestId)).result).toEqual(batchDone.result);
    expect((await grants.findCurrentByGrantId(selections[2]!.grantId))?.payload.status).toBe("active");
    // A changed member is reported independently; its newer revision is untouched.
    const extra=await makeGrant(),last=batchGrants[2]!;
    const mixed=await permissions.prepare(session,{requestId:randomUUID(),action:"revoke",grants:[selections[2],{grantId:extra.payload.grant_id,revision:1,digest:encodeBase64Url(extra.digest)}]});
    const changed=await service.prepareUserSignedUpdate(session.canonical_address,last.payload.grant_id,{scope:last.payload.scope[0]!,expiresAt:now+80000,expectedRevision:1,expectedDigest:last.digest,refreshConsent:false});
    await service.updateManaged(session.canonical_address,changed,didKey);
    service.revoke=realRevoke;
    const mixedDone=await permissions.commit(session,mixed.requestId,assertion(mixed.options!.challenge));
    expect(mixedDone.result).toMatchObject({items:[{grantId:last.payload.grant_id,result:null,error:expect.any(String)},{grantId:extra.payload.grant_id,result:{status:"revoked"},error:null}]});
    expect((await grants.findCurrentByGrantId(last.payload.grant_id))?.payload).toMatchObject({status:"active",revision:2});
    expect((await permissions.commit(session,mixed.requestId)).result).toEqual(mixedDone.result);
    await expect(db.sql`UPDATE account_grant_approvals SET action='revoke' WHERE id=${prepared.requestId}`).rejects.toThrow("cannot be replaced");
    const rollback=await db.sql.reserve();try{await expect(rollback.unsafe(await Bun.file(new URL("../migrations/rollback/0059_grant_approvals.sql",import.meta.url)).text())).rejects.toThrow("prevent rollback");}finally{await rollback.unsafe("ROLLBACK");rollback.release();}
    await db.sql`UPDATE account_passkeys SET revoked_at=now() WHERE credential_id=${credential}`;
    await expect(permissions.commit(session,revocation.requestId)).rejects.toMatchObject({status:403});
    expect(await snapshot()).toBe(keysBefore);
  }finally{await db.close();await admin.unsafe(`DROP SCHEMA "${schema}" CASCADE`);await admin.close();}
},45_000);
