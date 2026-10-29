import {createHash,generateKeyPairSync,randomBytes,randomUUID,sign} from "node:crypto";
import {SQL} from "bun";
import {Hono} from "hono";
import {expect,it,vi} from "vitest";
import {P256Keypair} from "@atproto/crypto";
import {cidForCbor} from '@atproto/common';
import {def,didForCreateOp,formatDidDoc,signOperation,validateOperationLog} from "@did-plc/lib";
import {createWebCryptoSigner,decodeBase64Url,decodeDeterministic,encodeBase64Url,encodeDeterministic,fromDiagnosticJson,inspectSignedPayload,signPayload} from "@hailproto/codec";
import {ProviderDatabase} from "../src/db/database.js";
import {AccountConnections} from "../src/accounts/connections.js";
import {RemoteConnectionReview} from "../src/accounts/connection-review.js";
import {registerConnectionRoutes} from "../src/accounts/connection-routes.js";
import {AccountApiRepository,type AccountApiSession} from "../src/accounts/repository.js";
import {PasskeyAuth} from "../src/accounts/passkeys.js";
import {KeyEncryptor} from "../src/identity/key-encryption.js";
import {generateAccountKeys} from "../src/identity/keys.js";
import {importEd25519PrivateKey} from "../src/identity/keys.js";
import type {HailDidResolver,PlcResolutionEvidence} from "../src/plc/resolver.js";
import {withFreshServingGenerations} from "../src/db/serving.js";
import {ConnectionMessagingAuthority,connectionMessageAllowed} from "../src/accounts/connection-authorization.js";
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
import {collectConnectionHistory,connectionHistoryDigest,validateConnectionHistory,inspectConnectionProof} from "../src/migration/connection-history.js";
import {createConnectionHandoverPlan,signConnectionHandover,verifyConnectionHandover,connectionHandoverPlanDigest,
  signConnectionHandoverAbort,verifyConnectionHandoverAbort,type ConnectionHandoverAbort} from "../src/migration/connection-handover.js";
import {ConnectionHandoverStage} from "../src/migration/connection-handover-stage.js";
import {TRANSFER_TABLES,TRANSFER_AUTHORITY_TABLES,validateTransferManifest,type TransferManifest} from "../src/migration/transfer.js";
import {requireConnectionHandoverComplete} from "../src/migration/connection-snapshot.js";
import {decodeSignedRecord,encodeSignedRecord} from "../src/migration/wire.js";
import {registerConnectionHandoverRoutes} from "../src/migration/routes.js";
import {PortablePlcSubmission} from "../src/migration/poc-plc-submission.js";
import {verifyConnectionHistoryAuthority} from "../src/migration/connection-history-verification.js";
import {ConnectionReconstruction,reconstructConnections} from '../src/migration/connection-reconstruction.js';
import {MANAGED_TRANSFER_TABLES,managedHistoryCheckpoint,managedSnapshotSignatureInput,validateManagedTransferManifest,type ManagedTransferManifest} from '../src/migration/managed-snapshot.js';
import {signConnectionHandoverTransition,verifyConnectionHandoverResult,connectionActivationDigest,type ConnectionHandoverTransition} from '../src/migration/connection-handover.js';
import {signActivationReceipt} from '../src/migration/activation-receipt.js';
import {ConnectionTransferOrchestration} from '../src/migration/connection-orchestration.js';
import {PrivatePocManagedResolver} from '../src/plc/poc-resolver.js';
import {ManagedTransferAuthorization} from '../src/migration/managed-authorization.js';
import {ManagedTransferDelivery} from '../src/migration/managed-delivery.js';
import {ManagedTransferInvitationReceiver} from '../src/migration/managed-invitation-receiver.js';
import {ManagedTransferAddressReservation} from '../src/migration/managed-address-selection.js';
import {ManagedTransferFencePublisher} from '../src/migration/managed-fence-publisher.js';
import {ManagedMigrationFenceService} from '../src/migration/managed-fence.js';
import {ManagedMigrationExportService} from '../src/migration/managed-snapshot.js';
import {ManagedMigrationStageService} from '../src/migration/managed-stage.js';
import {ManagedMigrationPlcSubmission} from '../src/migration/managed-plc-submission.js';
import {ManagedMigrationActivation} from '../src/migration/managed-activation.js';
import {ManagedMigrationCompletion} from '../src/migration/managed-completion.js';
import {PreparedMigrationTarget} from '../src/migration/target-keys.js';
import {registerConnectionSourceRoutes,registerManagedTransferRoutes} from '../src/migration/routes.js';
import {encodeManagedHandshake,managedHandshakeSignatureInput,managedHandshakeDigest,type ManagedTransferGrant,type ManagedTransferAddressSelection,type ManagedTransferApproval} from '../src/migration/managed-handshake.js';
import {connectionCancellationInput} from '../src/migration/connection-cancellation.js';
import {AccountAccess} from '../src/accounts/access.js';
import {accountAccessInput} from '../../cli/src/account-access-proof.js';
import {virtualPasskey} from './support/virtual-passkey.js';
import {MigrationFenceService} from '../src/migration/fence.js';
import {MigrationTransferService} from '../src/migration/transfer.js';
import {TransferInvitationService,signHandshake,handshakeDigest,type TransferGrant,type TransferAddressSelection} from '../src/migration/handshake.js';
import {TransferInvitationDelivery} from '../src/migration/invitation-delivery.js';
import {TransferInvitationReceiver} from '../src/migration/invitation-receiver.js';
import {TransferAddressReservation} from '../src/migration/address-selection.js';
import {TransferFinalRequestPublisher} from '../src/migration/final-request-publisher.js';
import {registerTransferRoutes} from '../src/migration/routes.js';
import {PortableCutoverGate} from '../src/migration/cutover-gate.js';
import {PortableAddressPublication} from '../src/migration/poc-address-publication.js';
import {PortableTransferCompletion} from '../src/migration/poc-completion.js';
import {signMonitorAttestation} from '../src/migration/monitor-attestation.js';
import {SameProviderCustodyTransition,type CustodyTransitionApproval} from '../src/accounts/custody-transition.js';
import {VerifiedPublicPlcResolver} from '../src/plc/public-resolver.js';
import {PlcHailDidResolver} from '../src/plc/resolver.js';
import {plcStateDigest} from '../src/plc/read-evidence.js';
import {validateReturningEvidence} from '../src/migration/return.js';
import {PortableMigrationActivation} from '../src/migration/activation.js';
import {signPortableMigrationConsent} from '../src/migration/consent.js';
import {encode as encodeDagCbor} from '@ipld/dag-cbor';

