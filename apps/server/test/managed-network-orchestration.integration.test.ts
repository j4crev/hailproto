import {createHash,randomBytes,randomUUID} from "node:crypto";
import {cidForCbor} from "@atproto/common";
import {P256Keypair} from "@atproto/crypto";
import {didForCreateOp,formatDidDoc,signOperation,validateOperationLog} from "@did-plc/lib";
import {encode as encodeDagCbor} from "@ipld/dag-cbor";
import {base58btc} from "multiformats/bases/base58";
import {VerifiedPublicPlcResolver} from "../src/plc/public-resolver.js";
import {plcStateDigest} from "../src/plc/read-evidence.js";
import {signMonitorAttestation,type PlcMonitorAttestation} from "../src/migration/monitor-attestation.js";
import {createPublicManagedRuntime} from "../src/migration/public-managed-runtime.js";
import {loadConfig} from "../src/config.js";
import {createWebCryptoSigner,createWebCryptoVerifier,decodeBase64Url,decodeDeterministic,encodeBase64Url,encodeDeterministic,signPayload,
  verifySignedPayload,type HailEnvelope,type HailGrant,type HailValue} from "@hailproto/codec";
import {SQL} from "bun";
import {Hono} from "hono";
import {expect,it} from "vitest";
import {registerAccountApiRoutes} from "../src/accounts/routes.js";
import {ManagedAccountTransfer} from "../src/accounts/managed-transfer.js";
import {AccountApiRepository} from "../src/accounts/repository.js";
import {bodyFromText} from "../src/bodies/service.js";
import {ProviderDatabase} from "../src/db/database.js";
import {KeyEncryptor} from "../src/identity/key-encryption.js";
import {ed25519PublicKeyFromDidKey} from "../src/identity/did-key.js";
import {generateAccountKeys,importEd25519PrivateKey} from "../src/identity/keys.js";
import {uuidV7} from "../src/identity/uuid-v7.js";
import {ManagedTransferAuthorization} from "../src/migration/managed-authorization.js";
import {ManagedTransferDelivery} from "../src/migration/managed-delivery.js";
import {ManagedTransferAddressReservation} from "../src/migration/managed-address-selection.js";
import {ManagedMigrationFenceService} from "../src/migration/managed-fence.js";
import {ManagedTransferFencePublisher} from "../src/migration/managed-fence-publisher.js";
import {ManagedMigrationExportService,managedSnapshotSignatureInput,
  validateManagedTransferManifest} from "../src/migration/managed-snapshot.js";
import {ManagedMigrationStageService} from "../src/migration/managed-stage.js";
import {ManagedMigrationPlcSubmission} from "../src/migration/managed-plc-submission.js";
import {ManagedMigrationActivation} from "../src/migration/managed-activation.js";
import {ManagedMigrationCompletion} from "../src/migration/managed-completion.js";
import {replaceRetiredManagedProjection,validateManagedReturningEvidence} from "../src/migration/return.js";
import {encodeManagedHandshake,managedHandshakeSignatureInput,type ManagedTransferAddressSelection,
  managedHandshakeDigest,signManagedProviderHandshake,verifyManagedProviderHandshake,type ManagedTransferAcknowledgement,
  type ManagedTransferApproval,type ManagedTransferGrant} from "../src/migration/managed-handshake.js";
import {ManagedTransferInvitationReceiver} from "../src/migration/managed-invitation-receiver.js";
import {registerManagedTransferRoutes} from "../src/migration/routes.js";
import {PreparedMigrationTarget} from "../src/migration/target-keys.js";
import {OnboardingRepository} from "../src/onboarding/repository.js";
import {withFreshServingGenerations,withServingGeneration} from "../src/db/serving.js";
import {TransferDeliveryWorker} from "../src/migration/delivery-worker.js";
import {finalRequestWire,parseRequestWire,requestWire,TRANSFER_MEDIA_TYPE} from "../src/migration/wire.js";

const integration=process.env.DATABASE_URL?it:it.skip;

