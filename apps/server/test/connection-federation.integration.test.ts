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
import {ConnectionMessagingAuthority} from "../src/accounts/connection-authorization.js";
import {AccountMessaging} from "../src/accounts/messaging.js";
import {AccountPublications} from "../src/accounts/publications.js";
import {OnboardingRepository} from "../src/onboarding/repository.js";
import {GrantRepository} from "../src/grants/repository.js";
import {BodyRepository} from "../src/bodies/repository.js";
import {registerBodyRoutes} from "../src/bodies/routes.js";
import {EnvelopeRepository} from "../src/envelopes/repository.js";
import {EnvelopeService} from "../src/envelopes/service.js";
import {EnvelopeReceiver} from "../src/envelopes/receiver.js";
import {registerEnvelopeRoutes} from "../src/envelopes/routes.js";
import {submitEnvelope} from "../src/envelopes/submission.js";
import {DeliveryRepository} from "../src/delivery/repository.js";
import {DeliveryWorker} from "../src/delivery/worker.js";
import {BodyRetriever} from "../src/delivery/retriever.js";
import {DeliveryStatusSigner} from "../src/delivery/status.js";
import {DeliveryStatusReceiver} from "../src/delivery/status-receiver.js";
import {ProtectedResponseSchedule} from "../src/http/protected-schedule.js";
import {uuidV7} from "../src/identity/uuid-v7.js";
import {registerAccountApiRoutes} from "../src/accounts/routes.js";
import {GrantService} from "../src/grants/service.js";
import {collectConnectionHistory,connectionHistoryDigest,validateConnectionHistory} from "../src/migration/connection-history.js";
import {createConnectionHandoverPlan,signConnectionHandover,verifyConnectionHandover} from "../src/migration/connection-handover.js";
import {ConnectionHandoverStage} from "../src/migration/connection-handover-stage.js";
import {TRANSFER_TABLES,TRANSFER_AUTHORITY_TABLES,validateTransferManifest,type TransferManifest} from "../src/migration/transfer.js";
import {requireConnectionHandoverComplete} from "../src/migration/connection-snapshot.js";
import {decodeSignedRecord,encodeSignedRecord} from "../src/migration/wire.js";
import {registerConnectionHandoverRoutes} from "../src/migration/routes.js";
import {PortablePlcSubmission} from "../src/migration/poc-plc-submission.js";