it.skipIf(!process.env.DATABASE_URL)("federates independent providers with owner signatures, crossed scans, durable retries and terminal epoch precedence",async()=>{
  const admin=new SQL(process.env.DATABASE_URL!),users=[] as User[],providers=[] as Provider[];
  type User={id:string;did:string;address:string;managed:boolean;keys:Awaited<ReturnType<typeof generateAccountKeys>>;session:AccountApiSession;token:string;
    assertion:(challenge:string)=>any;provider:Provider;evidence:PlcResolutionEvidence;recoveryPublicKey:string;recoveryKey:P256Keypair};
  type Provider={schema:string;db:ProviderDatabase;origin:string;app:Hono;service:AccountConnections;accounts:AccountApiRepository;passkeys:PasskeyAuth;encryptor:KeyEncryptor};
  const resolver:HailDidResolver={async resolve(did){const user=users.find(u=>u.did===did);if(!user)throw new Error("Unknown fixture DID");return {did,
    identityDidKey:(user.evidence.data as any).verificationMethods['hail-identity'],messagingDidKey:(user.evidence.data as any).verificationMethods['hail-messaging'],serviceBase:(user.evidence.data as any).services.hail.endpoint,evidence:user.evidence};}};
  let lostCommit=0,lostDisconnect=0,lostSync=0,holdActive=false,holdClosed=false,loseAdmission=0,lostEnvelope=0,bodyReads=0,coordinatorUnavailable=false,lostFreeze=0,lostAbort=0,lostPostCommit=0,lostCompletion=0;
  const requests:{target:Provider;path:string;wire:Record<string,unknown>;status:number}[]=[],delayed:{target:Provider;wire:Record<string,unknown>}[]=[];
  let portabilityStage='lifecycle and messaging';
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
    if(response.ok&&path.endsWith('/handover-freeze')&&lostFreeze){lostFreeze--;throw new Error('Lost durable freeze reply');}
    if(response.ok&&path.endsWith('/handover-abort')&&lostAbort){lostAbort--;throw new Error('Lost durable abort reply');}
    if(response.ok&&path.endsWith('/handover-commit')&&lostPostCommit){lostPostCommit--;throw new Error('Lost post-cutover commit reply');}
    if(response.ok&&path.endsWith('/handover-complete')&&lostCompletion){lostCompletion--;throw new Error('Lost final handover reply');}
    return response;
  };
  try{
    for(const name of ["source","second","target"]){
      const schema="federation_"+name+"_"+randomUUID().replaceAll("-","");await admin.unsafe(`CREATE SCHEMA "${schema}"`);
      const url=new URL(process.env.DATABASE_URL!);url.searchParams.set("options",`-csearch_path=${schema}`);
      const db=new ProviderDatabase(url.toString()),origin=`https://${name}.example.com`,encryptor=new KeyEncryptor(encodeBase64Url(randomBytes(32)));
      const accounts=new AccountApiRepository(db.sql),passkeys=new PasskeyAuth(db.sql,`${name}.example.com`,origin),app=new Hono();
      const remote=new RemoteConnectionReview(db.sql,resolver,network,url=>{if(!providers.some(p=>p.origin===url.origin))throw new Error("Unexpected destination");},origin+"/hail");
      const service=new AccountConnections(db.sql,encryptor,resolver,passkeys,origin,remote);
      const provider={schema,db,origin,encryptor,accounts,passkeys,app,service};providers.push(provider);await db.migrate();
      // Run against the current schema; newer migrations prohibit the old rollback chain.
      registerConnectionRoutes(app,service,accounts,origin);
    }
    const addUser=async(provider:Provider,letter:string,managed:boolean)=>{
      const id=randomUUID(),address=letter+"@"+new URL(provider.origin).hostname,keys=await generateAccountKeys(id,provider.encryptor),sql=provider.db.sql,recovery=await P256Keypair.create();
      // Real genesis chains, with disjoint DID ranges retaining a<b<c<d so both
      // provider placements and the canonical-coordinator assertions stay exact.
      const bounds:Record<string,[string,string]>={a:['','g'],b:['g','m'],c:['m','t'],d:['t','{']};
      const makeGenesis=()=>signOperation({type:'plc_operation',prev:null,rotationKeys:[recovery.did(),keys.rotationDidKey],
        verificationMethods:{'hail-identity':keys.identityDidKey,'hail-messaging':keys.messagingDidKey},alsoKnownAs:['https://fixture.example.com/'+randomUUID()],
        services:{hail:{type:'HailMessaging',endpoint:provider.origin+'/hail'}}},recovery);
      let genesis=await makeGenesis(),did=await didForCreateOp(genesis);
      while(did.slice(8)<bounds[letter]![0]||did.slice(8)>=bounds[letter]![1]){genesis=await makeGenesis();did=await didForCreateOp(genesis);}
      const state=(await validateOperationLog(did,[genesis]))!,evidence:PlcResolutionEvidence={document:formatDidDoc(state),data:state,log:[genesis]};
      await sql`INSERT INTO provider_accounts(id,tenant_id,canonical_address,did,onboarding_state,activated_at,activation_binding_digest,activation_verification_mode)
        VALUES(${id},${randomUUID()},${address},${did},'active',now(),${randomBytes(32)},'public')`;
      for(const key of keys.keys.filter(k=>managed||k.role!=="hail-identity"))await sql`INSERT INTO account_keys(account_id,role,algorithm,public_key,encrypted_private_key,encryption_nonce,encryption_version,kek_id)
        VALUES(${id},${key.role},${key.algorithm},${key.publicKey},${key.ciphertext},${key.nonce},1,'poc-v1')`;
      if(managed)await sql`INSERT INTO managed_custody_evidence(account_id,owner_recovery_public_key,provider_identity_public_key,verification_mode,managed_profile_version)
        VALUES(${id},${recovery.did()},${keys.identityDidKey},'poc-local','hail-managed-custody-v1')`;
      else await sql`INSERT INTO portable_custody_evidence(account_id,user_recovery_public_key,user_identity_public_key,monitor_origin,monitor_public_key,monitor_confirmed_at,backup_confirmed_at,monitor_verification_mode)
        VALUES(${id},${recovery.did()},${keys.identityDidKey},'https://monitor.example.com',${letter==='a'?monitor.identityDidKey:keys.messagingDidKey},now(),now(),${letter==='a'?'independent':'poc-local'})`;
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
      const user={id,did,address,managed,keys,session,token:logged.token,assertion,provider,evidence,recoveryPublicKey:recovery.did(),recoveryKey:recovery};users.push(user);return user;
    };
    const [first,second,third]=providers as [Provider,Provider,Provider];
    const monitor=await generateAccountKeys(randomUUID(),first.encryptor);
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
    const forceDue=async()=>{for(const p of providers)await withFreshServingGenerations(p.db.sql,async()=>{await p.db.sql`UPDATE federated_connection_attempts SET next_attempt_at=now() WHERE state='pending'`;await p.db.sql`UPDATE federated_connection_disconnects SET next_attempt_at=now() WHERE result_cose IS NULL`;await p.db.sql`UPDATE federated_connection_outbox SET next_attempt_at=now() WHERE ack_cose IS NULL`;});};
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
    expect(requests.filter(r=>r.path.endsWith("/commit"))).toHaveLength(1); // durable replication recovers the lost committed result
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
    const local=await prepare(c,ac.link);await commit(c,local);await drain(6);
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
    const sends=await one.messaging.sentSends(a.session,null);
    expect(sends.messages).toHaveLength(1);
    expect(sends.messages[0]).toMatchObject({messageId:direct.publicationId,kind:"connections"});
    expect(sends.messages[0]).not.toHaveProperty("recipients");
    expect(sends.messages[0]!.recipientSummary).toEqual({count:2,address:null,did:null});
    const sentDetail=(await one.messaging.sentSends(a.session,null,{id:direct.publicationId,kind:"connections"})).messages;
    expect(sentDetail).toHaveLength(1);
    expect(sentDetail[0]!.recipients).toEqual(expect.arrayContaining([{did:b.did,address:b.address},{did:c.did,address:c.address}]));
    expect(sentDetail[0]!.recipients).toHaveLength(2);
    expect((await one.messaging.sentSends(c.session,null,{id:direct.publicationId,kind:"connections"})).messages).toEqual([]);
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
    await drain(6);
    const refresh=await first.service.prepare(a.session,{requestId:randomUUID(),action:'replace',id:ac.id});await commit(a,refresh);
    const refreshed=(await first.service.list(a.session)).codes.find(code=>code.personal)!;
    const localAgain=await prepare(c,refreshed.link);await commit(c,localAgain);await drain(6);
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
    await drain(6);
    const raceId=(await restarted.status(a.session,race.publicationId,'connections'))!.targets[0]!.messageId;
    expect(await first.db.sql`SELECT message_id FROM delivered_messages WHERE message_id=${raceId}`).toHaveLength(0);
    expect(await first.db.sql`SELECT grant_id FROM grant_lineages`).toHaveLength(0); // independent of subscriptions
    // The same standing invitation can be used by two different local accounts;
    // retained authority must not be stolen by a provider-global digest key.
    const sharedCode=await prepare(c,fresh.link);await commit(c,sharedCode);await drain(6);
    const sharedProof=(await first.db.sql<{digest:Uint8Array;cose:Uint8Array}[]>`SELECT digest,cose FROM connection_proof_signatures WHERE account_id=${a.id} AND digest IN(
      SELECT digest FROM connection_proof_signatures WHERE account_id=${c.id})`);
    expect(sharedProof.length).toBeGreaterThan(0);
    expect(sharedProof.some(r=>inspectConnectionProof(new Uint8Array(r.cose)).payload.type==='hail.connection-invitation')).toBe(true);
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
    await expect(verifyConnectionHistoryAuthority(checkpoint,resolver)).resolves.toBeUndefined();
    const missingAuthority=structuredClone(checkpoint);
    missingAuthority.tables.federated_connection_signatures=missingAuthority.tables.federated_connection_signatures.filter(r=>
      inspectConnectionProof(new Uint8Array(Buffer.from(String(r.cose).slice(2),'hex'))).payload.type==='hail.connection-control');
    await expect(verifyConnectionHistoryAuthority(missingAuthority,resolver)).rejects.toThrow('Missing retained authority');
    expect(checkpoint.tables.federated_connection_tombstones.map(r=>r.connection_id)).toContain(oldId);
    expect(checkpoint.tables.account_connections).toHaveLength(0);
    expect(checkpoint.tables.federated_connection_tombstones.map(r=>r.connection_id)).toContain(localTarget.connectionId);
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
    tables.portable_custody_evidence=[{account_id:a.id,user_recovery_public_key:a.recoveryPublicKey,user_identity_public_key:a.keys.identityDidKey,
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

    // Peer-side barrier proof, not a claim that source cutover orchestration is
    // enabled: source/destination freeze signatures attest a fixed export plan.
    const sharedConnection=(await active(c)).find(r=>r.did===b.did)!,sourceCPrivate=await privateMessaging(c);
    const exchange=new RemoteConnectionReview(first.db.sql,resolver,network,url=>{if(!providers.some(p=>p.origin===url.origin))throw new Error('Unexpected handover target');},first.origin+'/hail');
    const freezePlan=async(moving:User,peer:User)=>{
      const history=await moving.provider.db.sql.begin(async tx=>{await tx`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY`;
        return collectConnectionHistory(tx as SQL,{accountId:moving.id,did:moving.did,sourceGeneration:1,sourceServiceBase:moving.provider.origin+'/hail'},new Date().toISOString());});
      const plan=createConnectionHandoverPlan(history,{transferId:randomUUID(),requestId:uuidV7(),peerDid:peer.did,
        destinationServiceBase:'https://destination.example.com/hail',destinationMessagingKey:d.keys.messagingDidKey,snapshotDigest:new Uint8Array(32).fill(9),issuedAt:Math.floor(Date.now()/1000)});
      const source=await signConnectionHandover(plan,'source-freeze',await privateMessaging(moving)),destination=await signConnectionHandover(plan,'destination-freeze',destinationPrivate);
      return {plan,source,wire:{proposal:encodeSignedRecord(source),destinationSignature:encodeBase64Url(destination.signature)},digest:connectionHandoverPlanDigest(source.payloadBytes)};
    };
    const abortWire=async(frozen:Awaited<ReturnType<typeof freezePlan>>,moving:User,privateKey:CryptoKey)=>{
      const payload:ConnectionHandoverAbort={type:'hail.connection-handover-abort',version:1,request_id:uuidV7(),transfer_id:frozen.plan.transfer_id,
        did:moving.did,peer_did:frozen.plan.peer_did,plan_digest:frozen.digest,issued_at:Math.floor(Date.now()/1000),expires_at:Math.floor(Date.now()/1000)+300};
      const source=await signConnectionHandoverAbort(payload,'source-abort',privateKey),destination=await signConnectionHandoverAbort(payload,'destination-abort',destinationPrivate);
      return {payload,wire:{abort:encodeSignedRecord(source),destinationSignature:encodeBase64Url(destination.signature)}};
    };
    const frozen=await freezePlan(c,b);
    // Queue activation while freeze owns the account lock but has not inserted
    // the barrier yet. The trigger must check the barrier AFTER acquiring that
    // lock, not observe an empty table and later commit a new active epoch.
    let entered!:()=>void,unlock!:()=>void;
    const signingEntered=new Promise<void>(r=>{entered=r;}),continueSigning=new Promise<void>(r=>{unlock=r;});
    const decrypt=second.encryptor.decrypt.bind(second.encryptor),signingGate=vi.spyOn(second.encryptor,'decrypt').mockImplementation(async(...args)=>{
      entered();await continueSigning;return decrypt(...args);});
    lostFreeze=1;const freezeResult=exchange.exchange(b.did,'handover-freeze',frozen.wire).catch(error=>error);
    let activationResult:Promise<unknown>|undefined;
    try{
      await Promise.race([signingEntered,freezeResult.then(()=>{throw new Error('Freeze failed before reaching its signing barrier');})]);
      const tag='handover_activation_'+randomUUID().replaceAll('-','');
      activationResult=second.db.sql.unsafe(`/* ${tag} */ UPDATE federated_connection_pairs SET epoch=epoch+2,connection_id=$1 WHERE account_id=$2 AND peer_did=$3`,
        [uuidV7(),b.id,c.did]).then(()=>null,error=>error);
      let waiting=false;
      for(let i=0;i<500&&!waiting;i++){waiting=(await admin<{waiting:boolean}[]>`SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE query LIKE ${'%'+tag+'%'} AND wait_event_type='Lock') AS waiting`)[0]!.waiting;
        if(!waiting)await Bun.sleep(10);}
      expect(waiting).toBe(true);
    }finally{unlock();signingGate.mockRestore();}
    expect(await freezeResult).toMatchObject({message:'Lost durable freeze reply'});
    expect(await activationResult).toMatchObject({message:'Connection activation is paused for account handover'});
    const restartedPeer=new AccountConnections(second.db.sql,second.encryptor,resolver,second.passkeys,second.origin,
      new RemoteConnectionReview(second.db.sql,resolver,network,()=>{},second.origin+'/hail'));
    const frozenReply=await restartedPeer.federation!.handle('handover-freeze',frozen.wire);
    expect(frozenReply).toMatchObject({phase:'frozen',cutoverAuthorized:false});
    expect(await verifyConnectionHandover(decodeSignedRecord(frozenReply.receipt,65536),'peer-freeze',b.keys.messagingDidKey,Math.floor(Date.now()/1000))).toEqual(frozen.plan);
    const clock=vi.spyOn(Date,'now').mockReturnValue(Date.now()+600000);
    try{
      expect(await restartedPeer.federation!.handle('handover-freeze',frozen.wire)).toMatchObject({phase:'frozen'});
      const expired={...frozen.plan,request_id:uuidV7()},s=await signConnectionHandover(expired,'source-freeze',sourceCPrivate),t=await signConnectionHandover(expired,'destination-freeze',destinationPrivate);
      await expect(restartedPeer.federation!.handle('handover-freeze',{proposal:encodeSignedRecord(s),destinationSignature:encodeBase64Url(t.signature)})).rejects.toThrow('freshness');
    }finally{clock.mockRestore();}
    expect((await second.db.sql<{paused:boolean}[]>`SELECT hail_connection_handover_blocked(${b.did},${c.did}) AS paused`)[0]!.paused).toBe(true);
    expect((await second.db.sql<{paused:boolean}[]>`SELECT hail_connection_handover_blocked(${b.did},${a.did}) AS paused`)[0]!.paused).toBe(false);
    await expect(second.db.sql`UPDATE federated_connection_pairs SET epoch=epoch+2,connection_id=${uuidV7()} WHERE account_id=${b.id} AND peer_did=${c.did}`).rejects.toThrow('activation is paused');
    const held={publicationId:uuidV7(),connections:[sharedConnection.id],text:'Authenticated delivery held during peer handover'};
    await one.publications.createConnections(c.session,held);await withFreshServingGenerations(first.db.sql,()=>one.publications.workOne());await received();
    const heldId=(await one.publications.status(c.session,held.publicationId,'connections'))!.targets[0]!.messageId,readsBeforeFreeze=bodyReads;
    expect((await second.db.sql<{outcome:string}[]>`SELECT outcome FROM received_envelopes WHERE sender_did=${c.did} AND message_id=${heldId}`)[0]!.outcome).toBe('accepted');
    const heldPayload=inspectSignedPayload('hail.envelope',(await one.envelopes.sent(c.did,heldId))!).payload;
    await expect(second.db.sql`INSERT INTO delivered_messages(recipient_did,sender_did,message_id,envelope_digest,body_digest,media_type,profile)
      SELECT ${b.did},${c.did},${heldId},envelope_digest,${heldPayload.body.digest.value},${heldPayload.body.media_type},${heldPayload.body.profile}
      FROM received_envelopes WHERE sender_did=${c.did} AND message_id=${heldId}`).rejects.toThrow('delivery is paused');
    expect(await withFreshServingGenerations(second.db.sql,()=>two.worker.processOne())).toBe('on-hold');expect(bodyReads).toBe(readsBeforeFreeze);
    const release=await abortWire(frozen,c,sourceCPrivate);
    await expect(restartedPeer.federation!.handle('handover-abort',{...release.wire,destinationSignature:(release.wire.abort as {signature:string}).signature})).rejects.toThrow('purpose');
    lostAbort=1;await expect(exchange.exchange(b.did,'handover-abort',release.wire)).rejects.toThrow('Lost durable abort');
    const released=await restartedPeer.federation!.handle('handover-abort',release.wire);
    expect(released).toMatchObject({phase:'released',cutoverAuthorized:false});
    expect(await verifyConnectionHandoverAbort(decodeSignedRecord(released.receipt),'peer-release',b.keys.messagingDidKey,Math.floor(Date.now()/1000))).toEqual(release.payload);
    expect(await restartedPeer.federation!.handle('handover-freeze',frozen.wire)).toMatchObject({phase:'released'});
    await second.db.sql`UPDATE delivery_work SET next_attempt_at=now() WHERE sender_did=${c.did} AND message_id=${heldId}`;
    expect(await withFreshServingGenerations(second.db.sql,()=>two.worker.processOne())).toBe('delivered');

    const racingFreeze=await freezePlan(c,b),racing={publicationId:uuidV7(),connections:[sharedConnection.id],text:'Freeze while fetching the body'};
    await one.publications.createConnections(c.session,racing);await withFreshServingGenerations(first.db.sql,()=>one.publications.workOne());await received();
    const racingId=(await one.publications.status(c.session,racing.publicationId,'connections'))!.targets[0]!.messageId;
    expect(await two.authority.live(b.did,c.did,{type:'connection',connection_id:sharedConnection.id,epoch:1})).toBe(true);
    // Model remote checks which already passed before freeze: final local SQL
    // authorization must still hold the message instead of delivering/rejecting.
    const precheckedStore=new DeliveryRepository(second.db.sql,{async live(){return true;}});
    const handoverRaceWorker=new DeliveryWorker(precheckedStore,{async retrieve(envelope){const result=await two.retriever.retrieve(envelope);
      await exchange.exchange(b.did,'handover-freeze',racingFreeze.wire);return result;}});
    expect(await withFreshServingGenerations(second.db.sql,()=>handoverRaceWorker.processOne())).toBe('on-hold');
    expect(await second.db.sql`SELECT message_id FROM delivered_messages WHERE sender_did=${c.did} AND message_id=${racingId}`).toHaveLength(0);
    const abortRace=await abortWire(racingFreeze,c,sourceCPrivate);
    const movePlc=async(base:string)=>{const state=def.documentData.parse(c.evidence.data),log=c.evidence.log.map(op=>def.compatibleOpOrTombstone.parse(op));
      const next=await signOperation({type:'plc_operation',prev:(await cidForCbor(log.at(-1)!)).toString(),rotationKeys:state.rotationKeys,
        verificationMethods:state.verificationMethods,alsoKnownAs:state.alsoKnownAs,services:{...state.services,hail:{type:'HailMessaging',endpoint:base}}},c.keys.rotationKey);
      const updated=[...log,next],data=(await validateOperationLog(c.did,updated))!;c.evidence={document:formatDidDoc(data),data,log:updated};};
    await movePlc(racingFreeze.plan.destination_service_base);
    await expect(restartedPeer.federation!.handle('handover-abort',abortRace.wire)).rejects.toThrow('committed or changed source');
    await movePlc(first.origin+'/hail'); // append a real return operation, never rewind PLC history
    const closeFrozen=await second.service.prepare(b.session,{requestId:randomUUID(),action:'disconnect',connectionId:sharedConnection.id});await commit(b,closeFrozen);await drain(6);
    expect((await active(b)).some(r=>r.id===sharedConnection.id)).toBe(false);
    await exchange.exchange(b.did,'handover-abort',abortRace.wire);
    const readsAfterDisconnect=bodyReads;await second.db.sql`UPDATE delivery_work SET next_attempt_at=now() WHERE sender_did=${c.did} AND message_id=${racingId}`;
    expect(await withFreshServingGenerations(second.db.sql,()=>two.worker.processOne())).toBe('failed');expect(bodyReads).toBe(readsAfterDisconnect);
    expect(await second.db.sql`SELECT connection_id FROM federated_connection_tombstones WHERE account_id=${b.id} AND connection_id=${sharedConnection.id}`).toHaveLength(1);

    const localFreeze=await freezePlan(a,c);await first.service.federation!.handle('handover-freeze',localFreeze.wire);
    await expect(first.db.sql`UPDATE federated_connection_pairs SET state='active',epoch=epoch+2,connection_id=${uuidV7()} WHERE account_id=${c.id} AND peer_did=${a.did}`).rejects.toThrow('activation is paused');
    const releaseLocal=await abortWire(localFreeze,a,sourcePrivate);await first.service.federation!.handle('handover-abort',releaseLocal.wire);
    await expect(second.db.sql`DELETE FROM connection_handover_barriers WHERE account_id=${b.id}`).rejects.toThrow('cannot be deleted');
    const barrierRollback=await second.db.sql.reserve();try{await expect(barrierRollback.unsafe(await Bun.file(new URL('../migrations/rollback/0068_connection_handover_barriers.sql',import.meta.url)).text())).rejects.toThrow('Retained connection handover barriers');}finally{await barrierRollback.unsafe('ROLLBACK');barrierRollback.release();}
    await expect(first.db.sql`DELETE FROM connection_proof_signatures WHERE account_id=${a.id}`).rejects.toThrow('immutable');
    const proofRollback=await first.db.sql.reserve();try{await expect(proofRollback.unsafe(await Bun.file(new URL('../migrations/rollback/0067_connection_proof_authority.sql',import.meta.url)).text())).rejects.toThrow('Retained connection proof authority');}finally{await proofRollback.unsafe('ROLLBACK');proofRollback.release();}
    await expect(second.db.sql`DELETE FROM connection_handover_preparations WHERE transfer_id=${transferId}`).rejects.toThrow();
    const handoverRollback=await second.db.sql.reserve();try{await expect(handoverRollback.unsafe(await Bun.file(new URL('../migrations/rollback/0066_connection_handover_preparations.sql',import.meta.url)).text())).rejects.toThrow('prevents schema rollback');}finally{await handoverRollback.unsafe('ROLLBACK');handoverRollback.release();}
    const fence=()=>first.db.sql`INSERT INTO provider_migration_fences(did,account_id,transfer_id,destination_service_base,state) VALUES(${a.did},${a.id},${randomUUID()},'https://destination.example.com/hail','fenced')`;
    await expect(fence()).rejects.toThrow("not portable");
    await expect(first.db.sql`INSERT INTO provider_migration_fences(did,account_id,transfer_id,destination_service_base,state) VALUES(${c.did},${c.id},${randomUUID()},'https://destination.example.com/hail','fenced')`).rejects.toThrow("requires portable preservation");
    const messageRollback=await first.db.sql.reserve();try{await expect(messageRollback.unsafe(await Bun.file(new URL("../migrations/rollback/0065_connection_messages.sql",import.meta.url)).text())).rejects.toThrow("Retained connection messages");}finally{await messageRollback.unsafe('ROLLBACK');messageRollback.release();}
    const rollback=await first.db.sql.reserve();try{await expect(rollback.unsafe(await Bun.file(new URL("../migrations/rollback/0064_connection_federation.sql",import.meta.url)).text())).rejects.toThrow("prevents rollback");}finally{await rollback.unsafe("ROLLBACK");rollback.release();}

    // Post-cutover component proof: regular account-transfer signature/owner/
    // monitor ceremonies are covered by the migration fixtures. Here the inert
    // import boundary is seeded, then real PLC, peer RPC and SQL reconstruction
    // are exercised, including both coordinator and noncoordinator relationships.
    const replaceB=await second.service.prepare(b.session,{requestId:randomUUID(),action:'replace',id:fresh.id});await commit(b,replaceB);
    const beforeMoveCode=(await second.service.list(b.session)).codes.find(v=>v.personal)!,beforeMoveLink=code(beforeMoveCode.link);
    for(const user of [a,c,d]){const proposal=await prepare(user,beforeMoveCode.link);await commit(user,proposal);await drain(8);}
    const ab=(await active(b)).find(v=>v.did===a.did)!,cb=(await active(b)).find(v=>v.did===c.did)!,db=(await active(b)).find(v=>v.did===d.did)!;
    const localBefore=(await second.db.sql<{connection_id:string;epoch:number|string}[]>`SELECT connection_id,epoch FROM federated_connection_pairs WHERE account_id=${b.id} AND peer_did=${d.did}`)[0]!;
    expect(db.remote).toBe(false);
    const oldOutgoing={publicationId:uuidV7(),connections:[ab.id],text:'Readable unchanged after moving the sender'};
    await two.publications.createConnections(b.session,oldOutgoing);await withFreshServingGenerations(second.db.sql,()=>two.publications.workOne());await received();
    expect(await withFreshServingGenerations(first.db.sql,()=>one.worker.processOne())).toBe('delivered');
    const oldMessageId=(await two.publications.status(b.session,oldOutgoing.publicationId,'connections'))!.targets[0]!.messageId,
      oldEnvelope=(await two.envelopes.sent(b.did,oldMessageId))!;
    const oldStatus=await one.signer.signCurrent(b.did,oldMessageId),oldPayload=inspectSignedPayload('hail.envelope',oldEnvelope);
    await two.statuses.receive(encodeBase64Url(new Uint8Array(createHash('sha256').update(oldPayload.payloadBytes).digest())),oldStatus!);
    const moveHistory=await second.db.sql.begin(async tx=>{await tx`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY`;
      return collectConnectionHistory(tx as SQL,{accountId:b.id,did:b.did,sourceGeneration:1,sourceServiceBase:second.origin+'/hail'},new Date().toISOString());});
    expect(moveHistory.tables.account_connections).toHaveLength(0);
    const movedKeys=await generateAccountKeys(b.id,third.encryptor),movingTransfer=randomUUID(),movingAddress='moved-b@'+new URL(third.origin).hostname;
    const movedPrivate=async()=>{const k=movedKeys.keys.find(k=>k.role==='hail-messaging')!,raw=await third.encryptor.decrypt(b.id,k.role,k.algorithm,k.publicKey,k);
      try{return await importEd25519PrivateKey(raw);}finally{raw.fill(0);}};
    const plannedPrivate=await movedPrivate(),sourceBPrivate=await privateMessaging(b),moveCapturedAt=moveHistory.capturedAt;
    const moveTables=Object.fromEntries(MANAGED_TRANSFER_TABLES.map(t=>[t,[] as Record<string,unknown>[]])) as ManagedTransferManifest['tables'];
    const collectRows=async(table:string,where:string,values:unknown[])=>
      (await second.db.sql.unsafe<{row:Record<string,unknown>}[]>(`SELECT to_jsonb(t) AS row FROM "${table}" t WHERE ${where}`,values)).map(r=>r.row);
    moveTables.provider_accounts=await collectRows('provider_accounts','id=$1',[b.id]);
    moveTables.account_keys=b.keys.keys.map(k=>({account_id:b.id,role:k.role,public_key:k.publicKey}));
    moveTables.managed_custody_evidence=[{account_id:b.id,owner_recovery_public_key:b.recoveryPublicKey,provider_identity_public_key:b.keys.identityDidKey,
      verification_mode:'poc-local',managed_profile_version:'hail-managed-custody-v1'}];
    for(const table of ['detached_bodies','body_authorizations','sent_envelopes'] as const)moveTables[table]=await collectRows(table,'sender_account_id=$1',[b.id]);
    moveTables.sent_delivery_status=await collectRows('sent_delivery_status','sender_did=$1',[b.did]);
    const moveBase={version:6 as const,transferId:movingTransfer,did:b.did,accountId:b.id,sourceServiceBase:second.origin+'/hail',destinationServiceBase:third.origin+'/hail',
      ownerRecoveryPublicKey:b.recoveryPublicKey,sourceIdentityPublicKey:b.keys.identityDidKey,destinationRotationPublicKey:movedKeys.rotationDidKey,
      destinationIdentityPublicKey:movedKeys.identityDidKey,destinationMessagingPublicKey:movedKeys.messagingDidKey,sourceGeneration:1,custodyProfile:'managed' as const,capturedAt:moveCapturedAt,
      connections:moveHistory,connectionCheckpointDigest:encodeBase64Url(connectionHistoryDigest(moveHistory)),tables:moveTables};
    const movingManifest:ManagedTransferManifest={...moveBase,historyCheckpointDigest:encodeBase64Url(managedHistoryCheckpoint(moveBase))},movingBytes=new TextEncoder().encode(JSON.stringify(movingManifest)),
      movingDigest=new Uint8Array(createHash('sha256').update(movingBytes).digest()),binding=await signPayload('hail.address-binding',{type:'hail.address-binding',version:1,did:b.did,address:movingAddress,
        issued_at:Math.floor(Date.now()/1000),expires_at:Math.floor(Date.now()/1000)+86400,key_id:b.did+'#hail-identity'},createWebCryptoSigner(b.did+'#hail-identity',movedKeys.identityPrivateKey)),
      bindingDigest=new Uint8Array(createHash('sha256').update(binding).digest()),sourceSnapshotSignature=new Uint8Array(await crypto.subtle.sign('Ed25519',sourceBPrivate,managedSnapshotSignatureInput(movingDigest,6)));
    validateManagedTransferManifest(movingBytes);
    await third.db.sql`INSERT INTO pending_migration_imports(transfer_id,did,source_service_base,destination_service_base,manifest_bytes,manifest_digest,source_messaging_public_key,
      signature,state,verified_plc_document,verified_plc_data,verified_plc_operation_log,destination_address,destination_binding_cose,destination_binding_digest,custody_profile,
      owner_recovery_public_key,source_identity_public_key,destination_identity_public_key) VALUES(${movingTransfer},${b.did},${movingManifest.sourceServiceBase},${movingManifest.destinationServiceBase},
      ${movingBytes},${movingDigest},${b.keys.messagingDidKey},${sourceSnapshotSignature},'staged','{}','{}','[]',${movingAddress},${binding},${bindingDigest},'managed',${b.recoveryPublicKey},${b.keys.identityDidKey},${movedKeys.identityDidKey})`;
    const movedStack=stack(third),reconstruction=new ConnectionReconstruction(third.db.sql,resolver,
      new RemoteConnectionReview(third.db.sql,resolver,network,()=>{},third.origin+'/hail'),third.origin+'/hail',third.service.federation);
    const plans=new Map<string,{plan:ReturnType<typeof createConnectionHandoverPlan>;digest:Uint8Array;commit?:Awaited<ReturnType<typeof signConnectionHandoverTransition>>}>();
    for(const peer of [a,c,d]){
      const plan=createConnectionHandoverPlan(moveHistory,{transferId:movingTransfer,requestId:uuidV7(),peerDid:peer.did,destinationServiceBase:third.origin+'/hail',
        destinationMessagingKey:movedKeys.messagingDidKey,snapshotDigest:movingDigest,issuedAt:Math.floor(Date.now()/1000)}),source=await signConnectionHandover(plan,'source-freeze',sourceBPrivate),
        destination=await signConnectionHandover(plan,'destination-freeze',plannedPrivate),wire={proposal:encodeSignedRecord(source),destinationSignature:encodeBase64Url(destination.signature)};
      expect(await reconstruction.acceptFreeze(wire)).toMatchObject({phase:'frozen'});expect(await reconstruction.acceptFreeze(wire)).toMatchObject({phase:'frozen'});
      plans.set(peer.did,{plan,digest:connectionHandoverPlanDigest(source.payloadBytes)});
    }
    const transition=async(peer:User,action:'commit'|'complete',activation?:Awaited<ReturnType<typeof signActivationReceipt>>)=>{
      const held=plans.get(peer.did)!,payload:ConnectionHandoverTransition={type:'hail.connection-handover-transition',version:1,action,request_id:uuidV7(),transfer_id:movingTransfer,
        did:b.did,peer_did:peer.did,plan_digest:held.digest,binding_digest:bindingDigest,activation_digest:activation?connectionActivationDigest(activation):null,
        issued_at:Math.floor(Date.now()/1000),expires_at:Math.floor(Date.now()/1000)+300};return signConnectionHandoverTransition(payload,plannedPrivate);};
    const premature=await transition(a,'commit');
    await expect(first.service.federation!.handle('handover-commit',{command:encodeSignedRecord(premature),binding:encodeBase64Url(binding)})).rejects.toThrow('PLC has not authorized');
    const oldBState=def.documentData.parse(b.evidence.data),bLog=b.evidence.log.map(op=>def.compatibleOpOrTombstone.parse(op)),cutover=await signOperation({type:'plc_operation',prev:(await cidForCbor(bLog.at(-1)!)).toString(),
      rotationKeys:[b.recoveryPublicKey,movedKeys.rotationDidKey],verificationMethods:{...oldBState.verificationMethods,'hail-identity':movedKeys.identityDidKey,'hail-messaging':movedKeys.messagingDidKey},
      alsoKnownAs:oldBState.alsoKnownAs,services:{...oldBState.services,hail:{type:'HailMessaging',endpoint:third.origin+'/hail'}}},b.recoveryKey),nextLog=[...bLog,cutover],nextState=(await validateOperationLog(b.did,nextLog))!;
    b.evidence={document:formatDidDoc(nextState),data:nextState,log:nextLog};
    const postExchange=new RemoteConnectionReview(third.db.sql,resolver,network,()=>{},third.origin+'/hail');
    const restartedFirst=new AccountConnections(first.db.sql,first.encryptor,resolver,first.passkeys,first.origin,new RemoteConnectionReview(first.db.sql,resolver,network,()=>{},first.origin+'/hail'));
    for(const peer of [a,c,d]){
      const signed=await transition(peer,'commit');plans.get(peer.did)!.commit=signed;
      const wire={command:encodeSignedRecord(signed),binding:encodeBase64Url(binding)};
      if(peer===a){lostPostCommit=1;await expect(postExchange.exchange(peer.did,'handover-commit',wire)).rejects.toThrow('Lost post-cutover');}
      const peerService=peer.provider===first?restartedFirst:peer.provider.service;
      const reply=await peerService.federation!.handle('handover-commit',wire);
      expect(reply).toMatchObject({phase:'committed'});
      expect(await peerService.federation!.handle('handover-commit',wire)).toEqual(reply);
      const result=await verifyConnectionHandoverResult(decodeSignedRecord(reply.receipt,65536),peer.keys.messagingDidKey);expect(result.phase).toBe('committed');
      const lateReceipt=peer===a?vi.spyOn(Date,'now').mockReturnValue(Date.now()+360000):null;
      try{expect(await reconstruction.acceptTransition({command:encodeSignedRecord(signed),receipt:reply.receipt})).toMatchObject({phase:'committed'});}
      finally{lateReceipt?.mockRestore();}
      const pair=(await peer.provider.db.sql<{connection_id:string;peer_service_base:string}[]>`SELECT connection_id,peer_service_base FROM federated_connection_pairs WHERE account_id=${peer.id} AND peer_did=${b.did}`)[0]!;
      expect(pair.peer_service_base).toBe(third.origin+'/hail');expect(pair.connection_id).toBe(peer===a?ab.id:peer===c?cb.id:db.id);
      expect((await peer.provider.db.sql<{paused:boolean}[]>`SELECT hail_connection_handover_blocked(${peer.did},${b.did}) AS paused`)[0]!.paused).toBe(true);
    }
    const disconnectDuringCommit=await first.service.prepare(a.session,{requestId:randomUUID(),action:'disconnect',connectionId:ab.id});
    await commit(a,disconnectDuringCommit);await drain(2);
    await third.db.sql.begin(async tx=>{
      portabilityStage='base materialization';
      await tx`SELECT set_config('hail.managed_migration',${b.id},true)`;
      await tx`INSERT INTO provider_accounts(id,tenant_id,canonical_address,did,onboarding_state,activated_at,activation_binding_digest,activation_verification_mode)
        VALUES(${b.id},${randomUUID()},${movingAddress},${b.did},'active',now(),${bindingDigest},'public')`;
      await tx`UPDATE account_serving_generations SET generation=2 WHERE account_id=${b.id}`;
      await tx`SELECT set_config('hail.admitted_generations',${JSON.stringify({[b.id]:2})},true)`;
      for(const key of movedKeys.keys)await tx`INSERT INTO account_keys(account_id,role,algorithm,public_key,encrypted_private_key,encryption_nonce,encryption_version,kek_id)
        VALUES(${b.id},${key.role},${key.algorithm},${key.publicKey},${key.ciphertext},${key.nonce},1,'poc-v1')`;
      await tx`INSERT INTO managed_custody_evidence(account_id,owner_recovery_public_key,provider_identity_public_key,verification_mode,managed_profile_version)
        VALUES(${b.id},${b.recoveryPublicKey},${movedKeys.identityDidKey},'poc-local','hail-managed-custody-v1')`;
      await tx`INSERT INTO address_bindings(id,account_id,canonical_address,did,cose,representation_digest,issued_at,expires_at,selected_at,published_at,hosted_at)
        VALUES(${uuidV7()},${b.id},${movingAddress},${b.did},${binding},${bindingDigest},now(),now()+interval '1 day',now(),now(),now())`;
      for(const table of ['detached_bodies','body_authorizations','sent_envelopes','sent_delivery_status'] as const)for(const row of moveTables[table])
        await tx.unsafe(`INSERT INTO "${table}" SELECT * FROM jsonb_populate_record(NULL::"${table}",($1::text)::jsonb)`,[JSON.stringify(row)]);
      portabilityStage='connection reconstruction';await reconstructConnections(tx as SQL,movingManifest,2);
      await tx`UPDATE pending_migration_imports SET state='active',activated_at=now() WHERE transfer_id=${movingTransfer}`;
    });
    const oldBToken=b.token;
    portabilityStage='post reconstruction checks';
    b.provider=third;b.keys=movedKeys;b.address=movingAddress;
    expect(await movedStack.envelopes.sent(b.did,oldMessageId)).toEqual(oldEnvelope);
    expect(await third.db.sql`SELECT id FROM connection_invitations WHERE account_id=${b.id}`).toHaveLength(0);
    await expect(third.service.exportInvitation(beforeMoveLink)).rejects.toThrow();await expect(second.service.exportInvitation(beforeMoveLink)).rejects.toThrow();
    await expect(movedStack.authority.live(b.did,a.did,{type:'connection',connection_id:ab.id,epoch:5})).rejects.toThrow('paused');
    const activation=await signActivationReceipt({type:'hail.portable-migration-activated',version:1,did:b.did,transfer_id:movingTransfer,snapshot_digest:movingDigest,
      destination_service_base:third.origin+'/hail',destination_messaging_key:movedKeys.messagingDidKey,destination_address:movingAddress,address_binding_digest:bindingDigest,activated_at:Math.floor(Date.now()/1000)},plannedPrivate);
    for(const peer of [a,c,d]){
      portabilityStage='final peer completion';
      const signed=await transition(peer,'complete',activation),wire={command:encodeSignedRecord(signed),binding:encodeBase64Url(binding),activation:encodeSignedRecord(activation)};
      if(peer===a){lostCompletion=1;await expect(postExchange.exchange(peer.did,'handover-complete',wire)).rejects.toThrow('Lost final handover');}
      const peerService=peer.provider===first?restartedFirst:peer.provider.service;
      const reply=await peerService.federation!.handle('handover-complete',wire);
      expect(reply).toMatchObject({phase:'completed'});expect(await peerService.federation!.handle('handover-complete',wire)).toEqual(reply);
      expect(await reconstruction.acceptTransition({command:encodeSignedRecord(signed),receipt:reply.receipt,activation:encodeSignedRecord(activation)})).toMatchObject({phase:'completed'});
    }
    expect((await third.db.sql<{paused:boolean}[]>`SELECT hail_connection_handover_blocked(${b.did},${a.did}) AS paused`)[0]!.paused).toBe(false);
    portabilityStage='post completion authority';
    expect(await movedStack.authority.live(b.did,a.did,{type:'connection',connection_id:ab.id,epoch:5})).toBe(false);
    expect(await movedStack.authority.live(b.did,c.did,{type:'connection',connection_id:cb.id,epoch:3})).toBe(true);
    const localAfter=(await third.db.sql<{connection_id:string;epoch:number|string}[]>`SELECT connection_id,epoch FROM federated_connection_pairs WHERE account_id=${b.id} AND peer_did=${d.did}`)[0]!;
    expect(localAfter).toEqual(localBefore); // Same model/ID/epoch, now on different providers.
    expect(await movedStack.authority.live(b.did,d.did,{type:'connection',connection_id:db.id,epoch:Number(localBefore.epoch)})).toBe(true);
    expect(await third.accounts.authenticate(undefined,oldBToken)).toBeNull();
    const device=generateKeyPairSync('ec',{namedCurve:'prime256v1'}),deviceJwk=device.publicKey.export({format:'jwk'}),deviceId=encodeBase64Url(randomBytes(32)),
      deviceCose=Buffer.concat([Buffer.from('a5010203262001215820','hex'),Buffer.from(deviceJwk.x!,'base64url'),Buffer.from('225820','hex'),Buffer.from(deviceJwk.y!,'base64url')]);
    const movedSession=await withFreshServingGenerations(third.db.sql,async()=>{
    portabilityStage='fresh enrollment';
    await third.db.sql`INSERT INTO account_passkeys(credential_id,account_id,serving_generation,public_key,device_type,backed_up,label) VALUES(${deviceId},${b.id},2,${deviceCose},'singleDevice',false,'Fresh destination enrollment')`;
    let newCounter=0;b.assertion=(challenge:string)=>{const client=Buffer.from(JSON.stringify({type:'webauthn.get',challenge,origin:third.origin})),auth=Buffer.alloc(37);
      createHash('sha256').update(new URL(third.origin).hostname).digest().copy(auth);auth[32]=5;auth.writeUInt32BE(++newCounter,33);
      return {id:deviceId,rawId:deviceId,type:'public-key',clientExtensionResults:{},response:{clientDataJSON:client.toString('base64url'),authenticatorData:auth.toString('base64url'),
        signature:sign('sha256',Buffer.concat([auth,createHash('sha256').update(client).digest()]),device.privateKey).toString('base64url'),userHandle:Buffer.from(b.id.replaceAll('-',''),'hex').toString('base64url')}};};
    const newLogin=await third.passkeys.authenticationOptions(),newLogged=await third.passkeys.authenticate(newLogin.challengeId,b.assertion(newLogin.options.challenge));
    const session=(await third.accounts.authenticate(undefined,newLogged.token))!;b.session=session;b.token=newLogged.token;
    expect(session.serving_generation).toBe(2);
    const newCode=await create(b);expect(newCode.id).not.toBe(beforeMoveCode.id);expect(new URL(newCode.link).origin).toBe(third.origin);
    return session;
    });
    portabilityStage='moved messaging';
    expect(await movedStack.messaging.sentMessage(movedSession,oldMessageId)).toMatchObject({state:'delivered'});
    await drain(6);
    const currentNewCode=(await withFreshServingGenerations(third.db.sql,()=>third.service.list(b.session))).codes.find(v=>v.personal)!;
    const reconnectAfterMove=await prepare(a,currentNewCode.link);await commit(a,reconnectAfterMove);await drain(8);
    const abAfterMove=(await active(a)).find(v=>v.did===b.did)!;
    expect(abAfterMove.id).not.toBe(ab.id);
    expect(await movedStack.authority.live(b.did,a.did,{type:'connection',connection_id:ab.id,epoch:5})).toBe(false);
    const afterMove={publicationId:uuidV7(),connections:[abAfterMove.id,cb.id,db.id],text:'New provider, standing permission and explicit reconnect'};
    await withFreshServingGenerations(third.db.sql,()=>movedStack.publications.createConnections(movedSession,afterMove));
    for(let i=0;i<3;i++)await withFreshServingGenerations(third.db.sql,()=>movedStack.publications.workOne());
    for(let i=0;i<500&&(one.schedule.inFlight||two.schedule.inFlight);i++)await Bun.sleep(10);
    expect(await withFreshServingGenerations(first.db.sql,()=>one.worker.processOne())).toBe('delivered');
    expect(await withFreshServingGenerations(first.db.sql,()=>one.worker.processOne())).toBe('delivered');
    expect(await withFreshServingGenerations(second.db.sql,()=>two.worker.processOne())).toBe('delivered');
    const afterHistory=await third.db.sql.begin(async tx=>collectConnectionHistory(tx as SQL,{accountId:b.id,did:b.did,sourceGeneration:2,sourceServiceBase:third.origin+'/hail'},new Date().toISOString()));
    await expect(verifyConnectionHistoryAuthority(afterHistory,resolver)).resolves.toBeUndefined();
    const reconstructionRollback=await third.db.sql.reserve();try{await expect(reconstructionRollback.unsafe(await Bun.file(new URL('../migrations/rollback/0069_connection_reconstruction.sql',import.meta.url)).text())).rejects.toThrow('Retained connection reconstruction');}finally{await reconstructionRollback.unsafe('ROLLBACK');reconstructionRollback.release();}

    // Full managed move: no seeded fence, import, prepared keys or account. Real
    // owner approvals drive source fencing/export, all peer holds, PLC submission,
    // account materialization, release and authenticated source retirement.
    { portabilityStage='end-to-end source orchestration';
    const managedResolver=new PrivatePocManagedResolver(resolver),targetBase=second.origin+'/hail',sourceBase=first.origin+'/hail';
    const finalSourceStack=stack(first),finalTargetStack=stack(second);
    const allowed=(url:URL)=>{if(!providers.some(p=>p.origin===url.origin))throw new Error('Unapproved transfer target');};
    const sourceOrchestration=new ConnectionTransferOrchestration(first.db.sql,first.encryptor,resolver,sourceBase,network,allowed,first.service.federation),
      targetOrchestration=new ConnectionTransferOrchestration(second.db.sql,second.encryptor,resolver,targetBase,network,allowed,second.service.federation),
      targetKeys=new PreparedMigrationTarget(second.db.sql,second.encryptor,targetBase),sourceAccounts=new OnboardingRepository(first.db.sql),
      sourceFence=new ManagedMigrationFenceService(first.db.sql,managedResolver,sourceBase,undefined,'poc-local');
    registerConnectionSourceRoutes(first.app,sourceOrchestration);
    registerManagedTransferRoutes(first.app,undefined,undefined,undefined,undefined,sourceFence);
    registerManagedTransferRoutes(second.app,new ManagedTransferInvitationReceiver(second.db.sql,managedResolver,targetKeys));
    const preservedCode=await create(c);
    const colocatedBeforeMove=await prepare(a,preservedCode.link);await commit(a,colocatedBeforeMove);await drain(6);
    for(const cancelling of [true,false]){
    const stamp=Math.floor(Date.now()/1000),grant:ManagedTransferGrant={type:'hail.managed-transfer-grant',version:1,did:c.did,nonce:randomUUID(),source_service_base:sourceBase,
      destination_service_base:targetBase,destination_domain:new URL(second.origin).hostname,owner_recovery_key:c.recoveryPublicKey,source_identity_key:c.keys.identityDidKey,issued_at:stamp,expires_at:stamp+3600};
    const ownerSign=async(value:ManagedTransferGrant|ManagedTransferAddressSelection|ManagedTransferApproval)=>{const payloadBytes=encodeManagedHandshake(value);
      return {payloadBytes,signature:await c.recoveryKey.sign(managedHandshakeSignatureInput(value.type,payloadBytes))};};
    const signedGrant=await ownerSign(grant);
    await new ManagedTransferAuthorization(first.db.sql,managedResolver,sourceBase,sourceAccounts,first.encryptor).authorize(signedGrant);
    const offered=await new ManagedTransferDelivery(first.db.sql,managedResolver,sourceBase,network,allowed).deliver(c.did),offer=decodeDeterministic(offered.payloadBytes) as any;
    const selection:ManagedTransferAddressSelection={type:'hail.managed-transfer-address-selection',version:1,did:c.did,nonce:grant.nonce,transfer_id:offer.transfer_id,
      grant_digest:managedHandshakeDigest(signedGrant.payloadBytes),offer_digest:managedHandshakeDigest(offered.payloadBytes),address:'moved-c@second.example.com',selection_nonce:randomUUID(),issued_at:stamp,expires_at:stamp+1800};
    const selected=await ownerSign(selection);
    await new ManagedTransferAddressReservation(second.db.sql,managedResolver,targetKeys).reserve(selected);
    await new ManagedTransferFencePublisher(second.db.sql,managedResolver,targetKeys,network,allowed).publish(offer.transfer_id);
    const exactFence=(await sourceFence.get(c.did))!;
    const exported=await new ManagedMigrationExportService(first.db.sql,sourceAccounts,first.encryptor,managedResolver,sourceBase,undefined,'poc-local').exportFenced(exactFence),
      exactManifest=validateManagedTransferManifest(exported.bytes),beforeConnections=exactManifest.connections!.tables.federated_connection_pairs.map(p=>({peer:p.peer_did,id:p.connection_id,epoch:Number(p.epoch)}));
    const sourceState=def.documentData.parse(c.evidence.data),previous=(await cidForCbor(c.evidence.log.at(-1) as any)).toString(),operation=await signOperation({type:'plc_operation',prev:previous,
      rotationKeys:[c.recoveryPublicKey,offer.destination_rotation_key],verificationMethods:{...sourceState.verificationMethods,'hail-identity':offer.destination_identity_key,'hail-messaging':offer.destination_messaging_key},
      alsoKnownAs:sourceState.alsoKnownAs,services:{...sourceState.services,hail:{type:'HailMessaging',endpoint:targetBase}}},c.recoveryKey),operationCid=(await cidForCbor(operation)).toString(),
      operationBytes=new TextEncoder().encode(JSON.stringify(operation));
    const ownerApproval=await ownerSign({type:'hail.managed-transfer-approval',version:1,did:c.did,nonce:grant.nonce,transfer_id:offer.transfer_id,source_service_base:sourceBase,
      destination_service_base:targetBase,destination_address:selection.address,owner_recovery_key:c.recoveryPublicKey,source_identity_key:c.keys.identityDidKey,
      destination_rotation_key:offer.destination_rotation_key,destination_identity_key:offer.destination_identity_key,destination_messaging_key:offer.destination_messaging_key,
      grant_digest:managedHandshakeDigest(signedGrant.payloadBytes),offer_digest:managedHandshakeDigest(offered.payloadBytes),selection_digest:managedHandshakeDigest(selected.payloadBytes),
      snapshot_version:6,snapshot_digest:exported.digest,history_checkpoint_digest:decodeBase64Url(exactManifest.historyCheckpointDigest),source_generation:1,
      previous_operation_cid:previous,operation_cid:operationCid,issued_at:stamp,expires_at:stamp+900});
    let plcWrites=0;
    const plc={async getOperationLog(){return c.evidence.log as any;},async sendOperation(_did:string,op:any){plcWrites++;const log=[...c.evidence.log,op] as any;
      const data=(await validateOperationLog(c.did,log))!;c.evidence={document:formatDidDoc(data),data,log};throw new Error('Lost actual PLC cutover reply');}};
    const stager=new ManagedMigrationStageService(second.db.sql,managedResolver,targetKeys,targetBase,undefined,'poc-local');
    const addressVerifier={async verify(address:string){const row=(await second.db.sql<{destination_binding_cose:Uint8Array;destination_binding_digest:Uint8Array}[]>`
      SELECT destination_binding_cose,destination_binding_digest FROM pending_migration_imports WHERE transfer_id=${offer.transfer_id}`)[0]!,state=await managedResolver.resolve(c.did);
      const binding=inspectSignedPayload('hail.address-binding',new Uint8Array(row.destination_binding_cose)).payload;
      return {address,did:c.did,serviceBase:targetBase,identityDidKey:offer.destination_identity_key,messagingDidKey:offer.destination_messaging_key,plcEvidence:state.evidence,verifiedAt:new Date(),
        binding,representation:new Uint8Array(row.destination_binding_cose),digest:new Uint8Array(row.destination_binding_digest)};}};
    const actualActivation=new ManagedMigrationActivation(second.db.sql,second.encryptor,managedResolver,addressVerifier,targetBase,'http://plc.fixture:2582','poc-local');
    const actualCompletion=()=>new ManagedMigrationCompletion(stager,new ManagedMigrationPlcSubmission(second.db.sql,plc,managedResolver,targetBase),actualActivation,false,
      new ConnectionTransferOrchestration(second.db.sql,second.encryptor,resolver,targetBase,network,allowed,second.service.federation));
    const completionInput={snapshot:{type:'hail.managed-migration-transfer',version:6,manifest:encodeBase64Url(exported.bytes),digest:encodeBase64Url(exported.digest),signature:encodeBase64Url(exported.signature),sourceMessagingPublicKey:exported.sourceMessagingPublicKey},
      approval:encodeSignedRecord(ownerApproval),operation:encodeBase64Url(operationBytes)};
    lostFreeze=1;
    await expect(withFreshServingGenerations(second.db.sql,()=>actualCompletion().complete(completionInput))).rejects.toThrow();
    expect(plcWrites).toBe(0);expect((await sourceFence.get(c.did))!.state).toBe('exported');
    expect(await second.db.sql`SELECT id FROM provider_accounts WHERE id=${c.id}`).toHaveLength(0);
    if(cancelling){
      // Administrative aborts can reach an already-fenced peer (simultaneous
      // moves). New terminal evidence invalidates its old export for cutover,
      // but must not prevent that peer from cancelling its own move.
      const otherPlan=createConnectionHandoverPlan(checkpoint,{transferId:randomUUID(),requestId:uuidV7(),peerDid:c.did,destinationServiceBase:'https://elsewhere.example.com/hail',
        destinationMessagingKey:d.keys.messagingDidKey,snapshotDigest:new Uint8Array(32),issuedAt:Math.floor(Date.now()/1000)}),otherSource=await signConnectionHandover(otherPlan,'source-freeze',sourcePrivate),
        otherDestination=await signConnectionHandover(otherPlan,'destination-freeze',destinationPrivate),otherAbort:ConnectionHandoverAbort={type:'hail.connection-handover-abort',version:1,request_id:uuidV7(),
          transfer_id:otherPlan.transfer_id,did:a.did,peer_did:c.did,plan_digest:connectionHandoverPlanDigest(otherSource.payloadBytes),issued_at:Math.floor(Date.now()/1000),expires_at:Math.floor(Date.now()/1000)+300};
      const otherReleased=await first.service.federation.handle('handover-abort',{proposal:encodeSignedRecord(otherSource),freezeDestinationSignature:encodeBase64Url(otherDestination.signature),
        abort:encodeSignedRecord(await signConnectionHandoverAbort(otherAbort,'source-abort',sourcePrivate)),destinationSignature:encodeBase64Url((await signConnectionHandoverAbort(otherAbort,'destination-abort',destinationPrivate)).signature)});
      expect(otherReleased).toMatchObject({phase:'released'});
      await expect(actualCompletion().complete(completionInput)).rejects.toThrow();expect(plcWrites).toBe(0);
      const payloadBytes=encodeDeterministic({type:'hail.connection-transfer-cancellation',version:1,did:c.did,transfer_id:offer.transfer_id,snapshot_digest:exported.digest,
        source_service_base:sourceBase,destination_service_base:targetBase,issued_at:stamp,expires_at:stamp+900}),cancellation={payloadBytes,signature:await c.recoveryKey.sign(connectionCancellationInput('owner-cancel',payloadBytes))};
      await expect(targetOrchestration.abort(encodeSignedRecord({...cancellation,signature:new Uint8Array(64)}))).rejects.toThrow();
      lostAbort=1;await expect(targetOrchestration.abort(encodeSignedRecord(cancellation))).rejects.toThrow('Lost durable abort');
      await expect(actualCompletion().complete(completionInput)).rejects.toThrow();expect(plcWrites).toBe(0);
      const resumed=new ConnectionTransferOrchestration(second.db.sql,second.encryptor,resolver,targetBase,network,allowed,second.service.federation);
      expect(await resumed.abort(encodeSignedRecord(cancellation))).toMatchObject({phase:'cancelled'});
      expect(await resumed.abort(encodeSignedRecord(cancellation))).toMatchObject({phase:'cancelled'});
      expect(await sourceFence.get(c.did)).toBeNull();
      expect(await first.service.exportInvitation(code(preservedCode.link))).toMatchObject({type:'hail.connection-review'});
      expect((await first.db.sql<{kind:string;authorization:unknown}[]>`SELECT jsonb_typeof(archive) AS kind,archive->'authorization' AS authorization FROM connection_transfer_aborts WHERE transfer_id=${offer.transfer_id}`)[0]!).toMatchObject({kind:'object',authorization:{did:c.did,nonce:grant.nonce}});
      await expect(new ManagedTransferAuthorization(first.db.sql,managedResolver,sourceBase,sourceAccounts,first.encryptor).authorize(signedGrant)).rejects.toThrow('cancelled');
      const afterAbort=await first.db.sql.begin(tx=>collectConnectionHistory(tx as SQL,{accountId:c.id,did:c.did,sourceGeneration:1,sourceServiceBase:sourceBase},new Date().toISOString()));
      expect(afterAbort.tables.connection_transfer_aborts).toHaveLength(1);await verifyConnectionHistoryAuthority(afterAbort,resolver);
      const forgedAbortHistory=structuredClone(afterAbort);forgedAbortHistory.tables.connection_transfer_aborts[0]!.destination_signature='\\x'+'00'.repeat(64);
      await expect(verifyConnectionHistoryAuthority(forgedAbortHistory,resolver)).rejects.toThrow('signature');
      continue;
    }
    await targetOrchestration.freeze(offer.transfer_id);
    const expiredOwner=vi.spyOn(Date,'now').mockReturnValue(Date.now()+1000000);
    try{await expect(new ManagedMigrationPlcSubmission(second.db.sql,plc,managedResolver,targetBase).submit(offer.transfer_id)).rejects.toThrow('owner approval expired');expect(plcWrites).toBe(0);}
    finally{expiredOwner.mockRestore();}
    const completedMove=await withFreshServingGenerations(second.db.sql,()=>actualCompletion().complete(completionInput));
    expect(completedMove).toMatchObject({phase:'active',did:c.did,accountId:c.id,generation:2});expect(plcWrites).toBe(1);
    expect((await sourceFence.get(c.did))!.state).toBe('retired');
    expect(await first.db.sql`SELECT id FROM connection_invitations WHERE account_id=${c.id} AND revoked_at IS NULL`).toHaveLength(0);
    const restored=await second.db.sql<{peer_did:string;connection_id:string;epoch:number|string}[]>`SELECT peer_did,connection_id,epoch FROM federated_connection_pairs WHERE account_id=${c.id}`;
    expect(restored.map(p=>({peer:p.peer_did,id:p.connection_id,epoch:Number(p.epoch)})).sort((x,y)=>String(x.peer).localeCompare(String(y.peer))))
      .toEqual(beforeConnections.sort((x,y)=>String(x.peer).localeCompare(String(y.peer))));
    expect(await withFreshServingGenerations(second.db.sql,()=>actualCompletion().complete(completionInput))).toEqual(completedMove);expect(plcWrites).toBe(1);
    expect(await withFreshServingGenerations(second.db.sql,()=>two.authority.live(c.did,b.did,{type:'connection',connection_id:cb.id,epoch:3}))).toBe(true);
    const formerlyLocal=restored.find(p=>p.peer_did===a.did)!;
    const afterRetirement=await Promise.allSettled([
      withFreshServingGenerations(first.db.sql,()=>finalSourceStack.authority.live(a.did,c.did,{type:'connection',connection_id:formerlyLocal.connection_id,epoch:Number(formerlyLocal.epoch)})),
      withFreshServingGenerations(first.db.sql,()=>first.db.sql.begin(tx=>connectionMessageAllowed(tx as SQL,a.did,c.did,{type:'connection',connection_id:formerlyLocal.connection_id,epoch:Number(formerlyLocal.epoch)},true))),
    ]);
    expect(afterRetirement.map(result=>result.status==='fulfilled'?result.value:String(result.reason))).toEqual([true,true]);
    for(const row of exactManifest.tables.sent_envelopes)expect(await finalTargetStack.envelopes.sent(c.did,String(row.message_id))).toEqual(new Uint8Array(Buffer.from(String(row.envelope_cose).slice(2),'hex')));
    const enrollmentToken='hailp_'+encodeBase64Url(randomBytes(32)),access=new AccountAccess(second.db.sql,resolver,second.origin),accessChallenge=await withFreshServingGenerations(second.db.sql,()=>access.prepare({
      did:c.did,signer:'owner-recovery',publicKey:c.recoveryPublicKey,scopes:['credentials:write'],tokenHash:encodeBase64Url(new Uint8Array(createHash('sha256').update(enrollmentToken).digest())),purpose:'passkey-enrollment'}));
    await withFreshServingGenerations(second.db.sql,async()=>access.complete(accessChallenge.challengeId,enrollmentToken,encodeBase64Url(await c.recoveryKey.sign(accountAccessInput(accessChallenge)))));
    const authenticator=virtualPasskey();
    const enrolledSession=await withFreshServingGenerations(second.db.sql,async()=>{
      const options=await second.passkeys.recoveryOptions(enrollmentToken);await second.passkeys.recover(enrollmentToken,options.challengeId,authenticator.registration(options.options.challenge,new URL(second.origin).hostname,second.origin),'Moved account');
      const login=await second.passkeys.authenticationOptions(),session=await second.passkeys.authenticate(login.challengeId,authenticator.authentication(login.options.challenge,new URL(second.origin).hostname,second.origin));
      return (await second.accounts.authenticate(undefined,session.token))!;
    });
    const resumedBatch={publicationId:uuidV7(),connections:[cb.id,formerlyLocal.connection_id],text:'Message after the complete account transfer'};
    await withFreshServingGenerations(second.db.sql,()=>finalTargetStack.publications.createConnections(enrolledSession,resumedBatch));
    for(let i=0;i<2;i++)await withFreshServingGenerations(second.db.sql,()=>finalTargetStack.publications.workOne());
    for(let i=0;i<500&&(movedStack.schedule.inFlight||finalSourceStack.schedule.inFlight);i++)await Bun.sleep(10);
    expect(await withFreshServingGenerations(third.db.sql,()=>movedStack.worker.processOne())).toBe('delivered');
    expect(await withFreshServingGenerations(first.db.sql,()=>finalSourceStack.worker.processOne())).toBe('delivered');
    const resumedId=(await finalTargetStack.publications.status(enrolledSession,resumedBatch.publicationId,'connections'))!.targets.find(t=>t.recipient===b.did)!.messageId;
    expect(await movedStack.messaging.read(b.session,c.did,resumedId)).toMatchObject({kind:'connection',senderAddress:selection.address});
    const reverseAfterMove={publicationId:uuidV7(),connections:[formerlyLocal.connection_id],text:'Peer at the retired source still sends through the current provider'};
    await withFreshServingGenerations(first.db.sql,()=>finalSourceStack.publications.createConnections(a.session,reverseAfterMove));
    await withFreshServingGenerations(first.db.sql,()=>finalSourceStack.publications.workOne());
    for(let i=0;i<500&&finalTargetStack.schedule.inFlight;i++)await Bun.sleep(10);
    expect(await withFreshServingGenerations(second.db.sql,()=>finalTargetStack.worker.processOne())).toBe('delivered');
    await expect(withFreshServingGenerations(first.db.sql,()=>one.publications.createConnections(c.session,{publicationId:uuidV7(),connections:[cb.id],text:'Old source must not sign'}))).rejects.toThrow();
    }
    }
    { portabilityStage='strict-public owner-controlled round trip';
      const registry='https://plc.directory',allowed=(url:URL)=>{if(!providers.some(p=>p.origin===url.origin))throw new Error('Unapproved portable target');};
      const stacks=new Map([[first,stack(first)],[third,stack(third)]]),keys=new Map<Provider,PreparedMigrationTarget>(),fences=new Map<Provider,MigrationFenceService>(),orchestrations=new Map<Provider,ConnectionTransferOrchestration>();
      for(const provider of [first,third]){
        const base=provider.origin+'/hail',targetKeys=new PreparedMigrationTarget(provider.db.sql,provider.encryptor,base,true),fence=new MigrationFenceService(provider.db.sql,resolver,base),
          orchestration=new ConnectionTransferOrchestration(provider.db.sql,provider.encryptor,resolver,base,network,allowed,provider.service.federation);
        keys.set(provider,targetKeys);fences.set(provider,fence);orchestrations.set(provider,orchestration);
        registerConnectionSourceRoutes(provider.app,orchestration);
        registerTransferRoutes(provider.app,new TransferInvitationReceiver(provider.db.sql,resolver,targetKeys),undefined,fence);
      }
      const genesis=a.evidence.log[0] as any,genesisCid=(await cidForCbor(genesis)).toString();
      await first.db.sql`INSERT INTO plc_operation_evidence(id,account_id,did,operation_cid,registry_origin,signed_operation,signed_operation_bytes,dag_cbor,expected_state,submission_state,verified_at)
        VALUES(${randomUUID()},${a.id},${a.did},${genesisCid},${registry},${JSON.stringify(genesis)}::jsonb,${new TextEncoder().encode(JSON.stringify(genesis))},${new Uint8Array(encodeDagCbor(genesis))},${JSON.stringify(a.evidence.data)}::jsonb,'verified',now())`;
      const originalConnections=await first.db.sql`SELECT peer_did,connection_id,epoch FROM federated_connection_pairs WHERE account_id=${a.id} ORDER BY peer_did`;
      let outboundReport:Awaited<ReturnType<typeof signMonitorAttestation>>|undefined;
      for(const [source,target] of [[first,third],[third,first]] as const){
      const returning=target===first,sourceBase=source.origin+'/hail',targetBase=target.origin+'/hail',targetKeys=keys.get(target)!,sourceFence=fences.get(source)!,targetOrchestration=orchestrations.get(target)!,portableStack=stacks.get(target)!;
      const n=Math.floor(Date.now()/1000),grant:TransferGrant={type:'hail.transfer-grant',version:1,did:a.did,nonce:randomUUID(),source_service_base:sourceBase,
        destination_service_base:targetBase,destination_domain:new URL(target.origin).hostname,issued_at:n,expires_at:n+3600},signedGrant=await signHandshake(grant,a.keys.identityPrivateKey);
      const sourceKey=await new OnboardingRepository(source.db.sql).getKey(a.id,'hail-messaging'),sourceBytes=await source.encryptor.decrypt(a.id,'hail-messaging','ed25519',sourceKey.publicKey,sourceKey);
      try{await new TransferInvitationService(source.db.sql,resolver,sourceBase).issue(signedGrant,await importEd25519PrivateKey(sourceBytes));}finally{sourceBytes.fill(0);}
      const offered=await new TransferInvitationDelivery(source.db.sql,resolver,sourceBase,network,allowed).deliver(a.did),offer=decodeDeterministic(offered.payloadBytes) as any,
        address=returning?a.address:'moved-a@'+new URL(target.origin).hostname,selection:TransferAddressSelection={type:'hail.transfer-address-selection',version:1,did:a.did,nonce:grant.nonce,transfer_id:offer.transfer_id,
          grant_digest:handshakeDigest(signedGrant.payloadBytes),offer_digest:handshakeDigest(offered.payloadBytes),address,selection_nonce:randomUUID(),issued_at:n,expires_at:n+1800},selected=await signHandshake(selection,a.keys.identityPrivateKey);
      await new TransferAddressReservation(target.db.sql,resolver,targetKeys).reserve(selected);
      await new TransferFinalRequestPublisher(target.db.sql,resolver,targetKeys,network,allowed).publish(offer.transfer_id);
      const exports=new MigrationTransferService(source.db.sql,new OnboardingRepository(source.db.sql),source.encryptor,resolver,sourceBase),snapshot=await exports.exportFenced((await sourceFence.get(a.did))!),m=validateTransferManifest(snapshot.bytes),
        operation=await signOperation({type:'plc_operation',prev:(await cidForCbor(a.evidence.log.at(-1) as any)).toString(),rotationKeys:[a.recoveryPublicKey,offer.destination_rotation_key],verificationMethods:{...(a.evidence.data as any).verificationMethods,'hail-messaging':offer.destination_messaging_key},
          alsoKnownAs:(a.evidence.data as any).alsoKnownAs,services:{hail:{type:'HailMessaging',endpoint:targetBase}}},a.recoveryKey),operationBytes=new TextEncoder().encode(JSON.stringify(operation)),
        binding=await signPayload('hail.address-binding',{type:'hail.address-binding',version:1,address,did:a.did,issued_at:n,expires_at:n+86400,key_id:a.did+'#hail-identity'},createWebCryptoSigner(a.did+'#hail-identity',a.keys.identityPrivateKey));
      const consent=await signPortableMigrationConsent({type:'hail.portable-migration-consent',version:1,did:a.did,transfer_id:m.transferId,snapshot_digest:snapshot.digest,
        plc_operation_sha256:new Uint8Array(createHash('sha256').update(encodeDagCbor(operation)).digest()),source_service_base:sourceBase,destination_service_base:targetBase,destination_address:address,
        destination_rotation_key:offer.destination_rotation_key,destination_messaging_key:offer.destination_messaging_key,user_recovery_key:a.recoveryPublicKey,user_identity_key:a.keys.identityDidKey,created_at:n,expires_at:n+900},a.keys.identityPrivateKey);
      let writes=0;const plc={async getOperationLog(){return a.evidence.log as any;},async sendOperation(_did:string,op:any){writes++;const log=[...a.evidence.log,op] as any,data=(await validateOperationLog(a.did,log))!;
        a.evidence={document:formatDidDoc(data),data,log};throw new Error('Lost portable PLC reply');}};
      const observer={origin:'https://mirror.example.com',operator:'independent-reader',resolver,async health(){return {lastCommittedOpTime:new Date().toISOString()};},async audit(){return Promise.all(a.evidence.log.map(async op=>({did:a.did,cid:(await cidForCbor(op as any)).toString(),operation:op,nullified:false,createdAt:new Date().toISOString()})));}},
        gate=new PortableCutoverGate(target.db.sql,[observer as any],undefined,['fixture-provider'],undefined,plc as any),verifier={async verify(value:string){
          const published=await new OnboardingRepository(target.db.sql).findPublishedByAddress(value);expect(published?.cose).toEqual(binding);
          const state=await resolver.resolve(a.did);return {address:value,did:a.did,serviceBase:targetBase,
          identityDidKey:a.keys.identityDidKey,messagingDidKey:offer.destination_messaging_key,plcEvidence:state.evidence,verifiedAt:new Date(),binding:inspectSignedPayload('hail.address-binding',binding).payload,representation:binding,digest:new Uint8Array(createHash('sha256').update(binding).digest())};}},
        activation=new PortableMigrationActivation(target.db.sql,target.encryptor,resolver,gate,verifier,targetBase,registry,undefined,'public',true),imports=new MigrationTransferService(target.db.sql,new OnboardingRepository(target.db.sql),target.encryptor,resolver,targetBase,true),
        completion=new PortableTransferCompletion(target.db.sql,imports,new PortablePlcSubmission(target.db.sql,plc as any,registry,targetBase),new PortableAddressPublication(target.db.sql,resolver,gate,registry,targetBase),activation,targetBase,'public',targetOrchestration),
        input={snapshot:{type:'hail.portable-migration-transfer',version:5,manifest:encodeBase64Url(snapshot.bytes),digest:encodeBase64Url(snapshot.digest),signature:encodeBase64Url(snapshot.signature),sourceMessagingPublicKey:snapshot.sourceMessagingPublicKey},
          consent:encodeSignedRecord(consent),operation:encodeBase64Url(operationBytes),binding:encodeBase64Url(binding)};
      if(returning){
        for(const field of ['user_identity_public_key','user_recovery_public_key','monitor_verification_mode','monitor_public_key']){
          const changed=structuredClone(m);changed.tables.portable_custody_evidence[0]![field]=field==='monitor_verification_mode'?'poc-local':monitor.messagingDidKey;
          await expect(validateReturningEvidence(target.db.sql,changed)).rejects.toThrow(/Returning/);
        }
      }
      lostPostCommit=1;await expect(withFreshServingGenerations(target.db.sql,()=>completion.complete(input))).rejects.toThrow('Lost post-cutover');expect(writes).toBe(1);
      expect(await withFreshServingGenerations(target.db.sql,()=>completion.complete(input))).toMatchObject({phase:'awaiting-monitor'});
      const report=await signMonitorAttestation({type:'hail.plc-monitor-attestation',version:2,did:a.did,transfer_id:m.transferId,operation_cid:(await cidForCbor(operation)).toString(),monitor_origin:'https://monitor.example.com',
        observed_at:n,coverage_since:n-3600,bootstrap_cid:genesisCid,bootstrap_state_digest:plcStateDigest((await validateOperationLog(a.did,[genesis]))!),export_sequence:returning?3:2},monitor.identityPrivateKey);
      if(returning)await expect(gate.assess(m.transferId,outboundReport!)).rejects.toThrow('another transfer');else outboundReport=report;
      const monitored={...input,monitor:encodeSignedRecord(report)},complete=await withFreshServingGenerations(target.db.sql,()=>completion.complete(monitored));expect(complete).toMatchObject({phase:'active',did:a.did,accountId:a.id});expect(writes).toBe(1);
      expect(await withFreshServingGenerations(target.db.sql,()=>completion.complete(monitored))).toEqual(complete);expect((await sourceFence.get(a.did))!.state).toBe('retired');
      const paired=(await target.db.sql<{connection_id:string;epoch:number|string}[]>`SELECT connection_id,epoch FROM federated_connection_pairs WHERE account_id=${a.id} AND peer_did=${b.did}`)[0]!;
      expect(paired.connection_id).toBe(abAfterMove.id);expect(await withFreshServingGenerations(target.db.sql,()=>portableStack.authority.live(a.did,b.did,{type:'connection',connection_id:paired.connection_id,epoch:Number(paired.epoch)}))).toBe(true);
      expect(await target.db.sql`SELECT role FROM account_keys WHERE account_id=${a.id} AND role='hail-identity'`).toHaveLength(0);
      for(const row of m.tables.sent_envelopes)expect(await portableStack.envelopes.sent(a.did,String(row.message_id))).toEqual(new Uint8Array(Buffer.from(String(row.envelope_cose).slice(2),'hex')));
      expect(await target.db.sql`SELECT peer_did,connection_id,epoch FROM federated_connection_pairs WHERE account_id=${a.id} ORDER BY peer_did`).toEqual(originalConnections);
      expect(await target.db.sql`SELECT id FROM connection_invitations WHERE account_id=${a.id} AND revoked_at IS NULL`).toHaveLength(0);
      if(returning){
        expect(Number((await target.db.sql<{generation:number|string}[]>`SELECT generation FROM account_serving_generations WHERE account_id=${a.id}`)[0]!.generation)).toBe(2);
        const archived=await target.db.sql<{history_bytes:Uint8Array}[]>`SELECT history_bytes FROM connection_history_archives WHERE account_id=${a.id}`;
        expect(archived.length).toBeGreaterThan(0);
        await verifyConnectionHistoryAuthority(m.connections!,resolver);
        const batch={publicationId:uuidV7(),connections:[paired.connection_id],text:'Portable strict-public round trip preserves messaging'};
        const returnedSession={...a.session,serving_generation:2};
        await withFreshServingGenerations(target.db.sql,()=>portableStack.publications.createConnections(returnedSession,batch));
        await withFreshServingGenerations(target.db.sql,()=>portableStack.publications.workOne());
        const peerStack=stacks.get(third)!;
        for(let i=0;i<500&&peerStack.schedule.inFlight;i++)await Bun.sleep(10);
        expect(await withFreshServingGenerations(third.db.sql,()=>peerStack.worker.processOne())).toBe('delivered');
        const messageId=(await portableStack.publications.status(returnedSession,batch.publicationId,'connections'))!.targets[0]!.messageId;
        expect(await peerStack.messaging.read(b.session,a.did,messageId)).toMatchObject({kind:'connection',senderAddress:a.address});
        portabilityStage='custody after connection transfer and return';
        // Exercise custody against real federation consent, imported archives and
        // completed peer handovers, then deliver another personal message.
        const custodyPlc={async health(){return {};},async getOperationLog(did:string){return users.find(u=>u.did===did)!.evidence.log as any;},
          async getDocumentData(did:string){return (await validateOperationLog(did,await this.getOperationLog(did)))!;},
          async getDocument(did:string){return formatDidDoc(await this.getDocumentData(did));},
          async getAuditableLog(did:string){return Promise.all((await this.getOperationLog(did)).map(async(operation:any,index:number)=>({did,operation,
            cid:(await cidForCbor(operation)).toString(),nullified:false,createdAt:new Date(auditStart+index*1000).toISOString()})));},
          async sendOperation(did:string,operation:any){const user=users.find(u=>u.did===did)!,log=[...user.evidence.log,operation] as any,
            data=(await validateOperationLog(did,log))!;user.evidence={document:formatDidDoc(data),data,log};}};
        const auditStart=Date.now()-60000,reader=(name:string)=>({origin:`https://custody-${name}.example.com`,operator:`custody-${name}`,
          resolver:new PlcHailDidResolver(custodyPlc),audit:(did:string)=>custodyPlc.getAuditableLog(did),health:async()=>({lastCommittedOpTime:new Date().toISOString()})});
        const custodyResolver=new VerifiedPublicPlcResolver(target.db.sql,[reader('one'),reader('two')],['fixture-provider'],[target.origin]);
        const custodyVerifier={async verify(address:string){const published=(await new OnboardingRepository(target.db.sql).findPublishedByAddress(address))!,state=await custodyResolver.resolve(a.did);
          return {address,did:a.did,serviceBase:targetBase,identityDidKey:state.identityDidKey,messagingDidKey:state.messagingDidKey,plcEvidence:state.evidence,
            verifiedAt:new Date(),binding:inspectSignedPayload('hail.address-binding',published.cose).payload,representation:published.cose,
            digest:new Uint8Array(createHash('sha256').update(published.cose).digest())};}};
        const custody=new SameProviderCustodyTransition(target.db.sql,custodyPlc,custodyResolver,target.encryptor,targetBase,custodyVerifier);
        const retainedProofs=await target.db.sql`SELECT digest,cose,authority FROM federated_connection_signatures WHERE account_id=${a.id} ORDER BY digest`;
        const retainedArchives=await target.db.sql`SELECT transfer_id,history_bytes FROM connection_history_archives WHERE account_id=${a.id} ORDER BY transfer_id`;
        const commitCustody=async(preparation:Awaited<ReturnType<SameProviderCustodyTransition['prepare']>>)=>{
          const op=await signOperation(preparation.unsignedOperation,a.recoveryKey),opBytes=new TextEncoder().encode(JSON.stringify(op)),issued=Math.floor(Date.now()/1000);
          const approval:CustodyTransitionApproval={type:'hailp.custody-transition',version:1,transition_id:preparation.transitionId,did:a.did,direction:preparation.direction,
            provider_service_base:targetBase,owner_recovery_key:a.recoveryPublicKey,old_identity_key:preparation.oldIdentityKey,new_identity_key:preparation.newIdentityKey,
            previous_operation_cid:preparation.previousOperationCid,operation_cid:(await cidForCbor(op)).toString(),history_checkpoint_sha256:preparation.historyCheckpointDigest,
            binding_sha256:preparation.bindingDigest,generation_from:preparation.generationFrom,generation_to:preparation.generationTo,nonce:randomUUID(),issued_at:issued,expires_at:issued+1800};
          const bytes=encodeDeterministic(approval as any),tag=new TextEncoder().encode('hailp.custody-transition.v1\0'),signing=new Uint8Array(tag.length+bytes.length);
          signing.set(tag);signing.set(bytes,tag.length);
          const signature=await a.recoveryKey.sign(signing);
          await withFreshServingGenerations(target.db.sql,()=>custody.commit(a.id,preparation.transitionId,opBytes,bytes,signature));
        };
        const managed=await withFreshServingGenerations(target.db.sql,()=>custody.prepare(a.id));await commitCustody(managed);
        const freshOwner=await generateAccountKeys(randomUUID(),target.encryptor),ownerReview=await custody.reviewOwner(a.id,freshOwner.identityDidKey),
          ownerBinding=await signPayload('hail.address-binding',ownerReview.binding,createWebCryptoSigner(a.did+'#hail-identity',freshOwner.identityPrivateKey));
        expect(ownerReview.activeGrants).toHaveLength(0);
        const ownerPrepared=await withFreshServingGenerations(target.db.sql,()=>custody.prepareOwner(a.id,freshOwner.identityDidKey,ownerBinding,[]));await commitCustody(ownerPrepared);
        expect(await target.db.sql`SELECT peer_did,connection_id,epoch FROM federated_connection_pairs WHERE account_id=${a.id} ORDER BY peer_did`).toEqual(originalConnections);
        expect(await target.db.sql`SELECT digest,cose,authority FROM federated_connection_signatures WHERE account_id=${a.id} ORDER BY digest`).toEqual(retainedProofs);
        expect(await target.db.sql`SELECT transfer_id,history_bytes FROM connection_history_archives WHERE account_id=${a.id} ORDER BY transfer_id`).toEqual(retainedArchives);
        const afterCustody=await collectConnectionHistory(target.db.sql,{accountId:a.id,did:a.did,sourceGeneration:4,sourceServiceBase:targetBase},new Date().toISOString());
        await verifyConnectionHistoryAuthority(afterCustody,resolver);
        const custodyBatch={publicationId:uuidV7(),connections:[paired.connection_id],text:'Connection survives both custody directions'},custodySession={...returnedSession,serving_generation:4};
        await withFreshServingGenerations(target.db.sql,()=>portableStack.publications.createConnections(custodySession,custodyBatch));
        await withFreshServingGenerations(target.db.sql,()=>portableStack.publications.workOne());
        for(let i=0;i<500&&peerStack.schedule.inFlight;i++)await Bun.sleep(10);
        expect(await withFreshServingGenerations(third.db.sql,()=>peerStack.worker.processOne())).toBe('delivered');
        const custodyMessage=(await portableStack.publications.status(custodySession,custodyBatch.publicationId,'connections'))!.targets[0]!.messageId;
        expect(await peerStack.messaging.read(b.session,a.did,custodyMessage)).toMatchObject({kind:'connection',senderAddress:a.address});

      }
      }
    }
  }catch(error){console.error("Federation fixture stage",portabilityStage,"HTTP outcomes",requests.slice(-12).map(r=>({provider:r.target.origin,path:r.path,status:r.status})));throw error;}
  finally{for(const p of providers){await p.db.close();await admin.unsafe(`DROP SCHEMA "${p.schema}" CASCADE`);}await admin.close();}
},90000);
