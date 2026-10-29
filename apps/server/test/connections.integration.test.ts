import {createHash,generateKeyPairSync,randomBytes,randomUUID,sign} from "node:crypto";
import {SQL} from "bun";
import {Hono} from "hono";
import {expect,it,vi} from "vitest";
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
import {readdir} from "node:fs/promises";

it.skipIf(!process.env.DATABASE_URL)("manages personal and expiring QR invitations, converges crossed consent and preserves terminal history",async()=>{
  const admin=new SQL(process.env.DATABASE_URL!),schema="connections_"+randomUUID().replaceAll("-","");
  await admin.unsafe(`CREATE SCHEMA "${schema}"`);const url=new URL(process.env.DATABASE_URL!);url.searchParams.set("options",`-csearch_path=${schema}`);
  const db=new ProviderDatabase(url.toString()),origin="https://provider.example.com",encryptor=new KeyEncryptor(encodeBase64Url(randomBytes(32)));
  const users=[] as {id:string;did:string;address:string;keys:Awaited<ReturnType<typeof generateAccountKeys>>;credential:string;token:string;session:AccountApiSession;
    assertion:(challenge:string,change?:{origin?:string;flags?:number})=>any}[];
  // Exercise historical rollback at its original schema boundary. Later
  // migrations (including 77, which has no rollback) must not be discarded to
  // run the preview/unified-connection downgrade checks.
  const historical=async()=>{
    await db.sql`CREATE TABLE IF NOT EXISTS schema_migrations(version integer PRIMARY KEY,name text NOT NULL,checksum text NOT NULL,applied_at timestamptz NOT NULL DEFAULT now())`;
    for(const file of (await readdir(new URL('../migrations/',import.meta.url))).filter(name=>/^\d{4}_.*\.sql$/.test(name)&&Number(name.slice(0,4))<=76).sort()){
      const version=Number(file.slice(0,4));if((await db.sql`SELECT version FROM schema_migrations WHERE version=${version}`).length)continue;
      const source=await Bun.file(new URL('../migrations/'+file,import.meta.url)).text();
      await db.sql.begin(async tx=>{await tx.unsafe(source);await tx`INSERT INTO schema_migrations(version,name,checksum) VALUES(${version},${file.slice(5,-4)},${createHash('sha256').update(source).digest('hex')})`;});
    }
  };
  try{
    await historical();
    const empty=await db.sql.reserve();try{for(const file of ['0076_message_trash','0075_connection_custody','0074_provider_operator','0073_signup_recovery_package','0072_retired_connection_peers','0071_connection_transfer_orchestration','0070_unified_connections','0069_connection_reconstruction','0068_connection_handover_barriers','0067_connection_proof_authority','0066_connection_handover_preparations','0065_connection_messages','0064_connection_federation','0063_connection_owner_signing','0062_connection_preview'])
      await empty.unsafe(await Bun.file(new URL('../migrations/rollback/'+file+'.sql',import.meta.url)).text());}finally{empty.release();}
    await historical();
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
    // Upgrade preserves obsolete bytes without authorizing them or allowing an
    // old writer/replayed invitation to recreate the relationship in either model.
    const beforeUnified=await db.sql.reserve();try{for(const file of ['0076_message_trash','0075_connection_custody','0074_provider_operator','0073_signup_recovery_package','0072_retired_connection_peers','0071_connection_transfer_orchestration','0070_unified_connections'])await beforeUnified.unsafe(await Bun.file(new URL('../migrations/rollback/'+file+'.sql',import.meta.url)).text());}finally{beforeUnified.release();}
    const obsoleteId=randomUUID();
    await db.sql`INSERT INTO account_connections(id,account_a,account_b,did_a,did_b,generation_a,generation_b,grant_id_a,grant_id_b,consent_format)
      VALUES(${obsoleteId},${e.id},${p.id},${e.did},${p.did},1,1,${randomUUID()},${randomUUID()},'joint-v1')`;
    const obsolete=await db.sql`SELECT * FROM account_connections WHERE id=${obsoleteId}`;
    await db.migrate();
    expect(await db.sql`SELECT * FROM account_connections WHERE id=${obsoleteId}`).toEqual(obsolete);
    await expect(db.sql`UPDATE account_connections SET pending_until=now() WHERE id=${obsoleteId}`).rejects.toThrow('Obsolete local connection');
    await expect(db.sql`INSERT INTO federated_connection_pairs(id,account_id,serving_generation,local_did,peer_did,peer_address,peer_service_base,coordinator_service_base)
      VALUES(${randomUUID()},${e.id},1,${e.did},${p.did},${p.address},${origin+'/hail'},${origin+'/hail'})`).rejects.toThrow('Obsolete local connection history blocks this pair');
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
    const oldApprovals=await db.sql`SELECT to_jsonb(a)-'api_credential_id' AS value FROM connection_approvals a ORDER BY id`;
    const expand=await db.sql.reserve();try{await expand.unsafe(await Bun.file(new URL('../migrations/rollback/0083_connection_cli_approvals.sql',import.meta.url)).text());}finally{expand.release();}
    await db.migrate();
    expect(await db.sql`SELECT to_jsonb(a)-'api_credential_id' AS value FROM connection_approvals a ORDER BY id`).toEqual(oldApprovals);
    service=new AccountConnections(db.sql,encryptor,resolver,passkeys,origin);
    expect((await service.commit(a.session,prepared.requestId)).result).toEqual(accepted.result);
    const personal=(await service.list(a.session)).codes[0]!;expect(personal.expiresAt).toBeNull();
    await expect(create(a,true)).rejects.toMatchObject({status:409});
    const expiring=await create(a,false),bobCode=await create(b,true);
    expect(expiring.id).not.toBe(personal.id);expect((await service.list(a.session)).codes).toHaveLength(2);
    const scan=(link:string)=>Object.fromEntries(new URLSearchParams(new URL(link).hash.slice(1))) as {id:string;did:string;token:string};
    const drain=async()=>{for(let i=0;i<30&&await service.federation.workOne();i++);};
    const invitation=scan(expiring.link),opposite=scan(bobCode.link);
    await expect(service.review(b.session,{...invitation,token:encodeBase64Url(randomBytes(32))})).rejects.toMatchObject({status:410});
    await expect(service.review(b.session,{...invitation,did:e.did})).rejects.toMatchObject({status:409});
    expect(await service.review(b.session,invitation)).toMatchObject({did:a.did,address:a.address});
    wrongService=true;await expect(service.review(b.session,invitation)).rejects.toMatchObject({status:409});wrongService=false;
    const crossed=await Promise.all([service.prepare(b.session,{requestId:randomUUID(),action:"connect",...invitation}),service.prepare(a.session,{requestId:randomUUID(),action:"connect",...opposite})]);
    const uncommitted=await service.prepare(b.session,{requestId:randomUUID(),action:"connect",...invitation});
    const results=await Promise.all([service.commit(b.session,crossed[0]!.requestId,b.assertion(crossed[0]!.options!.challenge)),service.commit(a.session,crossed[1]!.requestId,a.assertion(crossed[1]!.options!.challenge))]);
    expect(results.every(r=>(r.result as {state:string}).state==='connecting')).toBe(true);
    await drain();
    const connections=await db.sql<{id:string}[]>`SELECT DISTINCT connection_id AS id FROM federated_connection_pairs WHERE state='active'`;
    expect(connections).toHaveLength(1);expect(await db.sql`SELECT grant_id FROM grant_lineages`).toHaveLength(0);
    expect(await db.sql`SELECT id FROM account_connections WHERE id<>${obsoleteId}`).toHaveLength(0);
    const preserve=await db.sql.reserve();try{await expect(preserve.unsafe(await Bun.file(new URL('../migrations/rollback/0070_unified_connections.sql',import.meta.url)).text())).rejects.toThrow('Retained unified local connections');}finally{await preserve.unsafe('ROLLBACK');preserve.release();}
    expect((await service.list(a.session)).connections).toHaveLength(1);expect((await service.list(e.session)).connections).toHaveLength(0);
    const copies=await db.sql<{id:string;count:number}[]>`SELECT id,count(*)::integer AS count FROM federated_connection_attempts GROUP BY id`;
    expect(copies).toHaveLength(2);expect(copies.every(r=>r.count===2)).toBe(true);
    const revoke=await service.prepare(a.session,{requestId:randomUUID(),action:"revoke",id:expiring.id});
    await service.commit(a.session,revoke.requestId,a.assertion(revoke.options!.challenge));
    await expect(service.review(e.session,invitation)).rejects.toMatchObject({status:410});
    expect((await service.list(a.session)).connections).toHaveLength(1); // Admission revocation does not end connections.
    const disconnect=await service.prepare(b.session,{requestId:randomUUID(),action:"disconnect",connectionId:connections[0]!.id});
    await service.commit(b.session,disconnect.requestId,b.assertion(disconnect.options!.challenge));
    expect((await db.sql<{allowed:boolean}[]>`SELECT hail_connection_message_permission(${a.did},${b.did},${connections[0]!.id},1) AS allowed`)[0]!.allowed).toBe(false);
    expect((await db.sql<{allowed:boolean}[]>`SELECT hail_connection_message_permission(${b.did},${a.did},${connections[0]!.id},1) AS allowed`)[0]!.allowed).toBe(false);
    await service.commit(b.session,uncommitted.requestId,b.assertion(uncommitted.options!.challenge));await drain();
    expect((await service.list(a.session)).connections).toHaveLength(0);
    expect((await service.commit(b.session,crossed[0]!.requestId)).result).toMatchObject({connectionId:connections[0]!.id});
    const stale=await service.prepare(b.session,{requestId:randomUUID(),action:'connect',...scan(personal.link)});
    await service.commit(b.session,stale.requestId,b.assertion(stale.options!.challenge));await drain();
    expect((await service.status(b.session,stale.requestId)).result).toMatchObject({state:'conflict'});
    await expect(db.sql`UPDATE federated_connection_pairs SET state='active' WHERE account_id=${a.id} AND peer_did=${b.did}`).rejects.toThrow("cannot be reopened");
    const replace=await service.prepare(a.session,{requestId:randomUUID(),action:"replace",id:personal.id});
    await service.commit(a.session,replace.requestId,a.assertion(replace.options!.challenge));
    await expect(service.review(e.session,scan(personal.link))).rejects.toMatchObject({status:410});
    const next=(await service.list(a.session)).codes.find(code=>code.personal)!;expect(next.id).not.toBe(personal.id);
    const reconnect=await service.prepare(b.session,{requestId:randomUUID(),action:"connect",...scan(next.link)});
    await service.commit(b.session,reconnect.requestId,b.assertion(reconnect.options!.challenge));
    await drain();
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
    await drain();
    expect((await service.list(o.session)).connections).toHaveLength(2);
    expect(await db.sql`SELECT id FROM federated_connection_pairs WHERE peer_did=${o.did} AND state='active'`).toHaveLength(2);
    await expect(db.sql`UPDATE federated_connection_pairs SET peer_did=${a.did} WHERE account_id=${p.id}`).rejects.toThrow("cannot be replaced");
    const connectionId=(await service.list(p.session)).connections[0]!.id;
    const credential=await accounts.issue(p.address,false,undefined,["account:read","account:write"]);
    const readonly=await accounts.issue(p.address,false,undefined,["account:read"]);
    const stranger=await accounts.issue(e.address,false,undefined,["account:write"]);
    const cli=(token:string,step="cli-remove",body:unknown={connectionId})=>app.request(origin+"/api/v1/account/connections/"+step,{
      method:step==="cli-list"?"GET":"POST",headers:{Authorization:"Bearer "+token,"Content-Type":"application/json"},
      ...(step==="cli-list"?{}:{body:JSON.stringify(body)})});
    const listing=await (await cli(credential.token,"cli-list")).json();
    expect(listing.connections.map((c:any)=>c.id)).toContain(connectionId);expect(listing.codes).toBeUndefined();
    expect((await cli(readonly.token)).status).toBe(403);
    expect((await cli(stranger.token)).status).toBe(404);
    expect((await cli(credential.token,"cli-remove",{connectionId:"invalid"})).status).toBe(400);
    expect((await cli(credential.token)).status).toBe(200);
    expect((await cli(credential.token)).status).toBe(200); // Exact retry is harmless.
    expect((await service.list(p.session)).connections).toHaveLength(0);
    await accounts.revoke(credential.credentialId);
    expect((await cli(credential.token)).status).toBe(401);
    await drain();
    const staleOwner=await service.prepare(p.session,{requestId:randomUUID(),action:'connect',...ownerScan});
    await service.commit(p.session,staleOwner.requestId,p.assertion(staleOwner.options!.challenge),await signedOwner(p,staleOwner));await drain();
    expect((await service.status(p.session,staleOwner.requestId)).result).toMatchObject({state:'conflict'});
    const ownerToManaged=await service.prepare(o.session,{requestId:randomUUID(),action:"connect",...scan(bobCode.link)});
    await service.commit(o.session,ownerToManaged.requestId,o.assertion(ownerToManaged.options!.challenge),await signedOwner(o,ownerToManaged));
    await drain();
    expect((await service.list(o.session)).connections.some(c=>c.did===b.did)).toBe(true);
    const ownerReplace=await service.prepare(o.session,{requestId:randomUUID(),action:"replace",id:ownerCode.id});
    await service.commit(o.session,ownerReplace.requestId,o.assertion(ownerReplace.options!.challenge),await signedOwner(o,ownerReplace));
    await expect(service.review(e.session,ownerScan)).rejects.toMatchObject({status:410});
    const currentOwner=(await service.list(o.session)).codes[0]!,currentOwnerScan=scan(currentOwner.link);
    // Two-provider review boundary: destination fetches only the PLC-resolved source endpoint.
    const targets:string[]=[];
    const remote=new RemoteConnectionReview(db.sql,resolver,async request=>app.request(request),url=>{targets.push(url.toString());},"https://destination.example.com/hail");
    expect(await remote.review(currentOwnerScan)).toMatchObject({address:o.address,did:o.did,admissionSupported:true});
    expect(targets).toEqual([origin+"/hail/connections/invitations/review"]);
    const exported=await service.exportInvitation(currentOwnerScan);
    const changed=exported.binding.slice(0,-1)+(exported.binding.endsWith("A")?"B":"A");
    const forged=new RemoteConnectionReview(db.sql,resolver,async()=>Response.json({...exported,binding:changed}),()=>{},"https://destination.example.com/hail");
    await expect(forged.review(currentOwnerScan)).rejects.toThrow();
    const redirect=new RemoteConnectionReview(db.sql,resolver,async()=>new Response(null,{status:302,headers:{Location:"https://evil.example"}}),()=>{},"https://destination.example.com/hail");
    await expect(redirect.review(currentOwnerScan)).rejects.toThrow("supported connection response");
    const ownerRollback=await db.sql.reserve();try{await expect(ownerRollback.unsafe(await Bun.file(new URL("../migrations/rollback/0063_connection_owner_signing.sql",import.meta.url)).text())).rejects.toThrow("Retained owner connection consent");}finally{await ownerRollback.unsafe("ROLLBACK");ownerRollback.release();}
    // Batch removal is one exact passkey action and locally all-or-nothing.
    const third=await service.prepare(e.session,{requestId:randomUUID(),action:"connect",...scan(bobCode.link)});
    await service.commit(e.session,third.requestId,e.assertion(third.options!.challenge));await drain();
    const batchConnections=(await service.list(b.session)).connections;
    expect(batchConnections).toHaveLength(3);
    const batchInput={requestId:randomUUID(),action:"disconnect",connectionIds:batchConnections.map(c=>c.id)};
    const batch=await service.prepare(b.session,batchInput);
    expect(batch.action).toBe("disconnect-batch");
    expect(await service.prepare(b.session,batchInput)).toEqual(batch);
    await expect(service.prepare(b.session,{...batchInput,connectionIds:batchInput.connectionIds.slice(0,1)})).rejects.toMatchObject({status:409});
    await expect(service.prepare(b.session,{...batchInput,requestId:randomUUID(),connectionIds:[batchInput.connectionIds[0],batchInput.connectionIds[0]]})).rejects.toMatchObject({status:400});
    await expect(service.status(a.session,batch.requestId)).rejects.toMatchObject({status:404});
    await expect(service.commit(b.session,batch.requestId)).rejects.toMatchObject({status:403});
    await expect(service.commit(b.session,batch.requestId,b.assertion(disconnect.options!.challenge))).rejects.toMatchObject({status:401});
    const items=batch.review.connections as {connectionId:string;pairId:string}[];
    const last=[...items].sort((a,b)=>a.pairId.localeCompare(b.pairId)).at(-1)!;
    const separate=await service.prepare(b.session,{requestId:randomUUID(),action:"disconnect",connectionId:last.connectionId});
    await service.commit(b.session,separate.requestId,b.assertion(separate.options!.challenge));
    await expect(service.commit(b.session,batch.requestId,b.assertion(batch.options!.challenge))).rejects.toMatchObject({status:409});
    const remaining=(await service.list(b.session)).connections;
    expect(remaining).toHaveLength(2); // Earlier members rolled back with the conflict.
    const retry=await service.prepare(b.session,{requestId:randomUUID(),action:"disconnect",connectionIds:remaining.map(c=>c.id)});
    const verify=vi.spyOn(passkeys,"approveAction");
    const removed=await service.commit(b.session,retry.requestId,b.assertion(retry.options!.challenge));
    expect(verify).toHaveBeenCalledTimes(1);verify.mockRestore();
    expect(removed.result).toMatchObject({connectionIds:remaining.map(c=>c.id),state:"disconnected"});
    expect((await service.commit(b.session,retry.requestId)).result).toEqual(removed.result);
    expect((await service.list(b.session)).connections).toHaveLength(0);
    await drain();
    const expiringSoon=await create(e,false,Math.floor(Date.now()/1000)+3);
    const late=await service.prepare(a.session,{requestId:randomUUID(),action:"connect",...scan(expiringSoon.link)});
    await Bun.sleep(3100);
    await expect(service.review(a.session,scan(expiringSoon.link))).rejects.toMatchObject({status:410});
    await expect(service.commit(a.session,late.requestId,a.assertion(late.options!.challenge))).rejects.toMatchObject({status:410});
    expect((await service.list(a.session)).connections).toHaveLength(0);
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
    // Bearer access is a distinct owner-signature channel; browser passkeys and
    // managed signing are never synthesized or bypassed by a credential.
    const ownerAccess=await accounts.issue(o.address,false,undefined,["account:read","account:write"]);
    const otherAccess=await accounts.issue(o.address,false,undefined,["account:read","account:write"]);
    const readAccess=await accounts.issue(o.address,false,undefined,["account:read"]);
    const managedAccess=await accounts.issue(b.address,false,undefined,["account:read","account:write"]);
    const ownerSession=(await accounts.authenticate("Bearer "+ownerAccess.token))!;
    const ownerInput={requestId:randomUUID(),action:"create",personal:false,label:"CLI consent",expiresAt:Math.floor(Date.now()/1000)+3600};
    expect((await cli(readAccess.token,"cli-prepare",ownerInput)).status).toBe(403);
    expect((await cli(managedAccess.token,"cli-prepare",ownerInput)).status).toBe(403);
    expect((await cli(ownerAccess.token,"prepare",ownerInput)).status).toBe(403);
    expect((await cli(ownerAccess.token,"cli-prepare",{requestId:randomUUID(),action:"revoke",id:currentOwner.id})).status).toBe(403);
    const ownerPrepared=await service.prepare(ownerSession,ownerInput);
    expect(ownerPrepared.options).toBeNull();
    await expect(service.commit(ownerSession,ownerPrepared.requestId)).rejects.toMatchObject({status:403});
    await expect(service.status((await accounts.authenticate("Bearer "+otherAccess.token))!,ownerPrepared.requestId)).rejects.toMatchObject({status:404});
    await expect(service.status(o.session,ownerPrepared.requestId)).rejects.toMatchObject({status:404});
    const ownerSigned=await signedOwner(o,ownerPrepared),broken=Uint8Array.from(ownerSigned);broken[broken.length-1]=broken[broken.length-1]!^1;
    expect((await cli(ownerAccess.token,"cli-commit",{requestId:ownerPrepared.requestId,cose:encodeBase64Url(broken)})).status).toBe(400);
    const committedOwner=await service.commit(ownerSession,ownerPrepared.requestId,undefined,ownerSigned);
    expect(committedOwner.invitation).toMatchObject({did:o.did,type:"hailp.connection-invitation"});
    expect((await service.commit(ownerSession,ownerPrepared.requestId)).result).toEqual(committedOwner.result);
    const refusal=await db.sql.reserve();try{await expect(refusal.unsafe(await Bun.file(new URL('../migrations/rollback/0083_connection_cli_approvals.sql',import.meta.url)).text())).rejects.toThrow('Retained CLI');}finally{await refusal.unsafe('ROLLBACK');refusal.release();}
    await accounts.revoke(ownerAccess.credentialId);
    await expect(service.status(ownerSession,ownerPrepared.requestId)).rejects.toMatchObject({status:403});
  }finally{await db.close();await admin.unsafe(`DROP SCHEMA "${schema}" CASCADE`);await admin.close();}
},60_000);
