import {createHash,generateKeyPairSync,randomBytes,randomUUID,sign} from "node:crypto";
import {SQL} from "bun";
import {Hono} from "hono";
import {expect,it} from "vitest";
import {P256Keypair} from "@atproto/crypto";
import {createWebCryptoSigner,encodeBase64Url,fromDiagnosticJson,inspectSignedPayload,signPayload,createWebCryptoVerifier,verifySignedPayload} from "@hailproto/codec";
import {ProviderDatabase} from "../src/db/database.js";
import {AccountConnections} from "../src/accounts/connections.js";
import {registerConnectionRoutes} from "../src/accounts/connection-routes.js";
import {AccountApiRepository,type AccountApiSession} from "../src/accounts/repository.js";
import {PasskeyAuth} from "../src/accounts/passkeys.js";
import {KeyEncryptor} from "../src/identity/key-encryption.js";
import {generateAccountKeys} from "../src/identity/keys.js";
import {ed25519PublicKeyFromDidKey} from "../src/identity/did-key.js";
import type {HailDidResolver} from "../src/plc/resolver.js";
import {RemoteConnectionReview} from "../src/accounts/connection-review.js";

it.skipIf(!process.env.DATABASE_URL)("manages personal and expiring QR invitations, converges crossed consent and preserves terminal history",async()=>{
  const admin=new SQL(process.env.DATABASE_URL!),schema="connections_"+randomUUID().replaceAll("-","");
  await admin.unsafe(`CREATE SCHEMA "${schema}"`);const url=new URL(process.env.DATABASE_URL!);url.searchParams.set("options",`-csearch_path=${schema}`);
  const db=new ProviderDatabase(url.toString()),origin="https://provider.example.com",encryptor=new KeyEncryptor(encodeBase64Url(randomBytes(32)));
  const users=[] as {id:string;did:string;address:string;keys:Awaited<ReturnType<typeof generateAccountKeys>>;credential:string;token:string;session:AccountApiSession;
    assertion:(challenge:string,change?:{origin?:string;flags?:number})=>any}[];
  try{
    await db.migrate();
    const empty=await db.sql.reserve();try{await empty.unsafe(await Bun.file(new URL("../migrations/rollback/0066_connection_handover_preparations.sql",import.meta.url)).text());await empty.unsafe(await Bun.file(new URL("../migrations/rollback/0065_connection_messages.sql",import.meta.url)).text());await empty.unsafe(await Bun.file(new URL("../migrations/rollback/0064_connection_federation.sql",import.meta.url)).text());await empty.unsafe(await Bun.file(new URL("../migrations/rollback/0063_connection_owner_signing.sql",import.meta.url)).text());await empty.unsafe(await Bun.file(new URL("../migrations/rollback/0062_connection_preview.sql",import.meta.url)).text());}finally{empty.release();}
    await db.migrate();
    const passkeys=new PasskeyAuth(db.sql,"provider.example.com",origin),accounts=new AccountApiRepository(db.sql);
    for(const [i,name] of ["alice","bob","eve","owner","second-owner"].entries()){
      const id=randomUUID(),did="did:plc:"+String.fromCharCode(97+i).repeat(24),address=name+"@provider.example.com",keys=await generateAccountKeys(id,encryptor);
      await db.sql`INSERT INTO provider_accounts(id,tenant_id,canonical_address,did,onboarding_state,activated_at,activation_binding_digest,activation_verification_mode)
        VALUES(${id},${randomUUID()},${address},${did},'active',now(),${randomBytes(32)},'public')`;
      for(const key of keys.keys.filter(key=>i<3||key.role!=="hail-identity"))await db.sql`INSERT INTO account_keys(account_id,role,algorithm,public_key,encrypted_private_key,encryption_nonce,encryption_version,kek_id)
        VALUES(${id},${key.role},${key.algorithm},${key.publicKey},${key.ciphertext},${key.nonce},${key.encryptionVersion},${key.kekId})`;
      if(i<3)await db.sql`INSERT INTO managed_custody_evidence(account_id,owner_recovery_public_key,provider_identity_public_key,verification_mode,managed_profile_version)
        VALUES(${id},${(await P256Keypair.create()).did()},${keys.identityDidKey},'reduced-assurance-alpha-v1','hail-managed-custody-v1')`;
      else await db.sql`INSERT INTO portable_custody_evidence(account_id,user_recovery_public_key,user_identity_public_key,monitor_origin,monitor_confirmed_at,backup_confirmed_at,monitor_verification_mode)
        VALUES(${id},${(await P256Keypair.create()).did()},${keys.identityDidKey},'https://monitor.example.com',now(),now(),'poc-local')`;
      const pair=generateKeyPairSync("ec",{namedCurve:"prime256v1"}),jwk=pair.publicKey.export({format:"jwk"}),credential=encodeBase64Url(randomBytes(32));
      const cose=Buffer.concat([Buffer.from("a5010203262001215820","hex"),Buffer.from(jwk.x!,"base64url"),Buffer.from("225820","hex"),Buffer.from(jwk.y!,"base64url")]);
      await db.sql`INSERT INTO account_passkeys(credential_id,account_id,serving_generation,public_key,device_type,backed_up,label)
        VALUES(${credential},${id},1,${cose},'singleDevice',false,'Connection test')`;
      let counter=0;
      const assertion=(challenge:string,change:{origin?:string;flags?:number}={})=>{
        const client=Buffer.from(JSON.stringify({type:"webauthn.get",challenge,origin:change.origin??origin})),auth=Buffer.alloc(37);
        createHash("sha256").update("provider.example.com").digest().copy(auth);auth[32]=change.flags??5;auth.writeUInt32BE(++counter,33);
        return {id:credential,rawId:credential,type:"public-key" as const,clientExtensionResults:{},response:{clientDataJSON:client.toString("base64url"),
          authenticatorData:auth.toString("base64url"),signature:sign("sha256",Buffer.concat([auth,createHash("sha256").update(client).digest()]),pair.privateKey).toString("base64url"),
          userHandle:Buffer.from(id.replaceAll("-",""),"hex").toString("base64url")}};
      };
      const login=await passkeys.authenticationOptions(),signedIn=await passkeys.authenticate(login.challengeId,assertion(login.options.challenge));
      const session=(await accounts.authenticate(undefined,signedIn.token))!;
      const n=Math.floor(Date.now()/1000),binding=await signPayload("hail.address-binding",{type:"hail.address-binding",version:1,address,did,issued_at:n-10,expires_at:n+86400,key_id:did+"#hail-identity"},createWebCryptoSigner(did+"#hail-identity",keys.identityPrivateKey));
      await db.sql`INSERT INTO address_bindings(id,account_id,canonical_address,did,cose,representation_digest,issued_at,expires_at,selected_at,published_at,hosted_at)
        VALUES(${randomUUID()},${id},${address},${did},${binding},${new Uint8Array(createHash("sha256").update(binding).digest())},${new Date((n-10)*1000)},${new Date((n+86400)*1000)},now(),now(),now())`;
      users.push({id,did,address,keys,credential,token:signedIn.token,session,assertion});
    }
    const [a,b,e,o,p]=users as [typeof users[number],typeof users[number],typeof users[number],typeof users[number],typeof users[number]];
    let wrongService=false;
    const resolver:HailDidResolver={async resolve(did){const u=users.find(u=>u.did===did)!;return {did,identityDidKey:u.keys.identityDidKey,messagingDidKey:u.keys.messagingDidKey,
      serviceBase:wrongService?"https://other.example.com/hail":origin+"/hail",evidence:{document:{},data:{},log:[]}};}};
    let service=new AccountConnections(db.sql,encryptor,resolver,passkeys,origin);
    const signedOwner=(user:typeof a,review:Awaited<ReturnType<AccountConnections["prepare"]>>)=>{
      const wire=review.ownerSigning!;const type=(wire.payload as {type:string}).type;
      if(type!=="hail.connection-invitation"&&type!=="hail.connection-confirmation")throw new Error("Unexpected owner proposal");
      return signPayload(type,fromDiagnosticJson(type,wire.payload),createWebCryptoSigner(user.did+"#hail-identity",user.keys.identityPrivateKey));
    };
    const app=new Hono();registerConnectionRoutes(app,service,accounts,origin);
    const call=(step:string,body?:unknown,user=a,headers:Record<string,string>={})=>app.request(origin+"/api/v1/account/connections"+(step?"/"+step:""),{
      method:body===undefined?"GET":"POST",headers:{Origin:origin,"Content-Type":"application/json",Cookie:"hail_session="+user.token,...headers},...(body===undefined?{}:{body:JSON.stringify(body)})});
    expect((await app.request(origin+"/api/v1/account/connections")).status).toBe(401);
    expect((await call("prepare",{},a,{Origin:"https://evil.example.com"})).status).toBe(403);
    expect((await call("",undefined,a,{Authorization:"Bearer bogus"})).status).toBe(403);
    const create=async(user:typeof a,personal:boolean,expiresAt:number|null=personal?null:Math.floor(Date.now()/1000)+3600)=>{
      const input={requestId:randomUUID(),action:"create",personal,label:personal?"Personal code":"Event",expiresAt};
      const review=await service.prepare(user.session,input);
      const committed=await service.commit(user.session,review.requestId,user.assertion(review.options!.challenge),review.ownerSigning?await signedOwner(user,review):undefined);
      return (await service.list(user.session)).codes.find(code=>code.id===(committed.result as {invitationId:string}).invitationId)!;
    };
    const input={requestId:randomUUID(),action:"create",personal:true,label:"Personal code",expiresAt:null};
    const prepared=await service.prepare(a.session,input);
    await expect(service.prepare(a.session,{...input,label:"Changed"})).rejects.toMatchObject({status:409});
    await expect(service.status(e.session,prepared.requestId)).rejects.toMatchObject({status:404});
    await expect(service.commit(a.session,prepared.requestId)).rejects.toMatchObject({status:403});
    await expect(service.commit(a.session,prepared.requestId,a.assertion(prepared.options!.challenge,{origin:"https://evil.example"}))).rejects.toMatchObject({status:401});
    await expect(service.commit(a.session,prepared.requestId,a.assertion(prepared.options!.challenge,{flags:1}))).rejects.toMatchObject({status:401});
    await expect(service.commit(a.session,prepared.requestId,e.assertion(prepared.options!.challenge))).rejects.toMatchObject({status:403});
    const accepted=await service.commit(a.session,prepared.requestId,a.assertion(prepared.options!.challenge));
    service=new AccountConnections(db.sql,encryptor,resolver,passkeys,origin);
    expect((await service.commit(a.session,prepared.requestId)).result).toEqual(accepted.result);
    const personal=(await service.list(a.session)).codes[0]!;expect(personal.expiresAt).toBeNull();
    await expect(create(a,true)).rejects.toMatchObject({status:409});
    const expiring=await create(a,false),bobCode=await create(b,true);
    expect(expiring.id).not.toBe(personal.id);expect((await service.list(a.session)).codes).toHaveLength(2);
    const scan=(link:string)=>Object.fromEntries(new URLSearchParams(new URL(link).hash.slice(1))) as {id:string;did:string;token:string};
    const invitation=scan(expiring.link),opposite=scan(bobCode.link);
    await expect(service.review(b.session,{...invitation,token:encodeBase64Url(randomBytes(32))})).rejects.toMatchObject({status:410});
    await expect(service.review(b.session,{...invitation,did:e.did})).rejects.toMatchObject({status:409});
    expect(await service.review(b.session,invitation)).toMatchObject({did:a.did,address:a.address});
    wrongService=true;await expect(service.review(b.session,invitation)).rejects.toMatchObject({status:409});wrongService=false;
    const crossed=await Promise.all([service.prepare(b.session,{requestId:randomUUID(),action:"connect",...invitation}),service.prepare(a.session,{requestId:randomUUID(),action:"connect",...opposite})]);
    const uncommitted=await service.prepare(b.session,{requestId:randomUUID(),action:"connect",...invitation});
    const results=await Promise.all([service.commit(b.session,crossed[0]!.requestId,b.assertion(crossed[0]!.options!.challenge)),service.commit(a.session,crossed[1]!.requestId,a.assertion(crossed[1]!.options!.challenge))]);
    expect(results[0]!.result).toEqual(results[1]!.result);
    const connections=await db.sql<{id:string;grant_a_cose:Uint8Array;grant_b_cose:Uint8Array}[]>`SELECT id,grant_a_cose,grant_b_cose FROM account_connections WHERE state='active'`;
    expect(connections).toHaveLength(1);expect(await db.sql`SELECT grant_id FROM grant_lineages`).toHaveLength(0);
    const preserve=await db.sql.reserve();try{await preserve.unsafe(await Bun.file(new URL("../migrations/rollback/0066_connection_handover_preparations.sql",import.meta.url)).text());await preserve.unsafe(await Bun.file(new URL("../migrations/rollback/0065_connection_messages.sql",import.meta.url)).text());await preserve.unsafe(await Bun.file(new URL("../migrations/rollback/0064_connection_federation.sql",import.meta.url)).text());await preserve.unsafe(await Bun.file(new URL("../migrations/rollback/0063_connection_owner_signing.sql",import.meta.url)).text());}finally{preserve.release();}
    await db.migrate();
    expect(await db.sql`SELECT id,grant_a_cose,grant_b_cose FROM account_connections WHERE state='active'`).toEqual(connections);
    expect((await service.list(a.session)).connections).toHaveLength(1);expect((await service.list(e.session)).connections).toHaveLength(0);
    for(const row of [connections[0]!.grant_a_cose,connections[0]!.grant_b_cose]){
      const p=inspectSignedPayload("hail.connection-grant",new Uint8Array(row)).payload,owner=users.find(u=>u.did===p.grantor)!;
      expect(p.connection_id).toBe(connections[0]!.id);expect(p.expires_at).toBeNull();
      await verifySignedPayload("hail.connection-grant",new Uint8Array(row),createWebCryptoVerifier(async()=>ed25519PublicKeyFromDidKey(owner.keys.identityDidKey)));
      expect(()=>inspectSignedPayload("hail.grant",new Uint8Array(row))).toThrow();
    }
    const revoke=await service.prepare(a.session,{requestId:randomUUID(),action:"revoke",id:expiring.id});
    await service.commit(a.session,revoke.requestId,a.assertion(revoke.options!.challenge));
    await expect(service.review(e.session,invitation)).rejects.toMatchObject({status:410});
    expect((await service.list(a.session)).connections).toHaveLength(1); // Admission revocation does not end connections.
    const disconnect=await service.prepare(b.session,{requestId:randomUUID(),action:"disconnect",connectionId:connections[0]!.id});
    await service.commit(b.session,disconnect.requestId,b.assertion(disconnect.options!.challenge));
    await expect(service.commit(b.session,uncommitted.requestId,b.assertion(uncommitted.options!.challenge))).rejects.toMatchObject({status:410});
    expect((await service.list(a.session)).connections).toHaveLength(0);
    expect((await service.commit(b.session,crossed[0]!.requestId)).result).toEqual(results[0]!.result);
    await expect(service.prepare(b.session,{requestId:randomUUID(),action:"connect",...scan(personal.link)})).rejects.toMatchObject({status:409});
    await expect(db.sql`UPDATE account_connections SET state='active' WHERE id=${connections[0]!.id}`).rejects.toThrow("cannot be replaced");
    const replace=await service.prepare(a.session,{requestId:randomUUID(),action:"replace",id:personal.id});
    await service.commit(a.session,replace.requestId,a.assertion(replace.options!.challenge));
    await expect(service.review(e.session,scan(personal.link))).rejects.toMatchObject({status:410});
    const next=(await service.list(a.session)).codes.find(code=>code.personal)!;expect(next.id).not.toBe(personal.id);
    const reconnect=await service.prepare(b.session,{requestId:randomUUID(),action:"connect",...scan(next.link)});
    await service.commit(b.session,reconnect.requestId,b.assertion(reconnect.options!.challenge));
    expect((await service.list(a.session)).connections).toHaveLength(1);
    // Owner-held inviter is offline after creating its standing signed invitation.
    const ownerCode=await create(o,true),ownerScan=scan(ownerCode.link);
    const browserPrepare=await call("prepare",{requestId:randomUUID(),action:"create",personal:false,label:"Owner API",expiresAt:Math.floor(Date.now()/1000)+3600},o);
    expect(browserPrepare.status).toBe(200);
    const browserReview=await browserPrepare.json() as Awaited<ReturnType<AccountConnections["prepare"]>>;
    const browserCommit=await call("commit",{requestId:browserReview.requestId,response:o.assertion(browserReview.options!.challenge),cose:encodeBase64Url(await signedOwner(o,browserReview))},o);
    expect(browserCommit.status).toBe(200);
    expect(await db.sql`SELECT role FROM account_keys WHERE account_id=${o.id} AND role='hail-identity'`).toHaveLength(0);
    const managedScan=await service.prepare(e.session,{requestId:randomUUID(),action:"connect",...ownerScan});
    expect(managedScan.ownerSigning).toBeNull();await service.commit(e.session,managedScan.requestId,e.assertion(managedScan.options!.challenge));
    const ownAttempt=await service.prepare(p.session,{requestId:randomUUID(),action:"connect",...ownerScan});
    expect(ownAttempt.ownerSigning?.payload).toMatchObject({type:"hail.connection-confirmation"});
    await expect(db.sql`UPDATE connection_approvals SET owner_payload=${new Uint8Array([1])} WHERE id=${ownAttempt.requestId}`).rejects.toThrow("cannot be replaced");
    await expect(service.commit(p.session,ownAttempt.requestId,p.assertion(ownAttempt.options!.challenge))).rejects.toMatchObject({status:403});
    const valid=await signedOwner(p,ownAttempt),bad=valid.slice();bad[bad.length-1]!^=1;
    await expect(service.commit(p.session,ownAttempt.requestId,p.assertion(ownAttempt.options!.challenge),bad)).rejects.toMatchObject({status:400});
    const confirmation=fromDiagnosticJson("hail.connection-confirmation",ownAttempt.ownerSigning!.payload);
    const changedConsent=await signPayload("hail.connection-confirmation",{...confirmation,expires_at:confirmation.expires_at-1},createWebCryptoSigner(confirmation.key_id,p.keys.identityPrivateKey));
    await expect(service.commit(p.session,ownAttempt.requestId,p.assertion(ownAttempt.options!.challenge),changedConsent)).rejects.toMatchObject({status:400});
    await service.commit(p.session,ownAttempt.requestId,p.assertion(ownAttempt.options!.challenge),valid);
    expect((await service.list(o.session)).connections).toHaveLength(2);
    expect(await db.sql`SELECT id FROM account_connections WHERE consent_format='joint-v1' AND state='active' AND grant_a_cose IS NULL AND grant_b_cose IS NULL`).toHaveLength(2);
    await expect(db.sql`UPDATE account_connections SET consent_format='grants-v1' WHERE id=${(await service.list(p.session)).connections[0]!.id}`).rejects.toThrow("cannot be replaced");
    const ownerDisconnect=await service.prepare(p.session,{requestId:randomUUID(),action:"disconnect",connectionId:(await service.list(p.session)).connections[0]!.id});
    expect(ownerDisconnect.ownerSigning).toBeNull();await service.commit(p.session,ownerDisconnect.requestId,p.assertion(ownerDisconnect.options!.challenge));
    await expect(service.prepare(p.session,{requestId:randomUUID(),action:"connect",...ownerScan})).rejects.toMatchObject({status:409});
    const ownerToManaged=await service.prepare(o.session,{requestId:randomUUID(),action:"connect",...scan(bobCode.link)});
    await service.commit(o.session,ownerToManaged.requestId,o.assertion(ownerToManaged.options!.challenge),await signedOwner(o,ownerToManaged));
    expect((await service.list(o.session)).connections.some(c=>c.did===b.did)).toBe(true);
    const ownerReplace=await service.prepare(o.session,{requestId:randomUUID(),action:"replace",id:ownerCode.id});
    await service.commit(o.session,ownerReplace.requestId,o.assertion(ownerReplace.options!.challenge),await signedOwner(o,ownerReplace));
    await expect(service.review(e.session,ownerScan)).rejects.toMatchObject({status:410});
    const currentOwner=(await service.list(o.session)).codes[0]!,currentOwnerScan=scan(currentOwner.link);
    // Two-provider review boundary: destination fetches only the PLC-resolved source endpoint.
    const targets:string[]=[];
    const remote=new RemoteConnectionReview(db.sql,resolver,async request=>app.request(request),url=>{targets.push(url.toString());},"https://destination.example.com/hail");
    expect(await remote.review(currentOwnerScan)).toMatchObject({address:o.address,did:o.did,admissionSupported:false});
    expect(targets).toEqual([origin+"/hail/connections/invitations/review"]);
    const exported=await service.exportInvitation(currentOwnerScan);
    const changed=exported.binding.slice(0,-1)+(exported.binding.endsWith("A")?"B":"A");
    const forged=new RemoteConnectionReview(db.sql,resolver,async()=>Response.json({...exported,binding:changed}),()=>{},"https://destination.example.com/hail");
    await expect(forged.review(currentOwnerScan)).rejects.toThrow();
    const redirect=new RemoteConnectionReview(db.sql,resolver,async()=>new Response(null,{status:302,headers:{Location:"https://evil.example"}}),()=>{},"https://destination.example.com/hail");
    await expect(redirect.review(currentOwnerScan)).rejects.toThrow("supported connection response");
    const ownerRollback=await db.sql.reserve();try{await expect(ownerRollback.unsafe(await Bun.file(new URL("../migrations/rollback/0063_connection_owner_signing.sql",import.meta.url)).text())).rejects.toThrow("Retained owner connection consent");}finally{await ownerRollback.unsafe("ROLLBACK");ownerRollback.release();}
    const expiringSoon=await create(e,false,Math.floor(Date.now()/1000)+3);
    const late=await service.prepare(a.session,{requestId:randomUUID(),action:"connect",...scan(expiringSoon.link)});
    await Bun.sleep(3100);
    await expect(service.review(a.session,scan(expiringSoon.link))).rejects.toMatchObject({status:410});
    await expect(service.commit(a.session,late.requestId,a.assertion(late.options!.challenge))).rejects.toMatchObject({status:410});
    expect((await service.list(a.session)).connections).toHaveLength(1);
    const secret=await encryptor.encryptConnectionToken(a.id,personal.id,new Uint8Array(32));
    await expect(encryptor.decryptConnectionToken(b.id,personal.id,secret)).rejects.toThrow();
    await expect(encryptor.decryptConnectionToken(a.id,next.id,secret)).rejects.toThrow();
    const fence=()=>db.sql`INSERT INTO provider_migration_fences(did,account_id,transfer_id,destination_service_base,state)
      VALUES(${a.did},${a.id},${randomUUID()},'https://destination.example.com/hail','fenced')`;
    await expect(fence()).rejects.toThrow("not portable");
    await expect(db.sql.begin(async tx=>{await tx`SELECT set_config('hail.returning_account',${a.id},true)`;await tx`UPDATE account_serving_generations SET generation=generation+1 WHERE account_id=${a.id}`;})).rejects.toThrow("not portable");
    await expect(db.sql`UPDATE connection_invitations SET label='changed' WHERE id=${next.id}`).rejects.toThrow("cannot be replaced");
    const rollback=await db.sql.reserve();try{await expect(rollback.unsafe(await Bun.file(new URL("../migrations/rollback/0062_connection_preview.sql",import.meta.url)).text())).rejects.toThrow("prevents schema rollback");}finally{await rollback.unsafe("ROLLBACK");rollback.release();}
    await db.sql`UPDATE account_passkeys SET revoked_at=now() WHERE credential_id=${a.credential}`;
    await expect(service.list(a.session)).rejects.toMatchObject({status:403});
  }finally{await db.close();await admin.unsafe(`DROP SCHEMA "${schema}" CASCADE`);await admin.close();}
},60_000);
