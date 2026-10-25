import {createHash,generateKeyPairSync,randomBytes,randomUUID,sign} from "node:crypto";
import {SQL} from "bun";
import {Hono} from "hono";
import {expect,it} from "vitest";
import {P256Keypair} from "@atproto/crypto";
import {createWebCryptoSigner,decodeBase64Url,encodeBase64Url,fromDiagnosticJson,inspectSignedPayload,signPayload} from "@hailproto/codec";
import {ProviderDatabase} from "../src/db/database.js";
import {AccountConnections} from "../src/accounts/connections.js";
import {RemoteConnectionReview} from "../src/accounts/connection-review.js";
import {registerConnectionRoutes} from "../src/accounts/connection-routes.js";
import {AccountApiRepository,type AccountApiSession} from "../src/accounts/repository.js";
import {PasskeyAuth} from "../src/accounts/passkeys.js";
import {KeyEncryptor} from "../src/identity/key-encryption.js";
import {generateAccountKeys} from "../src/identity/keys.js";
import {importEd25519PrivateKey} from "../src/identity/keys.js";
import type {HailDidResolver} from "../src/plc/resolver.js";
import {withFreshServingGenerations} from "../src/db/serving.js";

it.skipIf(!process.env.DATABASE_URL)("federates independent providers with owner signatures, crossed scans, durable retries and terminal epoch precedence",async()=>{
  const admin=new SQL(process.env.DATABASE_URL!),users=[] as User[],providers=[] as Provider[];
  type User={id:string;did:string;address:string;managed:boolean;keys:Awaited<ReturnType<typeof generateAccountKeys>>;session:AccountApiSession;token:string;
    assertion:(challenge:string)=>any;provider:Provider};
  type Provider={schema:string;db:ProviderDatabase;origin:string;app:Hono;service:AccountConnections;accounts:AccountApiRepository;passkeys:PasskeyAuth;encryptor:KeyEncryptor};
  const evidence={document:{},data:{},log:[]};
  const resolver:HailDidResolver={async resolve(did){const user=users.find(u=>u.did===did);if(!user)throw new Error("Unknown fixture DID");return {did,
    identityDidKey:user.keys.identityDidKey,messagingDidKey:user.keys.messagingDidKey,serviceBase:user.provider.origin+"/hail",evidence};}};
  let lostCommit=0,lostDisconnect=0,lostSync=0,holdActive=false,holdClosed=false,loseAdmission=0;
  const requests:{target:Provider;path:string;wire:Record<string,unknown>;status:number}[]=[],delayed:{target:Provider;wire:Record<string,unknown>}[]=[];
  const network=async(request:Request)=>{
    const url=new URL(request.url),target=providers.find(p=>p.origin===url.origin);if(!target)throw new Error("Unapproved fixture target");
    expect(request.headers.has("cookie")).toBe(false);expect(request.headers.has("authorization")).toBe(false);expect(request.headers.has("origin")).toBe(false);
    const wire=JSON.parse(await request.clone().text()),path=url.pathname;
    if(path.endsWith("/sync")){
      const state=inspectSignedPayload("hail.connection-control",decodeBase64Url(wire.control)).payload.state;
      if(holdActive&&state==="active"||holdClosed&&state==="disconnected"){delayed.push({target,wire});throw new Error("Offline destination before state delivery");}
    }
    // A real HTTP process does not inherit the caller's generation-admission context.
    const response=await withFreshServingGenerations(target.db.sql,()=>target.app.request(request));requests.push({target,path,wire,status:response.status});
    if(response.ok&&path.endsWith("/commit")&&lostCommit){lostCommit--;throw new Error("Lost committed connection reply");}
    if(response.ok&&path.endsWith("/disconnect")&&lostDisconnect){lostDisconnect--;throw new Error("Lost disconnected reply");}
    if(response.ok&&path.endsWith("/sync")&&lostSync){lostSync--;throw new Error("Lost applied sync reply");}
    if(response.ok&&path.endsWith("/admit")&&loseAdmission){loseAdmission--;throw new Error("Lost durable admission reply");}
    return response;
  };
  try{
    for(const name of ["first","second"]){
      const schema="federation_"+name+"_"+randomUUID().replaceAll("-","");await admin.unsafe(`CREATE SCHEMA "${schema}"`);
      const url=new URL(process.env.DATABASE_URL!);url.searchParams.set("options",`-csearch_path=${schema}`);
      const db=new ProviderDatabase(url.toString()),origin=`https://${name}.example.com`,encryptor=new KeyEncryptor(encodeBase64Url(randomBytes(32)));
      const accounts=new AccountApiRepository(db.sql),passkeys=new PasskeyAuth(db.sql,`${name}.example.com`,origin),app=new Hono();
      const remote=new RemoteConnectionReview(db.sql,resolver,network,url=>{if(!providers.some(p=>p.origin===url.origin))throw new Error("Unexpected destination");},origin+"/hail");
      const service=new AccountConnections(db.sql,encryptor,resolver,passkeys,origin,remote);
      const provider={schema,db,origin,encryptor,accounts,passkeys,app,service};providers.push(provider);await db.migrate();
      const rollback=await db.sql.reserve();try{await rollback.unsafe(await Bun.file(new URL("../migrations/rollback/0064_connection_federation.sql",import.meta.url)).text());}finally{rollback.release();}
      await db.migrate();registerConnectionRoutes(app,service,accounts,origin);
    }
    const addUser=async(provider:Provider,letter:string,managed:boolean)=>{
      const id=randomUUID(),did="did:plc:"+letter.repeat(24),address=letter+"@"+new URL(provider.origin).hostname,keys=await generateAccountKeys(id,provider.encryptor),sql=provider.db.sql;
      await sql`INSERT INTO provider_accounts(id,tenant_id,canonical_address,did,onboarding_state,activated_at,activation_binding_digest,activation_verification_mode)
        VALUES(${id},${randomUUID()},${address},${did},'active',now(),${randomBytes(32)},'public')`;
      for(const key of keys.keys.filter(k=>managed||k.role!=="hail-identity"))await sql`INSERT INTO account_keys(account_id,role,algorithm,public_key,encrypted_private_key,encryption_nonce,encryption_version,kek_id)
        VALUES(${id},${key.role},${key.algorithm},${key.publicKey},${key.ciphertext},${key.nonce},1,'poc-v1')`;
      if(managed)await sql`INSERT INTO managed_custody_evidence(account_id,owner_recovery_public_key,provider_identity_public_key,verification_mode,managed_profile_version)
        VALUES(${id},${(await P256Keypair.create()).did()},${keys.identityDidKey},'reduced-assurance-alpha-v1','hail-managed-custody-v1')`;
      else await sql`INSERT INTO portable_custody_evidence(account_id,user_recovery_public_key,user_identity_public_key,monitor_origin,monitor_confirmed_at,backup_confirmed_at,monitor_verification_mode)
        VALUES(${id},${(await P256Keypair.create()).did()},${keys.identityDidKey},'https://monitor.example.com',now(),now(),'poc-local')`;
      const pair=generateKeyPairSync("ec",{namedCurve:"prime256v1"}),jwk=pair.publicKey.export({format:"jwk"}),credential=encodeBase64Url(randomBytes(32));
      const cose=Buffer.concat([Buffer.from("a5010203262001215820","hex"),Buffer.from(jwk.x!,"base64url"),Buffer.from("225820","hex"),Buffer.from(jwk.y!,"base64url")]);
      await sql`INSERT INTO account_passkeys(credential_id,account_id,serving_generation,public_key,device_type,backed_up,label)
        VALUES(${credential},${id},1,${cose},'singleDevice',false,'Federation proof')`;
      let count=0;const assertion=(challenge:string)=>{
        const client=Buffer.from(JSON.stringify({type:"webauthn.get",challenge,origin:provider.origin})),auth=Buffer.alloc(37);
        createHash("sha256").update(new URL(provider.origin).hostname).digest().copy(auth);auth[32]=5;auth.writeUInt32BE(++count,33);
        return {id:credential,rawId:credential,type:"public-key" as const,clientExtensionResults:{},response:{clientDataJSON:client.toString("base64url"),authenticatorData:auth.toString("base64url"),
          signature:sign("sha256",Buffer.concat([auth,createHash("sha256").update(client).digest()]),pair.privateKey).toString("base64url"),userHandle:Buffer.from(id.replaceAll("-",""),"hex").toString("base64url")}};
      };
      const login=await provider.passkeys.authenticationOptions(),logged=await provider.passkeys.authenticate(login.challengeId,assertion(login.options.challenge));
      const session=(await provider.accounts.authenticate(undefined,logged.token))!,n=Math.floor(Date.now()/1000);
      const binding=await signPayload("hail.address-binding",{type:"hail.address-binding",version:1,did,address,issued_at:n-10,expires_at:n+86400,key_id:did+"#hail-identity"},createWebCryptoSigner(did+"#hail-identity",keys.identityPrivateKey));
      await sql`INSERT INTO address_bindings(id,account_id,canonical_address,did,cose,representation_digest,issued_at,expires_at,selected_at,published_at,hosted_at)
        VALUES(${randomUUID()},${id},${address},${did},${binding},${new Uint8Array(createHash("sha256").update(binding).digest())},${new Date((n-10)*1000)},${new Date((n+86400)*1000)},now(),now(),now())`;
      const user={id,did,address,managed,keys,session,token:logged.token,assertion,provider};users.push(user);return user;
    };
    const [first,second]=providers as [Provider,Provider];
    const a=await addUser(first,"a",false),b=await addUser(second,"b",true),c=await addUser(first,"c",true),d=await addUser(second,"d",false);
    const commit=async(user:User,review:Awaited<ReturnType<AccountConnections["prepare"]>>)=>{
      let external:Uint8Array|undefined;
      if(review.ownerSigning){const type=(review.ownerSigning.payload as {type:string}).type;
        if(type!=="hail.connection-invitation"&&type!=="hail.connection-confirmation")throw new Error("Unexpected owner consent");
        external=await signPayload(type,fromDiagnosticJson(type,review.ownerSigning.payload),createWebCryptoSigner(user.did+"#hail-identity",user.keys.identityPrivateKey));}
      return user.provider.service.commit(user.session,review.requestId,user.assertion(review.options!.challenge),external);
    };
    const create=async(user:User)=>{const p=await user.provider.service.prepare(user.session,{requestId:randomUUID(),action:"create",personal:true,label:"Personal",expiresAt:null});await commit(user,p);return (await user.provider.service.list(user.session)).codes.find(v=>v.personal)!;};
    const code=(link:string)=>Object.fromEntries(new URLSearchParams(new URL(link).hash.slice(1))) as {id:string;did:string;token:string};
    const prepare=(user:User,link:string)=>user.provider.service.prepare(user.session,{requestId:randomUUID(),action:"connect",...code(link)});
    const forceDue=async()=>{for(const p of providers){await p.db.sql`UPDATE federated_connection_attempts SET next_attempt_at=now() WHERE state='pending'`;await p.db.sql`UPDATE federated_connection_disconnects SET next_attempt_at=now() WHERE result_cose IS NULL`;await p.db.sql`UPDATE federated_connection_outbox SET next_attempt_at=now() WHERE ack_cose IS NULL`;}};
    const drain=async(rounds=10)=>{for(let i=0;i<rounds;i++){await forceDue();for(const p of providers)await withFreshServingGenerations(p.db.sql,()=>p.service.federation!.workOne());}};
    const active=async(user:User)=>(await user.provider.service.list(user.session)).connections;
    const ac=await create(a),bc=await create(b);
    expect(await second.service.review(b.session,code(ac.link))).toMatchObject({did:a.did,address:a.address,admissionSupported:true});
    const [ap,bp]=await Promise.all([prepare(a,bc.link),prepare(b,ac.link)]);
    expect(ap.ownerSigning).not.toBeNull();expect(bp.ownerSigning).toBeNull();
    const accepted=await Promise.all([commit(a,ap),commit(b,bp)]);expect(accepted.every(r=>(r.result as {state:string}).state==="connecting")).toBe(true);
    expect(await active(a)).toHaveLength(0);expect(await active(b)).toHaveLength(0);
    loseAdmission=1;lostCommit=1;lostSync=1;
    await drain(1);
    const retained=await Promise.all(providers.map(p=>p.db.sql<{id:string;bundle:Uint8Array}[]>`SELECT id,bundle FROM federated_connection_attempts WHERE direction='outbound' ORDER BY id`));
    // Restart both application instances while work and ambiguous replies are retained.
    for(const p of providers){p.app=new Hono();p.service=new AccountConnections(p.db.sql,p.encryptor,resolver,p.passkeys,p.origin,
      new RemoteConnectionReview(p.db.sql,resolver,network,url=>{if(!providers.some(p=>p.origin===url.origin))throw new Error("Unexpected destination");},p.origin+"/hail"));registerConnectionRoutes(p.app,p.service,p.accounts,p.origin);}
    await drain(15);
    for(const [i,p] of providers.entries())expect(await p.db.sql`SELECT id,bundle FROM federated_connection_attempts WHERE direction='outbound' ORDER BY id`).toEqual(retained[i]);
    const aa=await active(a),ba=await active(b);
    expect(aa,JSON.stringify(requests.filter(r=>r.status!==200).map(r=>[r.path,r.status]))).toHaveLength(1);expect(ba).toHaveLength(1);expect(aa[0]!.id).toBe(ba[0]!.id);
    const oldId=aa[0]!.id;
    expect(await first.db.sql`SELECT id FROM federated_connection_events WHERE state='active'`).toHaveLength(1);
    expect(await second.db.sql`SELECT id FROM federated_connection_events`).toHaveLength(0);
    expect(await first.db.sql`SELECT grant_id FROM grant_lineages`).toHaveLength(0);expect(await second.db.sql`SELECT grant_id FROM grant_lineages`).toHaveLength(0);
    expect(await first.db.sql`SELECT role FROM account_keys WHERE account_id=${a.id} AND role='hail-identity'`).toHaveLength(0);
    expect(requests.filter(r=>r.path.endsWith("/commit"))).toHaveLength(2); // lost reply retries the same committed operation
    const committed=requests.find(r=>r.path.endsWith("/commit"))!;
    const duplicate=await Promise.all([1,2].map(()=>committed.target.app.request(committed.target.origin+committed.path,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(committed.wire)})));
    expect(duplicate.map(r=>r.status)).toEqual([200,200]);expect((await duplicate[0]!.json() as {control:string}).control).toEqual((await duplicate[1]!.json() as {control:string}).control);
    const oldActive=requests.find(r=>r.path.endsWith("/sync")&&inspectSignedPayload("hail.connection-control",decodeBase64Url(r.wire.control as string)).payload.state==="active")!;
    const disconnect=await second.service.prepare(b.session,{requestId:randomUUID(),action:"disconnect",connectionId:oldId});
    await commit(b,disconnect);expect(await active(b)).toHaveLength(0);lostDisconnect=1;
    await drain(8);expect(await active(a)).toHaveLength(0);expect(await active(b)).toHaveLength(0);
    expect(Number((await first.db.sql<{epoch:number}[]>`SELECT epoch FROM federated_connection_pairs WHERE account_id=${a.id}`)[0]!.epoch)).toBe(2);
    const replay=await oldActive.target.app.request(oldActive.target.origin+oldActive.path,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(oldActive.wire)});
    expect(replay.status).toBe(200);expect(await active(b)).toHaveLength(0);
    const historical=await second.service.commit(b.session,bp.requestId);expect((historical.result as {connectionId:string}).connectionId).toBe(oldId);
    const stale=await prepare(a,bc.link);await commit(a,stale);await drain(4);expect(await active(a)).toHaveLength(0);expect(await active(b)).toHaveLength(0);
    expect((await first.service.status(a.session,stale.requestId)).result).toMatchObject({state:"conflict"});
    const replace=await second.service.prepare(b.session,{requestId:randomUUID(),action:"replace",id:bc.id});await commit(b,replace);
    const fresh=(await second.service.list(b.session)).codes.find(v=>v.personal)!;
    const reconnect=await prepare(a,fresh.link);await commit(a,reconnect);await drain(8);
    const newId=(await active(a))[0]!.id;expect(newId).not.toBe(oldId);expect((await active(b))[0]!.id).toBe(newId);
    const oldDisconnect=requests.find(r=>r.path.endsWith("/disconnect"))!;
    expect((await oldDisconnect.target.app.request(oldDisconnect.target.origin+oldDisconnect.path,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(oldDisconnect.wire)})).status).toBe(200);
    await drain(3);expect((await active(a))[0]!.id).toBe(newId);expect((await active(b))[0]!.id).toBe(newId);
    // Deliver disconnect before activation visibility, then replay delayed active state.
    const dc=await create(d),pending=await prepare(c,dc.link);await commit(c,pending);holdActive=true;
    await drain(2);expect(await active(c)).toHaveLength(1);expect(await active(d)).toHaveLength(0);
    const earlyEnd=await first.service.prepare(c.session,{requestId:randomUUID(),action:"disconnect",connectionId:(await active(c))[0]!.id});await commit(c,earlyEnd);
    holdClosed=true;await drain(4);expect(await active(c)).toHaveLength(0);expect(await active(d)).toHaveLength(0);
    const neverActivated=delayed.find(old=>inspectSignedPayload("hail.connection-control",decodeBase64Url(old.wire.control as string)).payload.state==='active')!;
    expect((await neverActivated.target.app.request(neverActivated.target.origin+"/hail/connections/sync",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(neverActivated.wire)})).status).toBe(200);
    expect(Number((await second.db.sql<{epoch:number}[]>`SELECT epoch FROM federated_connection_pairs WHERE account_id=${d.id} AND peer_did=${c.did}`)[0]!.epoch)).toBe(2);
    expect(await active(d)).toHaveLength(0); // current coordinator state wins before delayed disconnect delivery
    holdActive=false;holdClosed=false;
    for(const old of delayed)expect((await old.target.app.request(old.target.origin+"/hail/connections/sync",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(old.wire)})).status).toBe(200);
    await drain(5);expect(await active(d)).toHaveLength(0);
    const expiring=await second.service.prepare(d.session,{requestId:randomUUID(),action:"create",personal:false,label:"Short-lived",expiresAt:Math.floor(Date.now()/1000)+3});
    const expiringSaved=await commit(d,expiring),expiringCode=(await second.service.list(d.session)).codes.find(code=>code.id===(expiringSaved.result as {invitationId:string}).invitationId)!;
    const tooLate=await prepare(c,expiringCode.link);await commit(c,tooLate);loseAdmission=1;await drain(1);
    expect(await active(c)).toHaveLength(0);await Bun.sleep(3100);await drain(4);
    expect((await first.service.status(c.session,tooLate.requestId)).result).toMatchObject({state:"expired"});expect(await active(d)).toHaveLength(0);
    const revocable=await second.service.prepare(d.session,{requestId:randomUUID(),action:"create",personal:false,label:"Revoked before admission",expiresAt:Math.floor(Date.now()/1000)+3600});
    const revocableSaved=await commit(d,revocable),revocableCode=(await second.service.list(d.session)).codes.find(code=>code.id===(revocableSaved.result as {invitationId:string}).invitationId)!;
    const withdrawn=await prepare(c,revocableCode.link);await commit(c,withdrawn);
    const revoke=await second.service.prepare(d.session,{requestId:randomUUID(),action:"revoke",id:revocableCode.id});await commit(d,revoke);await drain(4);
    expect((await first.service.status(c.session,withdrawn.requestId)).result).toMatchObject({state:"expired"});expect(await active(c)).toHaveLength(0);
    // Reject forged/cross-account state, wrong-purpose controls and absent consent.
    const forged=structuredClone(oldActive.wire),sig=decodeBase64Url(forged.control as string);sig[sig.length-1]!^=1;forged.control=encodeBase64Url(sig);
    expect((await oldActive.target.app.request(oldActive.target.origin+oldActive.path,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(forged)})).status).not.toBe(200);
    expect((await second.app.request(second.origin+"/hail/connections/sync",{method:"POST",headers:{"Content-Type":"application/json",Origin:first.origin},body:JSON.stringify(oldActive.wire)})).status).toBe(403);
    const offer=requests.find(r=>r.path.endsWith("/admit"))!;
    expect((await first.app.request(first.origin+"/hail/connections/commit",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({...committed.wire,control:offer.wire.control})})).status).toBe(400);
    const substituted={...committed.wire,bundle:encodeBase64Url(new Uint8Array([1]))};
    expect((await first.app.request(first.origin+"/hail/connections/commit",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(substituted)})).status).toBe(400);
    // Even a correctly signed coordinator message cannot activate an account without its local consent.
    await prepare(d,ac.link); // an unsigned review is not consent
    const message=inspectSignedPayload("hail.connection-control",decodeBase64Url(oldActive.wire.control as string)).payload;
    const messaging=a.keys.keys.find(k=>k.role==='hail-messaging')!,rawKey=await first.encryptor.decrypt(a.id,messaging.role,messaging.algorithm,messaging.publicKey,messaging);
    let unapproved:Uint8Array;
    try{unapproved=await signPayload("hail.connection-control",{...message,to:d.did},createWebCryptoSigner(a.did+"#hail-messaging",await importEd25519PrivateKey(rawKey)));}finally{rawKey.fill(0);}
    const unsolicited={...oldActive.wire,control:encodeBase64Url(unapproved)};
    expect((await second.app.request(second.origin+"/hail/connections/sync",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(unsolicited)})).status).toBe(409);
    expect(await active(d)).toHaveLength(0);
    const messageKey=await first.encryptor.decrypt(a.id,messaging.role,messaging.algorithm,messaging.publicKey,messaging);
    let wrongEpoch:Uint8Array;
    try{wrongEpoch=await signPayload("hail.connection-control",{...message,epoch:message.epoch+10,connection_id:newId},createWebCryptoSigner(a.did+"#hail-messaging",await importEd25519PrivateKey(messageKey)));}finally{messageKey.fill(0);}
    expect((await second.app.request(second.origin+"/hail/connections/sync",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({...oldActive.wire,control:encodeBase64Url(wrongEpoch)})})).status).toBe(400);
    expect((await active(b))[0]!.id).toBe(newId);
    await expect(first.service.status(c.session,ap.requestId)).rejects.toMatchObject({status:404});
    await expect(first.db.sql`UPDATE federated_connection_attempts SET bundle=${new Uint8Array([1])} WHERE account_id=${a.id}`).rejects.toThrow("cannot be replaced");
    const fence=()=>first.db.sql`INSERT INTO provider_migration_fences(did,account_id,transfer_id,destination_service_base,state) VALUES(${a.did},${a.id},${randomUUID()},'https://destination.example.com/hail','fenced')`;
    await expect(fence()).rejects.toThrow("not portable");
    await expect(first.db.sql`INSERT INTO provider_migration_fences(did,account_id,transfer_id,destination_service_base,state) VALUES(${c.did},${c.id},${randomUUID()},'https://destination.example.com/hail','fenced')`).rejects.toThrow("Federated connection consent is not portable");
    const rollback=await first.db.sql.reserve();try{await expect(rollback.unsafe(await Bun.file(new URL("../migrations/rollback/0064_connection_federation.sql",import.meta.url)).text())).rejects.toThrow("prevents rollback");}finally{await rollback.unsafe("ROLLBACK");rollback.release();}
  }catch(error){console.error("Federation fixture HTTP outcomes",requests.slice(-12).map(r=>({provider:r.target.origin,path:r.path,status:r.status})));throw error;}
  finally{for(const p of providers){await p.db.close();await admin.unsafe(`DROP SCHEMA "${p.schema}" CASCADE`);}await admin.close();}
},90000);