integration.each(["poc-local","strict-public-v1"] as const)("materializes an exact managed A to B to A round trip (%s) across injected HTTPS routes",async profile=>{
  const admin=new SQL(process.env.DATABASE_URL!),suffix=randomUUID().replaceAll("-",""),sourceSchema=`managed_net_a_${suffix}`,
    targetSchema=`managed_net_b_${suffix}`;await admin.unsafe(`CREATE SCHEMA "${sourceSchema}"`);await admin.unsafe(`CREATE SCHEMA "${targetSchema}"`);
  const scoped=(schema:string)=>{const url=new URL(process.env.DATABASE_URL!);url.searchParams.set("options",`-csearch_path=${schema}`);return url.toString();};
  const source=new ProviderDatabase(scoped(sourceSchema)),target=new ProviderDatabase(scoped(targetSchema));
  let phase="source preparation";
  try {
    await source.migrate();await target.migrate();const accountId=randomUUID();
    const sourceOrigin="https://a.example.com",sourceBase=`${sourceOrigin}/hail`,targetBase="https://b.example.com/hail";
    const sourceEncryptor=new KeyEncryptor(encodeBase64Url(randomBytes(32))),keys=await generateAccountKeys(accountId,sourceEncryptor);
    const owner=await P256Keypair.create();
    const genesis=await signOperation({type:"plc_operation",prev:null,rotationKeys:[owner.did(),keys.rotationDidKey],
      verificationMethods:{"hail-identity":keys.identityDidKey,"hail-messaging":keys.messagingDidKey},alsoKnownAs:[],
      services:{hail:{type:"HailMessaging",endpoint:sourceBase}}},owner);
    const did=await didForCreateOp(genesis),currentState=(await validateOperationLog(did,[genesis]))!;
    const genesisCid=(await cidForCbor(genesis)).toString();
    await source.sql`INSERT INTO provider_accounts(id,tenant_id,canonical_address,did,onboarding_state,activated_at,
      activation_binding_digest,activation_verification_mode) VALUES (${accountId},${randomUUID()},'alice@a.example.com',${did},
      'active',now(),${randomBytes(32)},'public')`;
    for(const key of keys.keys)await source.sql`INSERT INTO account_keys(account_id,role,algorithm,public_key,encrypted_private_key,
      encryption_nonce,encryption_version,kek_id) VALUES (${accountId},${key.role},${key.algorithm},${key.publicKey},
      ${key.ciphertext},${key.nonce},${key.encryptionVersion},${key.kekId})`;
    await source.sql`INSERT INTO managed_custody_evidence(account_id,owner_recovery_public_key,provider_identity_public_key,
      verification_mode,managed_profile_version) VALUES (${accountId},${owner.did()},${keys.identityDidKey},${profile},
        'hail-managed-custody-v1')`;
    if(profile==="strict-public-v1")await source.sql`INSERT INTO plc_operation_evidence(id,account_id,did,operation_cid,
      registry_origin,signed_operation,signed_operation_bytes,dag_cbor,expected_state,submission_state,verified_at)
      VALUES(${randomUUID()},${accountId},${did},${genesisCid},'https://plc.directory',${JSON.stringify(genesis)}::jsonb,
        ${new TextEncoder().encode(JSON.stringify(genesis))},${new Uint8Array(encodeDagCbor(genesis))},${JSON.stringify(currentState)}::jsonb,'verified',now())`;
    const grantId=uuidV7(),grantee=`did:plc:${"f".repeat(24)}`,grantNow=Math.floor(Date.now()/1000),grant:HailGrant={
      type:"hail.grant",version:1,grant_id:grantId,revision:1,previous:null,grantor:did,grantee,
      scope:[{type:"uncategorized"}],status:"active",issued_at:grantNow,updated_at:grantNow,expires_at:null,
      consent_context:{grantee_address:"peer@peer.example.com",address_binding_hash:{algorithm:"sha-256",value:randomBytes(32)},
        sender_profile_hash:{algorithm:"sha-256",value:randomBytes(32)}},key_id:`${did}#hail-identity`};
    const terminalGrantId=uuidV7(),terminalGrant:HailGrant={...grant,grant_id:terminalGrantId,status:"revoked"},
      identityRecord=keys.keys.find(key=>key.role==="hail-identity")!,identitySecret=await sourceEncryptor.decrypt(
      accountId,identityRecord.role,identityRecord.algorithm,identityRecord.publicKey,identityRecord);
    let grantCose:Uint8Array,terminalGrantCose:Uint8Array;
    try {const signer=createWebCryptoSigner(`${did}#hail-identity`,await importEd25519PrivateKey(identitySecret));
      [grantCose,terminalGrantCose]=await Promise.all([signPayload("hail.grant",grant,signer),signPayload("hail.grant",terminalGrant,signer)]);}
    finally {identitySecret.fill(0);}
    const grantDigest=new Uint8Array(createHash("sha256").update(grantCose).digest()),
      terminalGrantDigest=new Uint8Array(createHash("sha256").update(terminalGrantCose).digest());
    await source.sql`INSERT INTO grant_lineages(grant_id,local_account_id,local_role,grantor_did,grantee_did,
      current_revision,current_digest,current_status) VALUES (${grantId},${accountId},'grantor',${did},${grantee},1,${grantDigest},'active')`;
    await source.sql`INSERT INTO grant_revisions(grant_id,revision,status,issued_at,updated_at,expires_at,previous_digest,
      scope_payload,consent_address_binding_sha256,consent_sender_profile_sha256,cose,representation_digest,
      signing_public_key,signing_plc_document,signing_plc_data,signing_plc_operation_log)
      VALUES (${grantId},1,'active',${grantNow},${grantNow},NULL,NULL,${JSON.stringify(grant.scope)}::jsonb,
        ${grant.consent_context.address_binding_hash.value},${grant.consent_context.sender_profile_hash.value},
        ${grantCose},${grantDigest},${keys.identityDidKey},'{}','{}','[]')`;
    await source.sql`INSERT INTO grant_publications(grant_id,revision,destination_service_base,state)
      VALUES (${grantId},1,'https://peer.example.com/hail','pending')`;
    await source.sql`INSERT INTO grant_lineages(grant_id,local_account_id,local_role,grantor_did,grantee_did,
      current_revision,current_digest,current_status) VALUES (${terminalGrantId},${accountId},'grantor',${did},${grantee},1,${terminalGrantDigest},'revoked')`;
    await source.sql`INSERT INTO grant_revisions(grant_id,revision,status,issued_at,updated_at,expires_at,previous_digest,
      scope_payload,consent_address_binding_sha256,consent_sender_profile_sha256,cose,representation_digest,
      signing_public_key,signing_plc_document,signing_plc_data,signing_plc_operation_log)
      VALUES (${terminalGrantId},1,'revoked',${grantNow},${grantNow},NULL,NULL,${JSON.stringify(terminalGrant.scope)}::jsonb,
        ${terminalGrant.consent_context.address_binding_hash.value},${terminalGrant.consent_context.sender_profile_hash.value},
        ${terminalGrantCose},${terminalGrantDigest},${keys.identityDidKey},'{}','{}','[]')`;
    const bodyBytes=bodyFromText("managed continuity"),bodyHash=new Uint8Array(createHash("sha256").update(bodyBytes).digest()),
      bodyToken=randomBytes(32),bodyTokenHash=new Uint8Array(createHash("sha256").update(bodyToken).digest());
    await source.sql`INSERT INTO detached_bodies(digest,sender_account_id,body_bytes,available_until)
      VALUES (${bodyHash},${accountId},${bodyBytes},${grantNow+7200})`;
    await source.sql`INSERT INTO body_authorizations(token_hash,body_digest,sender_account_id,recipient_did,message_id,
      expires_at,available_until) VALUES (${bodyTokenHash},${bodyHash},${accountId},${grantee},${uuidV7()},
        ${grantNow+7200},${grantNow+7200})`;
    const incomingId=uuidV7(),remotePair=await crypto.subtle.generateKey("Ed25519",true,["sign","verify"]),incoming:HailEnvelope={
      type:"hail.envelope",version:1,message_id:incomingId,from:grantee,to:did,authorization:{type:"grant",grant_id:grantId},
      created_at:grantNow,expires_at:grantNow+3600,body:{digest:{algorithm:"sha-256",value:bodyHash},size:bodyBytes.length,
        media_type:"application/hail-body+cbor",profile:"spt-1",available_until:grantNow+31*86400,
        access:{type:"bearer",token:randomBytes(32),expires_at:grantNow+31*86400}},reply:{allowed:false}};
    const incomingCose=await signPayload("hail.envelope",incoming,createWebCryptoSigner(`${grantee}#hail-messaging`,remotePair.privateKey)),
      incomingDigest=new Uint8Array(createHash("sha256").update((await verifySignedPayload("hail.envelope",incomingCose,
        createWebCryptoVerifier(()=>remotePair.publicKey))).payloadBytes).digest());
    await source.sql`INSERT INTO received_envelopes(sender_did,message_id,recipient_did,grant_id,authorization_type,local_account_id,
      envelope_cose,envelope_digest,payload_digest,signing_public_key,signing_plc_document,signing_plc_data,signing_plc_operation_log,outcome,accepted_at)
      VALUES(${grantee},${incomingId},${did},${grantId},'grant',${accountId},${incomingCose},${incomingDigest},${incomingDigest},
        'fixture','{}'::jsonb,'{}'::jsonb,'[]'::jsonb,'accepted',now())`;
    await source.sql`INSERT INTO delivery_work(sender_did,message_id) VALUES(${grantee},${incomingId})`;
    let plcLog=[genesis];
    const rawResolver={async resolve(value:string){if(value!==did)throw new Error("unknown DID");const data=(await validateOperationLog(did,plcLog))!,last=plcLog.at(-1)!;
      return {did,identityDidKey:data.verificationMethods["hail-identity"]!,messagingDidKey:data.verificationMethods["hail-messaging"]!,
        serviceBase:data.services.hail!.endpoint,evidence:{document:formatDidDoc(data),data,log:plcLog,verification:{profile:"poc-local" as const,
          digest:"fixture",operationCid:(await cidForCbor(last)).toString(),verifiedAt:new Date().toISOString()}}};}};
    let readerFailure=false;
    let readerDisagreement=false;
    const auditCreatedAt=new Date(Date.now()-60_000).toISOString();
    const readers=["one","two"].map(name=>({origin:`https://reader-${name}.example.com`,operator:`reader-${name}`,
      async health(){return {lastCommittedOpTime:new Date().toISOString()};},
      resolver:{async resolve(value:string){if(readerFailure&&name==="two")throw new Error("reader outage");const result=await rawResolver.resolve(value);
        return readerDisagreement&&name==="two"?{...result,serviceBase:sourceBase}:result;}},
       async audit(){if(readerFailure)throw new Error("reader outage");return Promise.all(plcLog.map(async operation=>({did,cid:(await cidForCbor(operation)).toString(),operation,
        nullified:false,createdAt:auditCreatedAt})));}})) as unknown as
      readonly [import("../src/plc/observers.js").IndependentPlcObserver,import("../src/plc/observers.js").IndependentPlcObserver];
    const resolver=profile==="strict-public-v1"?new VerifiedPublicPlcResolver(source.sql,readers,["provider-a","provider-b"],[sourceOrigin,"https://b.example.com"]):rawResolver;
    const targetResolver=profile==="strict-public-v1"?new VerifiedPublicPlcResolver(target.sql,readers,["provider-a","provider-b"],[sourceOrigin,"https://b.example.com"]):rawResolver;
    const monitorPair=await crypto.subtle.generateKey("Ed25519",true,["sign","verify"]),monitor={monitorOrigin:"https://monitor.example.com",
      monitorPublicKey:`did:key:${base58btc.encode(new Uint8Array([0xed,1,...new Uint8Array(await crypto.subtle.exportKey("raw",monitorPair.publicKey))]))}`};
    const runtimeConfig=(origin:string)=>loadConfig({NODE_ENV:"production",PORT:"3000",PROVIDER_ID:"fixture",PUBLIC_ORIGIN:origin,
      HAIL_SERVICE_BASE:`${origin}/hail`,PLC_DIRECTORY_URL:"https://plc.directory",DATABASE_URL:process.env.DATABASE_URL!,
      KEY_ENCRYPTION_KEY:encodeBase64Url(randomBytes(32)),PLC_AUTHORITY_PROFILE:"strict-public-v1",
      PLC_PUBLIC_READERS:JSON.stringify(readers.map(({origin,operator})=>({origin,operator}))),PLC_PROVIDER_OPERATORS:'["provider-a","provider-b"]',
      PUBLIC_MANAGED_TRANSFER:"true",PLC_MANAGED_MONITOR_ORIGIN:monitor.monitorOrigin,PLC_MANAGED_MONITOR_PUBLIC_KEY:monitor.monitorPublicKey});
    const attestation=async(transferId:string,cid:string)=>signMonitorAttestation({type:"hail.plc-monitor-attestation",version:2,did,
      transfer_id:transferId,operation_cid:cid,monitor_origin:monitor.monitorOrigin,coverage_since:Math.floor(Date.now()/1000)-120,
      observed_at:Math.floor(Date.now()/1000),bootstrap_cid:genesisCid,bootstrap_state_digest:plcStateDigest(currentState),export_sequence:plcLog.length},monitorPair.privateKey);
    const targetEncryptor=new KeyEncryptor(encodeBase64Url(randomBytes(32))),targetKeys=new PreparedMigrationTarget(target.sql,targetEncryptor,targetBase);
    const destination=new Hono(),receiver=new ManagedTransferInvitationReceiver(target.sql,targetResolver,targetKeys);
    const accounts=new AccountApiRepository(source.sql),credential=await accounts.issue("alice@a.example.com",false,undefined,["account:read","account:write"]);
    const onboarding=new OnboardingRepository(source.sql);
    const authorization=new ManagedTransferAuthorization(source.sql,resolver,sourceBase,onboarding,sourceEncryptor);
    let deliveryAttempts=0;
    const delivery=new ManagedTransferDelivery(source.sql,resolver,sourceBase,
      async request=>++deliveryAttempts===1?new Response(null,{status:503}):
        withFreshServingGenerations(target.sql,()=>destination.fetch(request)),url=>{
      if(url.href!=="https://b.example.com/.well-known/hail/transfers/managed-invitations")throw new Error("wrong target");});
    const fence=new ManagedMigrationFenceService(source.sql,resolver,sourceBase,undefined,profile);
    let sourceApp:Hono, fenceAttempts=0;
    const reservations=new ManagedTransferAddressReservation(target.sql,targetResolver,targetKeys);
    const publisher=new ManagedTransferFencePublisher(target.sql,targetResolver,targetKeys,async request=>{
      if(++fenceAttempts===1)return new Response(null,{status:503});
      return withFreshServingGenerations(source.sql,()=>sourceApp.fetch(request));
    },url=>{if(url.href!==`${sourceBase}/transfers/managed-requests`)throw new Error("wrong source fence target");});
    registerManagedTransferRoutes(destination,receiver,undefined,reservations,publisher);
    const exporter=new ManagedMigrationExportService(source.sql,onboarding,sourceEncryptor,resolver,sourceBase,undefined,profile);
    const managed=new ManagedAccountTransfer(source.sql,authorization,delivery,sourceOrigin,{fence,snapshots:exporter}),app=new Hono();sourceApp=app;
    registerAccountApiRoutes(app,accounts,{} as never,{} as never,sourceOrigin,undefined,undefined,undefined,undefined,managed);
    registerManagedTransferRoutes(app,undefined,undefined,undefined,undefined,fence);
    const now=Math.floor(Date.now()/1000),grantValue:ManagedTransferGrant={type:"hail.managed-transfer-grant",version:1,did,
      nonce:randomUUID(),source_service_base:sourceBase,destination_service_base:targetBase,destination_domain:"b.example.com",
      owner_recovery_key:owner.did(),source_identity_key:keys.identityDidKey,issued_at:now,expires_at:now+3600};
    const bytes=encodeManagedHandshake(grantValue),signed={payloadBytes:bytes,
      signature:await owner.sign(managedHandshakeSignatureInput(grantValue.type,bytes))},body=JSON.stringify({
        payload:encodeBase64Url(signed.payloadBytes),signature:encodeBase64Url(signed.signature)});
    const call=(path:string,method="GET",payload?:string,token=credential.token)=>app.request(`${sourceOrigin}${path}`,{
      method,headers:{Authorization:`Bearer ${token}`,...(payload?{"Content-Type":"application/json"}:{})},...(payload?{body:payload}:{})});
    expect((await call("/api/v1/account/transfers/managed/offer","POST",body,"wrong")).status).toBe(401);
    const firstResponse=await call("/api/v1/account/transfers/managed/offer","POST",body);expect(firstResponse.status).toBe(200);
    const first=await firstResponse.json() as Record<string,any>;expect(first).toMatchObject({type:"hailp.managed-transfer-status",
      phase:"acknowledgement-retained",did,originConfirmed:false,destinationServiceBase:targetBase,offer:null});
    expect(first.acknowledgement).toEqual(expect.objectContaining({payload:expect.any(String),signature:expect.any(String)}));
    const sourceWorker=new TransferDeliveryWorker(source.sql,{async deliver(){throw new Error("portable worker must not claim managed work");}},
      {async publish(){throw new Error("source has no final request");}},delivery);
    const targetWorker=new TransferDeliveryWorker(target.sql,{async deliver(){throw new Error("target has no invitation");}},
      {async publish(){throw new Error("portable final worker must not claim managed work");}},undefined,publisher);
    await expect(sourceWorker.runOnce()).resolves.toBe("managed-invitation");
    const ready=await (await call("/api/v1/account/transfers/managed")).json() as Record<string,any>;
    expect(ready).toMatchObject({phase:"offer-ready",originConfirmed:true});
    expect(ready.offer).toEqual(expect.objectContaining({payload:expect.any(String),signature:expect.any(String)}));
    const retry=await (await call("/api/v1/account/transfers/managed/offer","POST",body)).json();expect(retry).toEqual(ready);
    const offerSigned={payloadBytes:decodeBase64Url(ready.offer.payload),signature:decodeBase64Url(ready.offer.signature)};
    const targetRole=(await target.sql<{messaging_public_key:string}[]>`SELECT messaging_public_key
      FROM prepared_migration_target_keys WHERE did=${did}`)[0]!;
    const offer=await verifyManagedProviderHandshake(offerSigned,"hail.managed-transfer-offer",targetRole.messaging_public_key);
    const selectionValue:ManagedTransferAddressSelection={type:"hail.managed-transfer-address-selection",version:1,did,
      nonce:grantValue.nonce,transfer_id:offer.transfer_id,grant_digest:offer.grant_digest,
      offer_digest:new Uint8Array(await crypto.subtle.digest("SHA-256",Uint8Array.from(offerSigned.payloadBytes))),
      address:"alice@b.example.com",selection_nonce:randomUUID(),issued_at:now,expires_at:now+1800};
    const selectionBytes=encodeManagedHandshake(selectionValue),selectionSigned={payloadBytes:selectionBytes,
      signature:await owner.sign(managedHandshakeSignatureInput(selectionValue.type,selectionBytes))};
    const activeLease=randomUUID();
    await source.sql`INSERT INTO serving_worker_leases(lease_token,account_id,generation)
      VALUES (${activeLease},${accountId},1)`;
    const reserve=()=>withFreshServingGenerations(target.sql,()=>destination.request(
      "https://b.example.com/.well-known/hail/transfers/managed-reservations",{method:"POST",
        headers:{"Content-Type":TRANSFER_MEDIA_TYPE},body:Uint8Array.from(requestWire(selectionSigned))}));
    const reservedResponse=await reserve();expect(reservedResponse.status).toBe(202);
    const reservationSigned=parseRequestWire(new Uint8Array(await reservedResponse.arrayBuffer()));
    expect(fenceAttempts).toBe(1);
    expect((await source.sql`SELECT 1 FROM provider_migration_fences WHERE did=${did}`)).toHaveLength(0);
    await target.sql`UPDATE received_transfer_invitations SET next_final_attempt_at=clock_timestamp()
      WHERE transfer_id=${offer.transfer_id}`;
    await expect(targetWorker.runOnce()).resolves.toBe("managed-final");
    expect(fenceAttempts).toBe(2);
    expect((await source.sql`SELECT 1 FROM provider_migration_fences WHERE did=${did}`)).toHaveLength(0);
    await source.sql`DELETE FROM serving_worker_leases WHERE lease_token=${activeLease}`;
    await target.sql`UPDATE received_transfer_invitations SET next_final_attempt_at=clock_timestamp()
      WHERE transfer_id=${offer.transfer_id}`;
    await expect(targetWorker.runOnce()).resolves.toBe("managed-final");
    expect(fenceAttempts).toBe(3);
    expect((await source.sql`SELECT 1 FROM provider_migration_fences WHERE did=${did}`)).toHaveLength(0);
    await source.sql`UPDATE grant_publications SET state='acknowledged',acknowledged_etag='"grant-v1"',
      acknowledged_at=clock_timestamp() WHERE grant_id=${grantId} AND revision=1`;
    await target.sql`UPDATE received_transfer_invitations SET next_final_attempt_at=clock_timestamp()
      WHERE transfer_id=${offer.transfer_id}`;
    await expect(targetWorker.runOnce()).resolves.toBe("managed-final");
    expect(fenceAttempts).toBe(4);
    const fenceRow=(await source.sql<{source_custody_profile:string;owner_recovery_public_key:string;
      source_identity_public_key:string;destination_identity_public_key:string;state:string}[]>`
      SELECT source_custody_profile,owner_recovery_public_key,source_identity_public_key,
        destination_identity_public_key,state FROM provider_migration_fences WHERE did=${did}`)[0]!;
    expect(fenceRow).toMatchObject({source_custody_profile:"managed",owner_recovery_public_key:owner.did(),
      source_identity_public_key:keys.identityDidKey,destination_identity_public_key:offer.destination_identity_key,state:"fenced"});
    const exported=await exporter.exportFenced({did,accountId,transferId:offer.transfer_id,destinationServiceBase:targetBase,
      ownerRecoveryPublicKey:owner.did(),sourceIdentityPublicKey:keys.identityDidKey,
      destinationIdentityPublicKey:offer.destination_identity_key,
      destinationRotationPublicKey:offer.destination_rotation_key,
      destinationMessagingPublicKey:offer.destination_messaging_key,state:"fenced"});
    const manifest=validateManagedTransferManifest(exported.bytes);
    const apiExport=await call("/api/v1/account/transfers/managed/export","POST",JSON.stringify({transferId:offer.transfer_id}));
    expect(apiExport.status).toBe(200);expect(await apiExport.json()).toMatchObject({type:"hail.managed-migration-transfer",version:4,
      manifest:encodeBase64Url(exported.bytes),digest:encodeBase64Url(exported.digest),signature:encodeBase64Url(exported.signature)});
    expect(manifest).toMatchObject({version:4,custodyProfile:"managed",did,sourceGeneration:1,
      ownerRecoveryPublicKey:owner.did(),sourceIdentityPublicKey:keys.identityDidKey,
      destinationIdentityPublicKey:offer.destination_identity_key});
    expect(manifest.tables.managed_custody_evidence[0]?.managed_profile_version).toBe("hail-managed-custody-v1");
    expect(manifest.tables.grant_publications).toEqual([expect.objectContaining({grant_id:grantId,revision:1,
      state:"acknowledged",acknowledged_etag:'"grant-v1"'})]);
    const serialized=new TextDecoder().decode(exported.bytes);
    expect(serialized).not.toMatch(/encrypted_private_key|encryption_nonce|kek_id|lease_token|lease_expires_at|"(?:token|secret|credential)"\s*:/);
    expect(manifest.tables.body_authorizations[0]?.token_hash).toBe(`\\x${Buffer.from(bodyTokenHash).toString("hex")}`);
    expect(serialized).not.toContain(Buffer.from(bodyToken).toString("hex"));
    const invalid=(change:(value:any)=>void)=>{const value=JSON.parse(new TextDecoder().decode(exported.bytes));change(value);
      return()=>validateManagedTransferManifest(new TextEncoder().encode(JSON.stringify(value)));};
    expect(invalid(value=>{value.tables.detached_bodies[0].sender_account_id=randomUUID();})).toThrow(/body integrity/);
    expect(invalid(value=>{value.tables.detached_bodies[0].body_bytes=`\\x${Buffer.from(bodyFromText("changed")).toString("hex")}`;}))
      .toThrow(/body integrity/);
    expect(invalid(value=>{value.tables.body_authorizations[0].body_digest=`\\x${"00".repeat(32)}`;}))
      .toThrow(/local provenance/);
    expect(invalid(value=>{value.tables.managed_custody_evidence[0].managed_profile_version="future-profile";}))
      .toThrow(/custody evidence/);
    expect(invalid(value=>{value.tables.grant_publications[0].lease_token=randomUUID();})).toThrow(/worker lease/);
    const tampered=JSON.parse(new TextDecoder().decode(exported.bytes)) as Record<string,unknown>;
    tampered.historyCheckpointDigest=encodeBase64Url(randomBytes(32));
    expect(()=>validateManagedTransferManifest(new TextEncoder().encode(JSON.stringify(tampered))))
      .toThrow(/history checkpoint/);
    expect(await crypto.subtle.verify("Ed25519",await ed25519PublicKeyFromDidKey(exported.sourceMessagingPublicKey),
      Uint8Array.from(exported.signature),managedSnapshotSignatureInput(exported.digest))).toBe(true);
    const exportRetry=await exporter.exportFenced({did,accountId,transferId:offer.transfer_id,destinationServiceBase:targetBase,
      ownerRecoveryPublicKey:owner.did(),sourceIdentityPublicKey:keys.identityDidKey,
      destinationIdentityPublicKey:offer.destination_identity_key,
      destinationRotationPublicKey:offer.destination_rotation_key,
      destinationMessagingPublicKey:offer.destination_messaging_key,state:"exported"});
    expect(exportRetry).toEqual(exported);
    const cutover=await signOperation({type:"plc_operation",prev:genesisCid,
      rotationKeys:[owner.did(),offer.destination_rotation_key],verificationMethods:{
        ...currentState.verificationMethods,"hail-identity":offer.destination_identity_key,
        "hail-messaging":offer.destination_messaging_key},alsoKnownAs:currentState.alsoKnownAs,
      services:{...currentState.services,hail:{type:"HailMessaging",endpoint:targetBase}}},owner);
    const cutoverBytes=new TextEncoder().encode(JSON.stringify(cutover)),cutoverCid=(await cidForCbor(cutover)).toString();
    const approval:ManagedTransferApproval={type:"hail.managed-transfer-approval",version:1,did,
      nonce:grantValue.nonce,transfer_id:offer.transfer_id,source_service_base:sourceBase,
      destination_service_base:targetBase,destination_address:selectionValue.address,owner_recovery_key:owner.did(),
      source_identity_key:keys.identityDidKey,destination_rotation_key:offer.destination_rotation_key,
      destination_identity_key:offer.destination_identity_key,destination_messaging_key:offer.destination_messaging_key,
      grant_digest:managedHandshakeDigest(signed.payloadBytes),offer_digest:managedHandshakeDigest(offerSigned.payloadBytes),
      selection_digest:managedHandshakeDigest(selectionSigned.payloadBytes),snapshot_version:4,
      snapshot_digest:exported.digest,history_checkpoint_digest:decodeBase64Url(manifest.historyCheckpointDigest),
      source_generation:manifest.sourceGeneration,previous_operation_cid:genesisCid,operation_cid:cutoverCid,
      issued_at:now,expires_at:now+900};
    const approvalBytes=encodeManagedHandshake(approval),approvalSigned={payloadBytes:approvalBytes,
      signature:await owner.sign(managedHandshakeSignatureInput(approval.type,approvalBytes))};
    const stager=new ManagedMigrationStageService(target.sql,targetResolver,targetKeys,targetBase,()=>now,profile);
    if(profile==="poc-local")await expect(new ManagedMigrationStageService(target.sql,targetResolver,targetKeys,targetBase)
      .stage(exported,approvalSigned,cutoverBytes)).rejects.toThrow(/authority profile/);
    expect(await stager.stage(exported,approvalSigned,cutoverBytes)).toEqual(manifest);
    const staged=(await target.sql<{state:string;custody_profile:string;owner_recovery_public_key:string;
      source_identity_public_key:string;destination_identity_public_key:string;destination_address:string;
      destination_binding_cose:Uint8Array}[]>`SELECT state,custody_profile,owner_recovery_public_key,
      source_identity_public_key,destination_identity_public_key,destination_address,destination_binding_cose
      FROM pending_migration_imports WHERE transfer_id=${offer.transfer_id}`)[0]!;
    expect(staged).toMatchObject({state:"staged",custody_profile:"managed",owner_recovery_public_key:owner.did(),
      source_identity_public_key:keys.identityDidKey,destination_identity_public_key:offer.destination_identity_key,
      destination_address:selectionValue.address});
    expect((await verifySignedPayload("hail.address-binding",new Uint8Array(staged.destination_binding_cose),
      createWebCryptoVerifier(()=>ed25519PublicKeyFromDidKey(offer.destination_identity_key)))).payload)
      .toMatchObject({did,address:selectionValue.address,key_id:`${did}#hail-identity`});
    const rollback48=await target.sql.reserve();try {
      await expect(rollback48.unsafe(await Bun.file(new URL("../migrations/rollback/0048_managed_migration_approval.sql",import.meta.url)).text()))
        .rejects.toThrow("managed owner approval evidence exists");
    } finally {await rollback48.unsafe("ROLLBACK");rollback48.release();}
    expect((await target.sql<{state:string}[]>`SELECT state FROM prepared_migration_target_keys
      WHERE transfer_id=${offer.transfer_id}`)[0]?.state).toBe("staged");
    expect(await target.sql`SELECT 1 FROM provider_accounts WHERE did=${did}`).toHaveLength(0);
    expect((await source.sql<{state:string}[]>`SELECT state FROM provider_migration_fences
      WHERE transfer_id=${offer.transfer_id}`)[0]?.state).toBe("exported");
    expect(await stager.stage(exported,approvalSigned,cutoverBytes)).toEqual(manifest);
    const changedSnapshot={...exported,bytes:Uint8Array.from(exported.bytes)};
    const snapshotLast=changedSnapshot.bytes.length-1;
    changedSnapshot.bytes[snapshotLast]=(changedSnapshot.bytes[snapshotLast]??0)^1;
    await expect(stager.stage(changedSnapshot,approvalSigned,cutoverBytes)).rejects.toThrow(/digest or signature/);
    const changedApproval={...approval,destination_address:"other@b.example.com"},changedApprovalBytes=encodeManagedHandshake(changedApproval);
    await expect(stager.stage(exported,{payloadBytes:changedApprovalBytes,
      signature:await owner.sign(managedHandshakeSignatureInput(changedApproval.type,changedApprovalBytes))},cutoverBytes))
      .rejects.toThrow(/retained exact artifacts/);
    const changedCutover=await signOperation({type:"plc_operation",prev:cutover.prev,
      rotationKeys:cutover.rotationKeys,verificationMethods:cutover.verificationMethods,
      alsoKnownAs:cutover.alsoKnownAs,services:{...cutover.services,
        extra:{type:"OtherService",endpoint:"https://other.example.com"}}},owner);
    await expect(stager.stage(exported,approvalSigned,new TextEncoder().encode(JSON.stringify(changedCutover))))
      .rejects.toThrow(/retained exact artifacts/);
    expect((await source.sql`SELECT 1 FROM provider_migration_exports
      WHERE transfer_id=${offer.transfer_id} AND custody_profile='managed'`)).toHaveLength(1);
    await expect(source.sql`UPDATE account_keys SET public_key=public_key WHERE account_id=${accountId}`)
      .rejects.toThrow(/migration-fenced/);
    const finalRow=(await target.sql<{final_request_bytes:Uint8Array;final_request_signature:Uint8Array}[]>`
      SELECT final_request_bytes,final_request_signature FROM received_transfer_invitations
      WHERE transfer_id=${offer.transfer_id}`)[0]!;
    const requestSigned={payloadBytes:new Uint8Array(finalRow.final_request_bytes),
      signature:new Uint8Array(finalRow.final_request_signature)};
    const exactBody=finalRequestWire(selectionSigned,reservationSigned,requestSigned);
    expect(await fence.previouslyAccepted(requestSigned,selectionSigned,reservationSigned)).toBe(true);
    const exact=await withFreshServingGenerations(source.sql,()=>app.request(`${sourceBase}/transfers/managed-requests`,{
      method:"POST",headers:{"Content-Type":TRANSFER_MEDIA_TYPE},body:Uint8Array.from(exactBody)}));
    expect(exact.status).toBe(204);
    const repeat=await reserve();expect(repeat.status).toBe(200);
    expect(parseRequestWire(new Uint8Array(await repeat.arrayBuffer()))).toEqual(reservationSigned);
    const changedSelection={...selectionValue,address:"other@b.example.com",selection_nonce:randomUUID()},
      changedSelectionBytes=encodeManagedHandshake(changedSelection),changedSelectionSigned={payloadBytes:changedSelectionBytes,
        signature:await owner.sign(managedHandshakeSignatureInput(changedSelection.type,changedSelectionBytes))};
    const changedSelectionResponse=await withFreshServingGenerations(target.sql,()=>destination.request(
      "https://b.example.com/.well-known/hail/transfers/managed-reservations",{method:"POST",
        headers:{"Content-Type":TRANSFER_MEDIA_TYPE},body:Uint8Array.from(requestWire(changedSelectionSigned))}));
    expect(changedSelectionResponse.status).toBe(400);
    const changedReservation={...reservationSigned,payloadBytes:Uint8Array.from(reservationSigned.payloadBytes)};
    const reservationLast=changedReservation.payloadBytes.length-1;
    changedReservation.payloadBytes[reservationLast]=(changedReservation.payloadBytes[reservationLast]??0)^1;
    const changedReservationResponse=await withFreshServingGenerations(source.sql,()=>app.request(
      `${sourceBase}/transfers/managed-requests`,{method:"POST",headers:{"Content-Type":TRANSFER_MEDIA_TYPE},
        body:Uint8Array.from(finalRequestWire(selectionSigned,changedReservation,requestSigned))}));
    expect(changedReservationResponse.status).toBe(400);
    const changedRequest={...requestSigned,payloadBytes:Uint8Array.from(requestSigned.payloadBytes)};
    const requestLast=changedRequest.payloadBytes.length-1;
    changedRequest.payloadBytes[requestLast]=(changedRequest.payloadBytes[requestLast]??0)^1;
    const changedRequestResponse=await withFreshServingGenerations(source.sql,()=>app.request(
      `${sourceBase}/transfers/managed-requests`,{method:"POST",headers:{"Content-Type":TRANSFER_MEDIA_TYPE},
        body:Uint8Array.from(finalRequestWire(selectionSigned,reservationSigned,changedRequest))}));
    expect(changedRequestResponse.status).toBe(400);
    const changed={...grantValue,nonce:randomUUID()},changedBytes=encodeManagedHandshake(changed),changedBody=JSON.stringify({
      payload:encodeBase64Url(changedBytes),signature:encodeBase64Url(await owner.sign(managedHandshakeSignatureInput(changed.type,changedBytes)))});
    expect((await call("/api/v1/account/transfers/managed/offer","POST",changedBody)).status).toBe(409);
    expect((await source.sql`SELECT 1 FROM provider_transfer_authorizations WHERE did=${did} AND custody_profile='managed' AND origin_confirmed_at IS NOT NULL`)).toHaveLength(1);
    expect((await target.sql`SELECT 1 FROM prepared_migration_target_keys WHERE did=${did} AND custody_profile='managed'`)).toHaveLength(1);
    expect((await target.sql`SELECT 1 FROM received_transfer_invitations WHERE did=${did}`)).toHaveLength(1);
    let submissions=0;
    const plc={async getOperationLog(){return plcLog;},async sendOperation(_did:string,operation:typeof cutover){
      submissions++;plcLog=[...plcLog,operation];throw new Error("lost PLC response");}};
    const submitter=new ManagedMigrationPlcSubmission(target.sql,plc,targetResolver,targetBase);
    await expect(submitter.submit(offer.transfer_id)).resolves.toBe(cutoverCid);
    await expect(submitter.submit(offer.transfer_id)).resolves.toBe(cutoverCid);
    expect(submissions).toBe(1);
    const disagreeing={async resolve(value:string){return {...await resolver.resolve(value),serviceBase:sourceBase};}};
    await expect(new ManagedMigrationPlcSubmission(target.sql,plc,disagreeing,targetBase).submit(offer.transfer_id))
      .rejects.toThrow(/Validated public reader/);
    const destinationState=(await validateOperationLog(did,plcLog))!,verifiedAt=new Date().toISOString(),retainedAudit=await readers[0].audit(did);
    const bundle=encodeDeterministic({type:"hail.public-plc-resolution",version:1,policy:"strict-public-v1",did,
      operation_cid:cutoverCid,verified_at:verifiedAt,witnesses:[{state:destinationState,audit:retainedAudit}]} as unknown as HailValue),
      evidenceDigest=new Uint8Array(createHash("sha256").update(bundle).digest());
    await target.sql`INSERT INTO public_plc_resolution_evidence
      (evidence_digest,did,operation_cid,verified_at,bundle_bytes,record_version,read_evidence_policy_version)
      VALUES(${evidenceDigest},${did},${cutoverCid},${verifiedAt},${bundle},1,'hail.plc-read-evidence-v1')`;
    const strictResolver={async resolve(value:string){const result=await targetResolver.resolve(value);return {...result,evidence:{...result.evidence,
      verification:{profile:"poc-local" as const,digest:encodeBase64Url(evidenceDigest),operationCid:cutoverCid,verifiedAt}}};}};
    const binding=decodeDeterministic((await verifySignedPayload("hail.address-binding",new Uint8Array(staged.destination_binding_cose),
      createWebCryptoVerifier(()=>ed25519PublicKeyFromDidKey(offer.destination_identity_key)))).payloadBytes) as any;
    const verifier={async verify(address:string){return {address,did,serviceBase:targetBase,identityDidKey:offer.destination_identity_key,
      messagingDidKey:offer.destination_messaging_key,plcEvidence:(await strictResolver.resolve(did)).evidence,verifiedAt:new Date(),
      binding,representation:new Uint8Array(staged.destination_binding_cose),digest:new Uint8Array(createHash("sha256").update(staged.destination_binding_cose).digest())};}};
    const publicRuntime=profile==="strict-public-v1"?createPublicManagedRuntime(runtimeConfig("https://b.example.com"),target.sql,
      plc as never,new OnboardingRepository(target.sql),targetEncryptor,{fetch:async()=>{throw new Error("unexpected network");},validateTarget:()=>{}},verifier,readers):undefined;
    const activation=publicRuntime?.activation??new ManagedMigrationActivation(target.sql,targetEncryptor,strictResolver,verifier,targetBase,"http://plc.fixture:2582","poc-local");
    const completion=publicRuntime?.completion??new ManagedMigrationCompletion(stager,submitter,activation);
    const monitorSigned=await attestation(offer.transfer_id,cutoverCid);
    if(publicRuntime) {
      phase="public destination activation";
      await expect(activation.activate(offer.transfer_id)).rejects.toThrow(/monitor/);
      await expect(activation.activate(offer.transfer_id,{...monitorSigned,signature:new Uint8Array(64)})).rejects.toThrow(/signature/);
      const report=decodeDeterministic(monitorSigned.payloadBytes) as unknown as PlcMonitorAttestation;
      for(const overrides of [{observed_at:report.observed_at-301,coverage_since:report.observed_at-500},
        {coverage_since:report.observed_at+10,observed_at:report.observed_at+10},
        {bootstrap_state_digest:encodeBase64Url(new Uint8Array(32))},
        {monitor_origin:"https://unreviewed.example.com"}]) {
        const bad=await signMonitorAttestation({...report,...overrides},monitorPair.privateKey);
        await expect(activation.activate(offer.transfer_id,bad)).rejects.toThrow();
      }
      readerFailure=true;await expect(activation.activate(offer.transfer_id,monitorSigned)).rejects.toThrow(/No configured PLC reader/);readerFailure=false;
      expect(await target.sql`SELECT 1 FROM public_cutover_evidence`).toHaveLength(0);
      expect(await target.sql`SELECT 1 FROM provider_accounts WHERE id=${accountId}`).toHaveLength(0);
    }
    const completionApp=new Hono();registerManagedTransferRoutes(completionApp,undefined,undefined,undefined,undefined,undefined,completion);
    const completionBody=JSON.stringify({snapshot:{type:"hail.managed-migration-transfer",version:4,
      manifest:encodeBase64Url(exported.bytes),digest:encodeBase64Url(exported.digest),signature:encodeBase64Url(exported.signature),
      sourceMessagingPublicKey:exported.sourceMessagingPublicKey},approval:{payload:encodeBase64Url(approvalSigned.payloadBytes),
       signature:encodeBase64Url(approvalSigned.signature)},operation:encodeBase64Url(cutoverBytes),...(publicRuntime?{monitor:{
         payload:encodeBase64Url(monitorSigned.payloadBytes),signature:encodeBase64Url(monitorSigned.signature)}}:{})});
    if(publicRuntime) {
      const withoutMonitor=JSON.parse(completionBody);delete withoutMonitor.monitor;
      expect(await withFreshServingGenerations(target.sql,()=>completion.complete(withoutMonitor))).toMatchObject({phase:"awaiting-monitor",operationCid:cutoverCid});
      expect(await target.sql`SELECT 1 FROM provider_accounts WHERE id=${accountId}`).toHaveLength(0);
    }
    const complete=()=>withFreshServingGenerations(target.sql,()=>completionApp.request(
      "https://b.example.com/.well-known/hail/transfers/managed-completions",{method:"POST",
        headers:{"Content-Type":TRANSFER_MEDIA_TYPE},body:completionBody}));
    phase="completion route retries";
    const completed=await complete();if(completed.status!==200)throw new Error(await completed.text());expect(await completed.json()).toMatchObject({
      type:"hailp.managed-transfer-completion",did,accountId,transferId:offer.transfer_id,generation:2,phase:"active"});
    if(publicRuntime)expect(await target.sql`SELECT 1 FROM public_cutover_evidence_selection WHERE transfer_id=${offer.transfer_id} AND activated_at IS NOT NULL`).toHaveLength(1);
    expect((await complete()).status).toBe(200);
    if(publicRuntime) {
      readerFailure=true;await expect(activation.activate(offer.transfer_id)).rejects.toThrow(/No configured PLC reader/);readerFailure=false;
      await expect(target.sql`DELETE FROM public_cutover_evidence`).rejects.toThrow(/immutable/);
      expect(await target.sql`SELECT 1 FROM managed_custody_evidence WHERE account_id=${accountId} AND verification_mode='strict-public-v1'`).toHaveLength(1);
    }
    expect(await withFreshServingGenerations(target.sql,()=>activation.activate(offer.transfer_id)))
      .toEqual({did,accountId,generation:2});
    expect(await withFreshServingGenerations(target.sql,()=>activation.activate(offer.transfer_id)))
      .toEqual({did,accountId,generation:2});
    expect((await target.sql<{onboarding_state:string;canonical_address:string}[]>`SELECT onboarding_state,canonical_address
      FROM provider_accounts WHERE id=${accountId} AND did=${did}`)[0]).toEqual({onboarding_state:"active",canonical_address:"alice@b.example.com"});
    expect(Number((await target.sql<{generation:number|string}[]>`SELECT generation FROM account_serving_generations WHERE account_id=${accountId}`)[0]?.generation)).toBe(2);
    expect((await target.sql<{provider_identity_public_key:string}[]>`SELECT provider_identity_public_key FROM managed_custody_evidence
      WHERE account_id=${accountId}`)[0]?.provider_identity_public_key).toBe(offer.destination_identity_key);
    expect(await target.sql`SELECT 1 FROM account_keys WHERE account_id=${accountId} AND public_key IN
      (${offer.destination_rotation_key},${offer.destination_identity_key},${offer.destination_messaging_key})`).toHaveLength(3);
    const migratedGrant=(await target.sql<{current_revision:number;current_digest:Uint8Array;cose:Uint8Array;previous_digest:Uint8Array;
      signing_public_key:string}[]>`SELECT lineage.current_revision,lineage.current_digest,revision.cose,revision.previous_digest,revision.signing_public_key
      FROM grant_lineages lineage JOIN grant_revisions revision ON revision.grant_id=lineage.grant_id AND revision.revision=lineage.current_revision
      WHERE lineage.grant_id=${grantId}`)[0]!;
    expect(migratedGrant.current_revision).toBe(2);expect(migratedGrant.signing_public_key).toBe(offer.destination_identity_key);
    expect(Buffer.from(migratedGrant.previous_digest)).toEqual(Buffer.from(grantDigest));
    expect((await verifySignedPayload("hail.grant",migratedGrant.cose,
      createWebCryptoVerifier(()=>ed25519PublicKeyFromDidKey(offer.destination_identity_key)))).payload).toMatchObject({revision:2,key_id:`${did}#hail-identity`});
    expect(await target.sql`SELECT 1 FROM detached_bodies WHERE sender_account_id=${accountId} AND digest=${bodyHash}`).toHaveLength(1);
    expect((await target.sql<{state:string}[]>`SELECT state FROM delivery_work WHERE sender_did=${grantee} AND message_id=${incomingId}`)[0]?.state).toBe("accepted");
    expect(await target.sql`SELECT 1 FROM account_api_credentials WHERE account_id=${accountId}`).toHaveLength(0);
    phase="source retirement";
    const receipt=await activation.issueReceipt(offer.transfer_id);
    expect(await activation.issueReceipt(offer.transfer_id)).toEqual(receipt);
    const retire=()=>withFreshServingGenerations(source.sql,()=>sourceApp.request(
      `${sourceOrigin}/.well-known/hail/transfers/managed-retirements`,{method:"POST",
        headers:{"Content-Type":TRANSFER_MEDIA_TYPE},body:Uint8Array.from(requestWire(receipt))}));
    const retained=await retire();expect(retained.status).toBe(204);
    // The first 204 may be lost; the exact receipt remains safe to replay.
    expect((await retire()).status).toBe(204);
    expect((await source.sql<{state:string}[]>`SELECT state FROM provider_migration_fences WHERE transfer_id=${offer.transfer_id}`)[0]?.state).toBe("retired");
    expect(await source.sql`SELECT 1 FROM provider_retired_transfer_history WHERE transfer_id=${offer.transfer_id}`).toHaveLength(1);
    expect((await source.sql<{revoked_at:Date|null}[]>`SELECT revoked_at FROM account_api_credentials WHERE account_id=${accountId}`)
      .every(row=>row.revoked_at instanceof Date)).toBe(true);
    const changedReceipt={...receipt,signature:Uint8Array.from(receipt.signature)};
    changedReceipt.signature[0]=(changedReceipt.signature[0]??0)^1;
    const changedRetirement=await withFreshServingGenerations(source.sql,()=>sourceApp.request(
      `${sourceOrigin}/.well-known/hail/transfers/managed-retirements`,{method:"POST",
        headers:{"Content-Type":TRANSFER_MEDIA_TYPE},body:Uint8Array.from(requestWire(changedReceipt))}));
    expect(changedRetirement.status).toBe(400);
    await withFreshServingGenerations(target.sql,()=>target.sql`UPDATE grant_publications SET state='acknowledged',
      acknowledged_etag='"grant-v2"',acknowledged_at=clock_timestamp() WHERE grant_id=${grantId} AND revision=2`);
    phase="return preparation";
    const returnNow=Math.floor(Date.now()/1000),returnGrantValue:ManagedTransferGrant={type:"hail.managed-transfer-grant",version:1,did,
      nonce:randomUUID(),source_service_base:targetBase,destination_service_base:sourceBase,destination_domain:"a.example.com",
      owner_recovery_key:owner.did(),source_identity_key:offer.destination_identity_key,issued_at:returnNow,expires_at:returnNow+3600};
    const returnGrantBytes=encodeManagedHandshake(returnGrantValue),returnGrant={payloadBytes:returnGrantBytes,
      signature:await owner.sign(managedHandshakeSignatureInput(returnGrantValue.type,returnGrantBytes))};
    const currentMessaging=(await target.sql<{public_key:string;encrypted_private_key:Uint8Array;encryption_nonce:Uint8Array}[]>`
      SELECT public_key,encrypted_private_key,encryption_nonce FROM account_keys WHERE account_id=${accountId} AND role='hail-messaging'`)[0]!;
    const currentMessagingSecret=await targetEncryptor.decrypt(accountId,"hail-messaging","ed25519",currentMessaging.public_key,
      {ciphertext:currentMessaging.encrypted_private_key,nonce:currentMessaging.encryption_nonce,encryptionVersion:1,kekId:"poc-v1"});
    const returnAcknowledgementValue:ManagedTransferAcknowledgement={type:"hail.managed-transfer-acknowledgement",version:1,did,
      nonce:returnGrantValue.nonce,source_service_base:targetBase,destination_service_base:sourceBase,
      grant_digest:managedHandshakeDigest(returnGrant.payloadBytes),source_messaging_key:offer.destination_messaging_key,
      issued_at:returnNow,expires_at:returnNow+3600};
    let returnAcknowledgement;
    try{returnAcknowledgement=await signManagedProviderHandshake(returnAcknowledgementValue,await importEd25519PrivateKey(currentMessagingSecret));}
    finally{currentMessagingSecret.fill(0);}
    const returnTarget=new PreparedMigrationTarget(source.sql,sourceEncryptor,sourceBase,true),returnReceiver=new ManagedTransferInvitationReceiver(
      source.sql,resolver,returnTarget),returnOfferSigned=await returnReceiver.receive(returnGrant,returnAcknowledgement);
    const returnOffer=await verifyManagedProviderHandshake(returnOfferSigned,"hail.managed-transfer-offer",
      (decodeDeterministic(returnOfferSigned.payloadBytes) as Record<string,string>).destination_messaging_key!);
    const returnSelectionValue:ManagedTransferAddressSelection={type:"hail.managed-transfer-address-selection",version:1,did,
      nonce:returnGrantValue.nonce,transfer_id:returnOffer.transfer_id,grant_digest:managedHandshakeDigest(returnGrant.payloadBytes),
      offer_digest:managedHandshakeDigest(returnOfferSigned.payloadBytes),address:"alice-return@a.example.com",selection_nonce:randomUUID(),
      issued_at:returnNow,expires_at:returnNow+1800};
    const returnSelectionBytes=encodeManagedHandshake(returnSelectionValue),returnSelection={payloadBytes:returnSelectionBytes,
      signature:await owner.sign(managedHandshakeSignatureInput(returnSelectionValue.type,returnSelectionBytes))};
    const returnedReservation=await new ManagedTransferAddressReservation(source.sql,resolver,returnTarget).reserve(returnSelection);
    const returnKeys=returnedReservation.prepared,returnTransfer=returnOffer.transfer_id;
    await target.sql`INSERT INTO provider_migration_fences(did,account_id,transfer_id,destination_service_base,
      destination_rotation_public_key,destination_messaging_public_key,state,source_custody_profile,
      owner_recovery_public_key,source_identity_public_key,destination_identity_public_key)
      VALUES(${did},${accountId},${returnTransfer},${sourceBase},${returnKeys.rotationPublicKey},${returnKeys.messagingPublicKey},
        'fenced','managed',${owner.did()},${offer.destination_identity_key},${returnKeys.identityPublicKey})`;
    await source.sql`UPDATE transfer_address_reservations SET state='submitted' WHERE transfer_id=${returnTransfer}`;
    const returnExport=await new ManagedMigrationExportService(target.sql,new OnboardingRepository(target.sql),targetEncryptor,targetResolver,targetBase,undefined,profile)
      .exportFenced({did,accountId,transferId:returnTransfer,destinationServiceBase:sourceBase,ownerRecoveryPublicKey:owner.did(),
        sourceIdentityPublicKey:offer.destination_identity_key,destinationIdentityPublicKey:returnKeys.identityPublicKey!,
        destinationRotationPublicKey:returnKeys.rotationPublicKey,destinationMessagingPublicKey:returnKeys.messagingPublicKey,state:"fenced"});
    const returnManifest=validateManagedTransferManifest(returnExport.bytes);
    expect(returnManifest.sourceGeneration).toBe(2);
    await expect(validateManagedReturningEvidence(source.sql,returnManifest)).resolves.toMatchObject({account_id:accountId,generation:"1"});
    const changedHistory=structuredClone(returnManifest);
    changedHistory.tables.grant_revisions[0]!.cose=`\\x${"00".repeat(64)}`;
    await expect(validateManagedReturningEvidence(source.sql,changedHistory)).rejects.toThrow(/loses or conflicts/);
    await expect(source.sql.begin(async tx=>{
      expect(await replaceRetiredManagedProjection(tx,returnManifest)).toBe(3);
      expect(Number((await tx<{generation:string|number}[]>`SELECT generation FROM account_serving_generations WHERE account_id=${accountId}`)[0]?.generation)).toBe(3);
      throw new Error("rollback return rehearsal");
    })).rejects.toThrow("rollback return rehearsal");
    expect(Number((await source.sql<{generation:string|number}[]>`SELECT generation FROM account_serving_generations WHERE account_id=${accountId}`)[0]?.generation)).toBe(1);
    const returnCutover=await signOperation({type:"plc_operation",prev:cutoverCid,
      rotationKeys:[owner.did(),returnKeys.rotationPublicKey],verificationMethods:{...destinationState.verificationMethods,
        "hail-identity":returnKeys.identityPublicKey!,"hail-messaging":returnKeys.messagingPublicKey},
      alsoKnownAs:destinationState.alsoKnownAs,services:{...destinationState.services,
        hail:{type:"HailMessaging",endpoint:sourceBase}}},owner);
    const returnCutoverBytes=new TextEncoder().encode(JSON.stringify(returnCutover)),returnCid=(await cidForCbor(returnCutover)).toString();
    const returnApprovalValue:ManagedTransferApproval={type:"hail.managed-transfer-approval",version:1,did,nonce:returnGrantValue.nonce,
      transfer_id:returnTransfer,source_service_base:targetBase,destination_service_base:sourceBase,
      destination_address:returnSelectionValue.address,owner_recovery_key:owner.did(),source_identity_key:offer.destination_identity_key,
      destination_rotation_key:returnKeys.rotationPublicKey,destination_identity_key:returnKeys.identityPublicKey!,
      destination_messaging_key:returnKeys.messagingPublicKey,grant_digest:managedHandshakeDigest(returnGrant.payloadBytes),
      offer_digest:managedHandshakeDigest(returnOfferSigned.payloadBytes),selection_digest:managedHandshakeDigest(returnSelection.payloadBytes),
      snapshot_version:4,snapshot_digest:returnExport.digest,history_checkpoint_digest:decodeBase64Url(returnManifest.historyCheckpointDigest),
      source_generation:2,previous_operation_cid:cutoverCid,operation_cid:returnCid,issued_at:returnNow,expires_at:returnNow+900};
    const returnApprovalBytes=encodeManagedHandshake(returnApprovalValue),returnApproval={payloadBytes:returnApprovalBytes,
      signature:await owner.sign(managedHandshakeSignatureInput(returnApprovalValue.type,returnApprovalBytes))};
    const returnStager=new ManagedMigrationStageService(source.sql,resolver,returnTarget,sourceBase,()=>returnNow,profile);
    expect(await returnStager.stage(returnExport,returnApproval,returnCutoverBytes)).toEqual(returnManifest);
    await expect(new ManagedMigrationPlcSubmission(source.sql,plc,resolver,sourceBase).submit(returnTransfer)).resolves.toBe(returnCid);
    const returnState=(await validateOperationLog(did,plcLog))!,returnVerifiedAt=new Date().toISOString(),returnAudit=await readers[0].audit(did),returnBundle=encodeDeterministic({
      type:"hail.public-plc-resolution",version:1,policy:"strict-public-v1",did,operation_cid:returnCid,verified_at:returnVerifiedAt,
      witnesses:[{state:returnState,audit:returnAudit}]} as unknown as HailValue),
      returnEvidenceDigest=new Uint8Array(createHash("sha256").update(returnBundle).digest());
    await source.sql`INSERT INTO public_plc_resolution_evidence
      (evidence_digest,did,operation_cid,verified_at,bundle_bytes,record_version,read_evidence_policy_version)
      VALUES(${returnEvidenceDigest},${did},${returnCid},${returnVerifiedAt},${returnBundle},1,'hail.plc-read-evidence-v1')`;
    const returnResolver={async resolve(value:string){const result=await resolver.resolve(value);return {...result,evidence:{...result.evidence,
      verification:{profile:"poc-local" as const,digest:encodeBase64Url(returnEvidenceDigest),operationCid:returnCid,verifiedAt:returnVerifiedAt}}};}};
    const returnStaged=(await source.sql<{destination_binding_cose:Uint8Array;destination_binding_digest:Uint8Array}[]>`
      SELECT destination_binding_cose,destination_binding_digest FROM pending_migration_imports WHERE transfer_id=${returnTransfer}`)[0]!;
    const returnBinding=decodeDeterministic((await verifySignedPayload("hail.address-binding",returnStaged.destination_binding_cose,
      createWebCryptoVerifier(()=>ed25519PublicKeyFromDidKey(returnKeys.identityPublicKey!)))).payloadBytes) as any;
    const returnVerifier={async verify(address:string){return {address,did,serviceBase:sourceBase,identityDidKey:returnKeys.identityPublicKey!,
      messagingDidKey:returnKeys.messagingPublicKey,plcEvidence:(await returnResolver.resolve(did)).evidence,verifiedAt:new Date(),
      binding:returnBinding,representation:returnStaged.destination_binding_cose,digest:returnStaged.destination_binding_digest};}};
    const returnRuntime=profile==="strict-public-v1"?createPublicManagedRuntime(runtimeConfig(sourceOrigin),source.sql,plc as never,
      new OnboardingRepository(source.sql),sourceEncryptor,{fetch:async()=>{throw new Error("unexpected network");},validateTarget:()=>{}},returnVerifier,readers):undefined;
    const returnActivation=returnRuntime?.activation??new ManagedMigrationActivation(source.sql,sourceEncryptor,returnResolver,returnVerifier,sourceBase,"http://plc.fixture:2582","poc-local");
    const returnMonitor=await attestation(returnTransfer,returnCid);
    phase="return activation";
    expect(await withFreshServingGenerations(source.sql,()=>returnActivation.activate(returnTransfer,returnMonitor))).toEqual({did,accountId,generation:3});
    expect(await withFreshServingGenerations(source.sql,()=>returnActivation.activate(returnTransfer))).toEqual({did,accountId,generation:3});
    expect(Number((await source.sql<{generation:string|number}[]>`SELECT generation FROM account_serving_generations WHERE account_id=${accountId}`)[0]?.generation)).toBe(3);
    expect((await source.sql<{canonical_address:string}[]>`SELECT canonical_address FROM provider_accounts WHERE id=${accountId}`)[0]?.canonical_address)
      .toBe("alice-return@a.example.com");
    expect(await source.sql`SELECT 1 FROM account_keys WHERE account_id=${accountId} AND public_key IN
      (${returnKeys.rotationPublicKey},${returnKeys.identityPublicKey!},${returnKeys.messagingPublicKey})`).toHaveLength(3);
    const returnedGrant=(await source.sql<{current_revision:number;signing_public_key:string;previous_digest:Uint8Array}[]>`
      SELECT lineage.current_revision,revision.signing_public_key,revision.previous_digest FROM grant_lineages lineage
      JOIN grant_revisions revision ON revision.grant_id=lineage.grant_id AND revision.revision=lineage.current_revision
      WHERE lineage.grant_id=${grantId}`)[0]!;
    expect(returnedGrant.current_revision).toBe(3);expect(returnedGrant.signing_public_key).toBe(returnKeys.identityPublicKey);
    expect(Buffer.from(returnedGrant.previous_digest)).toEqual(Buffer.from(migratedGrant.current_digest));
    const returnedTerminal=(await source.sql<{current_revision:number;current_status:string;cose:Uint8Array;current_digest:Uint8Array}[]>`
      SELECT lineage.current_revision,lineage.current_status,revision.cose,lineage.current_digest FROM grant_lineages lineage
      JOIN grant_revisions revision ON revision.grant_id=lineage.grant_id AND revision.revision=lineage.current_revision
      WHERE lineage.grant_id=${terminalGrantId}`)[0]!;
    expect(returnedTerminal.current_revision).toBe(1);expect(returnedTerminal.current_status).toBe("revoked");
    expect(Buffer.from(returnedTerminal.cose)).toEqual(Buffer.from(terminalGrantCose));
    expect(Buffer.from(returnedTerminal.current_digest)).toEqual(Buffer.from(terminalGrantDigest));
    expect((await source.sql<{revoked_at:Date|null}[]>`SELECT revoked_at FROM account_api_credentials WHERE account_id=${accountId}`)
      .every(row=>row.revoked_at instanceof Date)).toBe(true);
    await expect(withServingGeneration(accountId,1,()=>source.sql`UPDATE provider_accounts SET updated_at=clock_timestamp() WHERE id=${accountId}`))
      .rejects.toThrow(/stale/);
    const returnReceipt=await returnActivation.issueReceipt(returnTransfer);
    const targetFence=new ManagedMigrationFenceService(target.sql,targetResolver,targetBase,undefined,profile);
    await targetFence.retire(did,returnTransfer,returnReceipt);await targetFence.retire(did,returnTransfer,returnReceipt);
    const archivedImport=(await target.sql<{prepared:string}[]>`SELECT prepared_public_record::text AS prepared
      FROM provider_retired_import_history WHERE transfer_id=${offer.transfer_id}`)[0]?.prepared??"";
    expect(archivedImport).not.toContain("private_ciphertext");expect(archivedImport).not.toContain("identity_nonce");
    const rollback49=await target.sql.reserve();try {
      await expect(rollback49.unsafe(await Bun.file(new URL("../migrations/rollback/0049_managed_migration_materialization.sql",import.meta.url)).text()))
        .rejects.toThrow("active imports exist");
    } finally {await rollback49.unsafe("ROLLBACK");rollback49.release();}
  } catch(error) {throw new Error(`${profile}: ${phase}`,{cause:error});}
  finally {await source.close();await target.close();await admin.unsafe(`DROP SCHEMA "${sourceSchema}" CASCADE`);
    await admin.unsafe(`DROP SCHEMA "${targetSchema}" CASCADE`);await admin.close();}
},45_000);