it.skipIf(!process.env.DATABASE_URL)("federates independent providers with owner signatures, crossed scans, durable retries and terminal epoch precedence",async()=>{
  const admin=new SQL(process.env.DATABASE_URL!),users=[] as User[],providers=[] as Provider[];
  type User={id:string;did:string;address:string;managed:boolean;keys:Awaited<ReturnType<typeof generateAccountKeys>>;session:AccountApiSession;token:string;
    assertion:(challenge:string)=>any;provider:Provider};
  type Provider={schema:string;db:ProviderDatabase;origin:string;app:Hono;service:AccountConnections;accounts:AccountApiRepository;passkeys:PasskeyAuth;encryptor:KeyEncryptor};
  const evidence={document:{},data:{},log:[]};
  const resolver:HailDidResolver={async resolve(did){const user=users.find(u=>u.did===did);if(!user)throw new Error("Unknown fixture DID");return {did,
    identityDidKey:user.keys.identityDidKey,messagingDidKey:user.keys.messagingDidKey,serviceBase:user.provider.origin+"/hail",evidence};}};
  let lostCommit=0,lostDisconnect=0,lostSync=0,holdActive=false,holdClosed=false,loseAdmission=0,lostEnvelope=0,bodyReads=0,coordinatorUnavailable=false;
  const requests:{target:Provider;path:string;wire:Record<string,unknown>;status:number}[]=[],delayed:{target:Provider;wire:Record<string,unknown>}[]=[];
  const network=async(request:Request)=>{
    const url=new URL(request.url),target=providers.find(p=>p.origin===url.origin);if(!target)throw new Error("Unapproved fixture target");
    if(coordinatorUnavailable&&url.pathname.endsWith('/connections/state'))throw new Error('Coordinator temporarily unreachable');
    if(url.pathname.endsWith('/envelopes')||url.pathname.includes('/bodies/')){
      if(url.pathname.includes('/bodies/'))bodyReads++;
      const response=await withFreshServingGenerations(target.db.sql,()=>target.app.request(request));
      if(response.ok&&url.pathname.endsWith('/envelopes')&&lostEnvelope){lostEnvelope--;throw new Error("Lost persisted envelope response");}
      return response;
    }
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
      const rollback=await db.sql.reserve();try{await rollback.unsafe(await Bun.file(new URL("../migrations/rollback/0066_connection_handover_preparations.sql",import.meta.url)).text());await rollback.unsafe(await Bun.file(new URL("../migrations/rollback/0065_connection_messages.sql",import.meta.url)).text());await rollback.unsafe(await Bun.file(new URL("../migrations/rollback/0064_connection_federation.sql",import.meta.url)).text());}finally{rollback.release();}
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
    await expect(first.db.sql`INSERT INTO provider_migration_fences(did,account_id,transfer_id,destination_service_base,state) VALUES(${c.did},${c.id},${randomUUID()},'https://destination.example.com/hail','fenced')`).rejects.toThrow("Federated connection consent is not portable");
    // Connection messaging reuses the actual envelope/body/status/delivery stack.
    const stack=(p:Provider)=>{
      p.app=new Hono();registerConnectionRoutes(p.app,p.service,p.accounts,p.origin);
      const sql=p.db.sql,accounts=new OnboardingRepository(sql),bodies=new BodyRepository(sql),envelopes=new EnvelopeRepository(sql),authority=new ConnectionMessagingAuthority(sql,resolver,p.origin+'/hail',p.service.federation);
      const validate=(url:URL)=>{if(!providers.some(p=>p.origin===url.origin))throw new Error("Unexpected message destination");};
      const statuses=new DeliveryStatusReceiver(sql,accounts,resolver,p.origin+'/hail'),signer=new DeliveryStatusSigner(sql,accounts,p.encryptor,resolver,p.origin+'/hail');
      const service=new EnvelopeService(accounts,new GrantRepository(sql),envelopes,p.encryptor,resolver,p.origin+'/hail',undefined,authority);
      const messaging=new AccountMessaging(sql,bodies,envelopes,service,(sender,id)=>submitEnvelope(sender,id,envelopes,resolver,statuses,{fetch:network,validateTarget:validate},authority));
      const publications=new AccountPublications(sql,messaging,authority),delivery=new DeliveryRepository(sql,authority),retriever=new BodyRetriever(resolver,network,validate);
      const schedule=new ProtectedResponseSchedule({minimumResponseMs:1,processingDeadlineMs:10000,maxInFlight:32});
      const grants=new GrantRepository(sql),grantService=new GrantService(accounts,grants,p.encryptor,resolver,{async verify(){throw new Error('No fixture subscription discovery');}},{async verify(){throw new Error('No fixture publisher profile');}},p.origin+'/hail');
      registerAccountApiRoutes(p.app,p.accounts,grants,grantService,p.origin,messaging,undefined,undefined,undefined,undefined,undefined,undefined,p.origin,publications);
      registerBodyRoutes(p.app,bodies);
      registerEnvelopeRoutes(p.app,new EnvelopeReceiver(accounts,envelopes,resolver,p.origin+'/hail'),undefined,schedule);
      return {accounts,bodies,envelopes,authority,service,messaging,publications,delivery,retriever,worker:new DeliveryWorker(delivery,retriever),statuses,signer,schedule};
    };
    const one=stack(first),two=stack(second);
    const received=async()=>{for(let i=0;i<500&&(one.schedule.inFlight||two.schedule.inFlight);i++)await Bun.sleep(10);expect(one.schedule.inFlight+two.schedule.inFlight).toBe(0);};
    const api=(user:User,path:string,input?:unknown,headers:Record<string,string>={})=>user.provider.app.request(user.provider.origin+'/api/v1/account/'+path,{method:input===undefined?'GET':'POST',
      headers:{Cookie:'hail_session='+user.token,Origin:user.provider.origin,'Content-Type':'application/json',...headers},...(input===undefined?{}:{body:JSON.stringify(input)})});
    const native=await prepare(c,ac.link);await commit(c,native);
    const targets=(await one.publications.connectionTargets(a.session)).connections,localTarget=targets.find(t=>t.recipientDid===c.did)!,remoteTarget=targets.find(t=>t.recipientDid===b.did)!;
    expect(localTarget.epoch).toBe(1);expect(remoteTarget.connectionId).toBe(newId);
    const direct={publicationId:uuidV7(),connections:[localTarget.connectionId,remoteTarget.connectionId],text:'Private connection message to two people'};
    expect((await first.app.request(first.origin+'/api/v1/account/connection-messages/targets')).status).toBe(401);
    expect((await api(a,'connection-messages',direct,{Origin:'https://foreign.example'})).status).toBe(403);
    const readOnly=await first.accounts.issue(a.address,false,undefined,['messages:read']);
    expect((await api(a,'connection-messages/targets',undefined,{Authorization:'Bearer '+readOnly.token})).status).toBe(403);
    expect((await api(a,'connection-messages',direct,{Authorization:'Bearer '+readOnly.token})).status).toBe(403);
    const admitted=await api(a,'connection-messages',direct);expect(admitted.status).toBe(202);expect((await admitted.json() as {total:number}).total).toBe(2);
    expect((await api(c,'connection-messages/'+direct.publicationId)).status).toBe(404);
    expect((await api(a,'publications/'+direct.publicationId)).status).toBe(404);
    expect((await api(a,'connection-messages',{...direct,publicationId:uuidV7(),category:'general'})).status).toBe(400);
    expect((await api(a,'connection-messages',{...direct,publicationId:uuidV7(),allowReplies:true})).status).toBe(400);
    expect((await api(a,'connection-messages',{...direct,publicationId:uuidV7(),connections:[localTarget.connectionId,localTarget.connectionId]})).status).toBe(400);
    expect((await one.publications.recent(a.session)).publications).toHaveLength(0); // not a subscription publication
    expect((await one.publications.recent(a.session,'connections')).publications).toHaveLength(1);
    lostEnvelope=1;await withFreshServingGenerations(first.db.sql,()=>one.publications.workOne());
    const materialized=await first.db.sql<{message_id:string;envelope_cose:Uint8Array}[]>`SELECT message_id,envelope_cose FROM sent_envelopes WHERE authorization_type='connection'`;
    expect(materialized).toHaveLength(1);
    await first.db.sql`UPDATE connection_message_targets SET next_attempt_at=now() WHERE state='pending'`;
    const restarted=new AccountPublications(first.db.sql,one.messaging,one.authority);
    await withFreshServingGenerations(first.db.sql,()=>restarted.workOne());await withFreshServingGenerations(first.db.sql,()=>restarted.workOne());
    expect(await one.envelopes.sent(a.did,materialized[0]!.message_id)).toEqual(new Uint8Array(materialized[0]!.envelope_cose));
    const completed=(await restarted.status(a.session,direct.publicationId,'connections'))!;expect(completed.counts.submitted).toBe(2);
    const copies=await first.db.sql<{envelope_cose:Uint8Array}[]>`SELECT envelope_cose FROM sent_envelopes WHERE message_id IN(
      SELECT message_id FROM connection_message_targets WHERE publication_id=${direct.publicationId})`;
    const payloads=copies.map(row=>inspectSignedPayload('hail.envelope',new Uint8Array(row.envelope_cose)).payload);
    expect(payloads.every(p=>p.version===2&&p.authorization.type==='connection'&&!p.reply.allowed&&p.category===undefined)).toBe(true);
    expect(Buffer.from(payloads[0]!.body.digest.value)).toEqual(Buffer.from(payloads[1]!.body.digest.value));
    expect(Buffer.from(payloads[0]!.body.access.token)).not.toEqual(Buffer.from(payloads[1]!.body.access.token));
    await received();
    expect(await withFreshServingGenerations(first.db.sql,()=>one.worker.processOne())).toBe('delivered');
    coordinatorUnavailable=true;const beforeOfflineRead=bodyReads;
    expect(await withFreshServingGenerations(second.db.sql,()=>two.worker.processOne())).toBe('on-hold');expect(bodyReads).toBe(beforeOfflineRead);
    coordinatorUnavailable=false;await second.db.sql`UPDATE delivery_work SET next_attempt_at=now() WHERE state='on-hold'`;
    expect(await withFreshServingGenerations(second.db.sql,()=>two.worker.processOne())).toBe('delivered');
    for(const target of completed.targets){
      const recipient=target.recipient===b.did?two:one,signed=await recipient.signer.signCurrent(a.did,target.messageId);expect(signed).not.toBeNull();
      const sent=inspectSignedPayload('hail.envelope',(await one.envelopes.sent(a.did,target.messageId))!),path=encodeBase64Url(new Uint8Array(createHash('sha256').update(sent.payloadBytes).digest()));
      expect(await one.statuses.receive(path,signed!)).toBe('acknowledged');
    }
    expect((await restarted.status(a.session,direct.publicationId,'connections'))!.delivery.delivered).toBe(2);
    expect((await two.messaging.inboxFeed(b.session,null,'subscriptions')).messages).toHaveLength(0);
    expect((await two.messaging.inboxFeed(b.session,null,'connections')).messages).toHaveLength(1);
    const sentToB=completed.targets.find(t=>t.recipient===b.did)!;
    expect(await two.messaging.read(b.session,a.did,sentToB.messageId)).toMatchObject({kind:'connection',replyAvailable:false,senderAddress:a.address});
    expect(await second.db.sql`SELECT original_message_id FROM reply_capabilities`).toHaveLength(0);
    const stopped={publicationId:uuidV7(),connections:direct.connections,text:'Cancel before materialization'};
    await restarted.createConnections(a.session,stopped);
    await expect(first.db.sql`UPDATE connection_message_batches SET body_bytes=${new Uint8Array([1])} WHERE id=${stopped.publicationId}`).rejects.toThrow('cannot be replaced');
    await expect(first.db.sql`UPDATE connection_message_targets SET recipient_did=${d.did} WHERE publication_id=${stopped.publicationId}`).rejects.toThrow('cannot be replaced');
    expect(await restarted.cancel(c.session,stopped.publicationId,'connections')).toBeNull();
    expect((await restarted.cancel(a.session,stopped.publicationId,'connections'))!.counts.cancelled).toBe(2);
    await expect(restarted.createConnections(c.session,{...direct,publicationId:uuidV7()})).rejects.toMatchObject({status:409});
    await expect(restarted.createConnections(a.session,{...direct,text:'changed'})).rejects.toMatchObject({status:409});
    const queued={publicationId:uuidV7(),connections:[remoteTarget.connectionId],text:'Queued before receiver disconnect'};
    await restarted.createConnections(a.session,queued);await withFreshServingGenerations(first.db.sql,()=>restarted.workOne());
    await received();
    const endRemote=await second.service.prepare(b.session,{requestId:randomUUID(),action:'disconnect',connectionId:newId});await commit(b,endRemote);
    const readsBefore=bodyReads;
    expect(await withFreshServingGenerations(second.db.sql,()=>two.worker.processOne())).toBe('failed');expect(bodyReads).toBe(readsBefore);
    const queuedId=(await restarted.status(a.session,queued.publicationId,'connections'))!.targets[0]!.messageId;
    const failedReceipt=await two.signer.signCurrent(a.did,queuedId),queuedBytes=(await one.envelopes.sent(a.did,queuedId))!;
    const queuedDigest=encodeBase64Url(new Uint8Array(createHash('sha256').update(inspectSignedPayload('hail.envelope',queuedBytes).payloadBytes).digest()));
    expect(await one.statuses.receive(queuedDigest,failedReceipt!)).toBe('acknowledged');
    expect(await one.messaging.sentMessage(a.session,queuedId)).toMatchObject({state:'failed',reason:'receiver-policy-rejected'});
    expect((await two.messaging.inboxFeed(b.session,null,'connections')).messages).toHaveLength(1);
    await drain(6);
    await expect(one.messaging.submit(a.did,(await restarted.status(a.session,queued.publicationId,'connections'))!.targets[0]!.messageId)).rejects.toMatchObject({status:409});
    const oldLocal={publicationId:uuidV7(),connections:[localTarget.connectionId],text:'Never retarget an old batch after reconnect'};
    await restarted.createConnections(a.session,oldLocal);
    const endNative=await first.service.prepare(c.session,{requestId:randomUUID(),action:'disconnect',connectionId:localTarget.connectionId});await commit(c,endNative);
    const refresh=await first.service.prepare(a.session,{requestId:randomUUID(),action:'replace',id:ac.id});await commit(a,refresh);
    const refreshed=(await first.service.list(a.session)).codes.find(code=>code.personal)!;
    const nativeAgain=await prepare(c,refreshed.link);await commit(c,nativeAgain);
    await withFreshServingGenerations(first.db.sql,()=>restarted.workOne());
    expect((await restarted.status(a.session,oldLocal.publicationId,'connections'))!.counts.blocked).toBe(1);
    const currentLocal=(await one.publications.connectionTargets(a.session)).connections.find(t=>t.recipientDid===c.did)!;
    expect(currentLocal.connectionId).not.toBe(localTarget.connectionId);
    const race={publicationId:uuidV7(),connections:[currentLocal.connectionId],text:'Disconnect while the body is being retrieved'};
    await restarted.createConnections(a.session,race);await withFreshServingGenerations(first.db.sql,()=>restarted.workOne());
    await received();
    const raceWorker=new DeliveryWorker(one.delivery,{async retrieve(envelope){const result=await one.retriever.retrieve(envelope);
      const end=await first.service.prepare(c.session,{requestId:randomUUID(),action:'disconnect',connectionId:currentLocal.connectionId});await commit(c,end);return result;}});
    expect(await withFreshServingGenerations(first.db.sql,()=>raceWorker.processOne())).toBe('failed');
    const raceId=(await restarted.status(a.session,race.publicationId,'connections'))!.targets[0]!.messageId;
    expect(await first.db.sql`SELECT message_id FROM delivered_messages WHERE message_id=${raceId}`).toHaveLength(0);
    expect(await first.db.sql`SELECT grant_id FROM grant_lineages`).toHaveLength(0); // independent of subscriptions
    // Checkpoint collection is read-only and account-local. It does not enable
    // cutover or revoke codes merely because an export is being reviewed.
    const capturedAt=new Date().toISOString(),owner={accountId:a.id,did:a.did,sourceGeneration:1,sourceServiceBase:first.origin+'/hail'};
    const invitationsBefore=await first.db.sql`SELECT * FROM connection_invitations WHERE account_id=${a.id} ORDER BY id`;
    const capture=()=>first.db.sql.begin(async tx=>{
      await tx`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY`;
      return collectConnectionHistory(tx as SQL,owner,capturedAt);
    });
    const checkpoint=await capture(),again=await capture();
    expect(connectionHistoryDigest(again)).toEqual(connectionHistoryDigest(checkpoint));
    expect(validateConnectionHistory(new TextEncoder().encode(JSON.stringify(checkpoint)),owner)).toEqual(checkpoint);
    expect(checkpoint.tables.federated_connection_tombstones.map(r=>r.connection_id)).toContain(oldId);
    expect(checkpoint.tables.account_connections.map(r=>r.id)).toContain(localTarget.connectionId);
    expect(checkpoint.tables.connection_message_batches.length).toBeGreaterThan(0);
    expect(checkpoint.tables.connection_message_targets.some(r=>r.state==='cancelled')).toBe(true);
    expect(checkpoint.tables.federated_connection_attempts.every(r=>r.account_id===a.id&&!("token_ciphertext" in r))).toBe(true);
    expect(checkpoint.tables.connection_approvals.every(r=>r.account_id===a.id&&!("session_id" in r)&&!("credential_id" in r))).toBe(true);
    expect(await first.db.sql`SELECT * FROM connection_invitations WHERE account_id=${a.id} ORDER BY id`).toEqual(invitationsBefore);
    await expect(first.db.sql.begin(tx=>collectConnectionHistory(tx as SQL,{...owner,did:c.did},capturedAt))).rejects.toThrow('source ownership changed');
    await expect(second.db.sql.begin(tx=>collectConnectionHistory(tx as SQL,{accountId:d.id,did:d.did,sourceGeneration:1,sourceServiceBase:second.origin+'/hail'},capturedAt))).rejects.toThrow('unfinished');
    // Seed the trusted inert-import boundary for handover staging. Actual transfer
    // signature/owner/PLC staging is exercised by the separate migration fixtures.
    const transferId=randomUUID(),tables=Object.fromEntries([...TRANSFER_TABLES,...TRANSFER_AUTHORITY_TABLES].map(t=>[t,[] as Record<string,unknown>[]])) as TransferManifest['tables'];
    tables.provider_accounts=[{id:a.id,did:a.did,onboarding_state:'active',activation_verification_mode:'public'}];
    tables.account_keys=a.keys.keys.filter(k=>k.role!=='hail-identity').map(k=>({account_id:a.id,role:k.role,public_key:k.publicKey}));
    tables.portable_custody_evidence=[{account_id:a.id,user_recovery_public_key:a.keys.rotationDidKey,user_identity_public_key:a.keys.identityDidKey,
      monitor_verification_mode:'poc-local',monitor_origin:'https://monitor.example.com',monitor_public_key:a.keys.messagingDidKey,monitor_confirmed_at:capturedAt,backup_confirmed_at:capturedAt}];
    tables.sent_envelopes=(await first.db.sql<{row:Record<string,unknown>}[]>`SELECT to_jsonb(t) AS row FROM sent_envelopes t WHERE sender_account_id=${a.id}`).map(r=>r.row);
    const manifest:TransferManifest={version:5,transferId,did:a.did,accountId:a.id,sourceServiceBase:first.origin+'/hail',destinationServiceBase:second.origin+'/hail',
      destinationRotationPublicKey:d.keys.rotationDidKey,destinationMessagingPublicKey:d.keys.messagingDidKey,custodyProfile:'portable',capturedAt,sourceGeneration:1,
      connections:checkpoint,connectionCheckpointDigest:encodeBase64Url(connectionHistoryDigest(checkpoint)),tables};
    const manifestBytes=new TextEncoder().encode(JSON.stringify(manifest)),snapshotDigest=new Uint8Array(createHash('sha256').update(manifestBytes).digest());
    expect(validateTransferManifest(manifestBytes).connections).toEqual(checkpoint);
    expect(()=>requireConnectionHandoverComplete(manifest)).toThrow('staged only');
    await second.db.sql`INSERT INTO pending_migration_imports(transfer_id,did,source_service_base,destination_service_base,manifest_bytes,manifest_digest,
      source_messaging_public_key,signature,state,verified_plc_document,verified_plc_data,verified_plc_operation_log) VALUES(${transferId},${a.did},${manifest.sourceServiceBase},
      ${manifest.destinationServiceBase},${manifestBytes},${snapshotDigest},${a.keys.messagingDidKey},${new Uint8Array(64)},'staged','{}','{}','[]')`;
    let plcCalls=0;const forbiddenPlc=async()=>{plcCalls++;throw new Error('Must not reach PLC before handover commit');};
    await expect(new PortablePlcSubmission(second.db.sql,{getOperationLog:forbiddenPlc,sendOperation:forbiddenPlc} as never,'https://plc.directory',manifest.destinationServiceBase).submit(transferId)).rejects.toThrow('staged only');
    expect(plcCalls).toBe(0);
    const privateMessaging=async(user:User)=>{const k=user.keys.keys.find(k=>k.role==='hail-messaging')!,raw=await user.provider.encryptor.decrypt(user.id,k.role,k.algorithm,k.publicKey,k);
      try{return await importEd25519PrivateKey(raw);}finally{raw.fill(0);}};
    const [sourcePrivate,destinationPrivate]=await Promise.all([privateMessaging(a),privateMessaging(d)]);
    const handoverStage=new ConnectionHandoverStage(second.db.sql,resolver,manifest.destinationServiceBase);
    const handoverApp=new Hono();registerConnectionHandoverRoutes(handoverApp,handoverStage);
    const pairBefore=await second.db.sql`SELECT * FROM federated_connection_pairs WHERE account_id=${b.id}`;
    for(const peer of [b,c]){
      const plan=createConnectionHandoverPlan(checkpoint,{transferId,requestId:uuidV7(),peerDid:peer.did,destinationServiceBase:manifest.destinationServiceBase,
        destinationMessagingKey:manifest.destinationMessagingPublicKey,snapshotDigest,issuedAt:Math.floor(Date.now()/1000)});
      const proposal=await signConnectionHandover(plan,'source',sourcePrivate),destination=await signConnectionHandover(plan,'destination',destinationPrivate);
      const wire={proposal:encodeSignedRecord(proposal),destinationSignature:encodeBase64Url(destination.signature)};
      const reply=await peer.provider.app.request(peer.provider.origin+'/hail/connections/handover',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(wire)});
      expect(reply.status).toBe(200);const ack=decodeSignedRecord((await reply.json()).preparation,65536);
      expect(await verifyConnectionHandover(ack,'peer-ack',peer.keys.messagingDidKey,Math.floor(Date.now()/1000))).toEqual(plan);
      const staged={...wire,preparation:encodeSignedRecord(ack)};
      const accept=()=>handoverApp.request(second.origin+'/hail/transfers/connection-handovers',{method:'POST',headers:{'Content-Type':'application/hail-transfer+json'},body:JSON.stringify(staged)});
      expect(await (await accept()).json()).toMatchObject({phase:'prepared',cutoverAuthorized:false,peerDid:peer.did});
      expect((await accept()).status).toBe(200); // exact durable retry
      await expect(handoverStage.accept({...staged,destinationSignature:encodeBase64Url(proposal.signature)})).rejects.toThrow('purpose');
      const changed={...plan,snapshot_digest:new Uint8Array(32)};
      const substituted=await signConnectionHandover(changed,'source',sourcePrivate),subDestination=await signConnectionHandover(changed,'destination',destinationPrivate);
      await expect(handoverStage.accept({proposal:encodeSignedRecord(substituted),destinationSignature:encodeBase64Url(subDestination.signature),preparation:encodeSignedRecord(ack)})).rejects.toThrow('bytes differ');
      const stale={...plan,frontier:{...plan.frontier,native:plan.frontier.native.map(n=>({...n,state:'active' as const}))}};
      if(peer===b)stale.frontier.federated={...plan.frontier.federated!,epoch:plan.frontier.federated!.epoch+1};
      // Both providers sign the altered frontier; the peer must still refuse it.
      if(peer===b){const s=await signConnectionHandover(stale,'source',sourcePrivate),t=await signConnectionHandover(stale,'destination',destinationPrivate);
        expect((await peer.provider.app.request(peer.provider.origin+'/hail/connections/handover',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({proposal:encodeSignedRecord(s),destinationSignature:encodeBase64Url(t.signature)})})).status).toBe(409);}
      if(peer===b){const missing=structuredClone(plan);missing.frontier.federated!.tombstones=missing.frontier.federated!.tombstones.filter(t=>t.connectionId!==oldId);
        const s=await signConnectionHandover(missing,'source',sourcePrivate),t=await signConnectionHandover(missing,'destination',destinationPrivate);
        expect((await peer.provider.app.request(peer.provider.origin+'/hail/connections/handover',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({proposal:encodeSignedRecord(s),destinationSignature:encodeBase64Url(t.signature)})})).status).toBe(409);}
    }
    expect(await second.db.sql`SELECT * FROM federated_connection_pairs WHERE account_id=${b.id}`).toEqual(pairBefore);
    expect(await second.db.sql`SELECT peer_did FROM connection_handover_preparations WHERE transfer_id=${transferId}`).toHaveLength(2);
    await expect(second.db.sql`DELETE FROM connection_handover_preparations WHERE transfer_id=${transferId}`).rejects.toThrow();
    const handoverRollback=await second.db.sql.reserve();try{await expect(handoverRollback.unsafe(await Bun.file(new URL('../migrations/rollback/0066_connection_handover_preparations.sql',import.meta.url)).text())).rejects.toThrow('prevents schema rollback');}finally{await handoverRollback.unsafe('ROLLBACK');handoverRollback.release();}
    const fence=()=>first.db.sql`INSERT INTO provider_migration_fences(did,account_id,transfer_id,destination_service_base,state) VALUES(${a.did},${a.id},${randomUUID()},'https://destination.example.com/hail','fenced')`;
    await expect(fence()).rejects.toThrow("not portable");
    await expect(first.db.sql`INSERT INTO provider_migration_fences(did,account_id,transfer_id,destination_service_base,state) VALUES(${c.did},${c.id},${randomUUID()},'https://destination.example.com/hail','fenced')`).rejects.toThrow("not portable");
    const messageRollback=await first.db.sql.reserve();try{await expect(messageRollback.unsafe(await Bun.file(new URL("../migrations/rollback/0065_connection_messages.sql",import.meta.url)).text())).rejects.toThrow("Retained connection messages");}finally{await messageRollback.unsafe('ROLLBACK');messageRollback.release();}
    const rollback=await first.db.sql.reserve();try{await expect(rollback.unsafe(await Bun.file(new URL("../migrations/rollback/0064_connection_federation.sql",import.meta.url)).text())).rejects.toThrow("prevents rollback");}finally{await rollback.unsafe("ROLLBACK");rollback.release();}
  }catch(error){console.error("Federation fixture HTTP outcomes",requests.slice(-12).map(r=>({provider:r.target.origin,path:r.path,status:r.status})));throw error;}
  finally{for(const p of providers){await p.db.close();await admin.unsafe(`DROP SCHEMA "${p.schema}" CASCADE`);}await admin.close();}
},90000);
