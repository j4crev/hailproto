import { createHash, randomBytes, randomUUID } from "node:crypto";
import { SQL } from "bun";
import { cidForCbor } from "@atproto/common";
import { P256Keypair } from "@atproto/crypto";
import { didForCreateOp, formatDidDoc, PlcClientError, signOperation, validateOperationLog, type Operation } from "@did-plc/lib";
import { createWebCryptoSigner, encodeBase64Url, encodeDeterministic, signPayload, type HailGrant, type HailValue } from "@hailproto/codec";
import { expect, it } from "vitest";
import { Hono } from "hono";
import { SameProviderCustodyTransition, type CustodyTransitionApproval } from "../src/accounts/custody-transition.js";
import { registerAccountApiRoutes } from "../src/accounts/routes.js";
import { AccountApiRepository, tokenHash } from "../src/accounts/repository.js";
import { ProviderDatabase } from "../src/db/database.js";
import { withServingGeneration } from "../src/db/serving.js";
import { KeyEncryptor } from "../src/identity/key-encryption.js";
import { uuidV7 } from "../src/identity/uuid-v7.js";
import { GrantRepository } from "../src/grants/repository.js";
import type { GrantService } from "../src/grants/service.js";
import { signOnboardingMonitorAttestation } from "../src/migration/monitor-attestation.js";
import { OnboardingRepository } from "../src/onboarding/repository.js";
import { PublicOnboarding } from "../src/onboarding/public.js";
import type { PlcDirectoryClient } from "../src/plc/client.js";
import { PlcHailDidResolver } from "../src/plc/resolver.js";
import { VerifiedPublicPlcResolver } from "../src/plc/public-resolver.js";
import { plcStateDigest } from "../src/plc/read-evidence.js";
import { publicEdKey } from "./public-plc-fixture.js";

const integration=process.env.DATABASE_URL?it:it.skip;
integration("same-provider custody changes are owner-approved, retryable and atomic in both directions",async()=>{
  const admin=new SQL(process.env.DATABASE_URL!),schema=`custody_${randomUUID().replaceAll("-","")}`;
  await admin.unsafe(`CREATE SCHEMA "${schema}"`);const url=new URL(process.env.DATABASE_URL!);
  url.searchParams.set("options",`-csearch_path=${schema}`);const db=new ProviderDatabase(url.toString());
  const logs=new Map<string,Operation[]>(),auditBase=Date.now();let ambiguousUpdate=false;
  const plc:PlcDirectoryClient={async health(){return{};},async sendOperation(did,operation){
    const current=logs.get(did)??[],candidate=(await cidForCbor(operation)).toString();let retained=false;
    for(const item of current)if((await cidForCbor(item)).toString()===candidate)retained=true;
    if(!retained)logs.set(did,[...current,operation]);
    if(ambiguousUpdate){ambiguousUpdate=false;throw new Error("lost response");}},
    async getOperationLog(did){const value=logs.get(did);if(!value)throw new PlcClientError(404,null,"missing");return value;},
    async getDocumentData(did){return (await validateOperationLog(did,await this.getOperationLog(did)))!;},
    async getDocument(did){return formatDidDoc(await this.getDocumentData(did));},
    async getAuditableLog(did){return Promise.all((await this.getOperationLog(did)).map(async(operation,index)=>({did,operation,
      cid:(await cidForCbor(operation)).toString(),nullified:false,createdAt:new Date(auditBase+index*1000).toISOString()})));}};
  const reader=(name:string)=>({origin:`https://reader-${name}.example.com`,operator:`reader-${name}`,
    resolver:new PlcHailDidResolver(plc),audit:(did:string)=>plc.getAuditableLog(did),
    health:async()=>({lastCommittedOpTime:new Date().toISOString()})});
  const resolver=new VerifiedPublicPlcResolver(db.sql,[reader("one"),reader("two")],["provider"],["https://local.example.com"]);
  const repository=new OnboardingRepository(db.sql),serviceBase="https://local.example.com/hail";
  const verifier={async verify(address:string){const account=await repository.getAccountByAddress(address),binding=await repository.getBindingForAccount(account.id);
    const resolved=await resolver.resolve(account.did!);return {address,did:account.did!,serviceBase:resolved.serviceBase,
      identityDidKey:resolved.identityDidKey,messagingDidKey:resolved.messagingDidKey,plcEvidence:resolved.evidence,verifiedAt:new Date(),
      binding:(await import("@hailproto/codec")).inspectSignedPayload("hail.address-binding",binding.cose).payload,
      representation:binding.cose,digest:binding.digest};}};
  const encryptor=new KeyEncryptor(encodeBase64Url(randomBytes(32)));
  try{
    await db.migrate();const owner=await P256Keypair.create(),identity=await publicEdKey(),monitor=await publicEdKey();
    const address=`custody-${randomUUID()}@local.example.com`,onboarding=new PublicOnboarding(db.sql,plc,resolver,encryptor,
      "https://plc.directory",serviceBase,verifier);
    const prepared=await onboarding.prepare(address,owner.did(),identity.didKey,true,"owner-controlled","https://monitor.example.com",monitor.didKey);
    const genesis=await signOperation({type:"plc_operation",prev:null,rotationKeys:[owner.did(),prepared.providerRotationKey],
      verificationMethods:{"hail-identity":identity.didKey,"hail-messaging":prepared.providerMessagingKey},alsoKnownAs:[],
      services:{hail:{type:"HailMessaging",endpoint:serviceBase}}},owner),did=await didForCreateOp(genesis),now=Math.floor(Date.now()/1000);
    const binding=await signPayload("hail.address-binding",{type:"hail.address-binding",version:1,address,did,issued_at:now,
      expires_at:now+86400,key_id:`${did}#hail-identity`},createWebCryptoSigner(`${did}#hail-identity`,identity.pair.privateKey));
    const registered=await onboarding.register(prepared.accountId,new TextEncoder().encode(JSON.stringify(genesis)),binding);
    const attestation=await signOnboardingMonitorAttestation({type:"hail.plc-onboarding-monitor-attestation",version:1,did,
      operation_cid:registered.operationCid,monitor_origin:"https://monitor.example.com",coverage_since:now-100,
      observed_at:now,bootstrap_state_digest:plcStateDigest(await plc.getDocumentData(did)),export_sequence:1},monitor.pair.privateKey);
    await onboarding.activate(prepared.accountId,attestation);

    const grantee=`did:plc:${"b".repeat(24)}`,grantId=uuidV7(),grant:HailGrant={type:"hail.grant",version:1,grant_id:grantId,
      revision:1,previous:null,grantor:did,grantee,scope:[{type:"uncategorized"}],status:"active",issued_at:now,updated_at:now,
      expires_at:null,consent_context:{grantee_address:"peer@peer.example.com",address_binding_hash:{algorithm:"sha-256",value:randomBytes(32)},
        sender_profile_hash:{algorithm:"sha-256",value:randomBytes(32)}},key_id:`${did}#hail-identity`};
    const grantCose=await signPayload("hail.grant",grant,createWebCryptoSigner(`${did}#hail-identity`,identity.pair.privateKey)),grantDigest=new Uint8Array(createHash("sha256").update(grantCose).digest());
    const lease=randomUUID();
    await db.sql`INSERT INTO grant_lineages (grant_id,local_account_id,local_role,grantor_did,grantee_did,current_revision,current_digest,current_status)
      VALUES (${grantId},${prepared.accountId},'grantor',${did},${grantee},1,${grantDigest},'active')`;
    await db.sql`INSERT INTO grant_revisions (grant_id,revision,status,issued_at,updated_at,expires_at,previous_digest,scope_payload,
      consent_address_binding_sha256,consent_sender_profile_sha256,cose,representation_digest,signing_public_key,
      signing_plc_document,signing_plc_data,signing_plc_operation_log) VALUES (${grantId},1,'active',${now},${now},NULL,NULL,
      ${JSON.stringify(grant.scope)}::jsonb,${grant.consent_context.address_binding_hash.value},${grant.consent_context.sender_profile_hash.value},
      ${grantCose},${grantDigest},${identity.didKey},'{}','{}','[]')`;
    await db.sql`INSERT INTO grant_publications (grant_id,revision,destination_service_base,state,acknowledged_etag,acknowledged_at,lease_token,lease_expires_at)
      VALUES (${grantId},1,'https://peer.example.com/hail','acknowledged','"grant-v1"',clock_timestamp(),${lease},clock_timestamp()+interval '5 minutes')`;
    const terminalId=uuidV7();await db.sql`INSERT INTO grant_lineages (grant_id,local_account_id,local_role,grantor_did,grantee_did,current_revision,current_digest,current_status)
      VALUES (${terminalId},${prepared.accountId},'grantor',${did},${`did:plc:${"c".repeat(24)}`},1,${randomBytes(32)},'revoked')`;
    await db.sql`INSERT INTO grant_revisions (grant_id,revision,status,issued_at,updated_at,scope_payload,consent_address_binding_sha256,
      consent_sender_profile_sha256,cose,representation_digest,signing_public_key,signing_plc_document,signing_plc_data,signing_plc_operation_log)
      VALUES (${terminalId},1,'revoked',${now},${now},'[]',${randomBytes(32)},${randomBytes(32)},${randomBytes(64)},${randomBytes(32)},${identity.didKey},'{}','{}','[]')`;
    const credentialToken=`hailp_${encodeBase64Url(randomBytes(32))}`,credential=randomUUID();await db.sql`INSERT INTO account_api_credentials (id,account_id,token_hash,scopes,expires_at)
      VALUES (${credential},${prepared.accountId},${tokenHash(credentialToken)},'["account:read","account:write"]',clock_timestamp()+interval '1 day')`;
    const challenge=randomUUID();await db.sql`INSERT INTO account_access_challenges (id,token_hash,payload,expires_at)
      VALUES (${challenge},${randomBytes(32)},(${JSON.stringify({accountId:prepared.accountId})}::text)::jsonb,clock_timestamp()+interval '4 minutes')`;

    const service=new SameProviderCustodyTransition(db.sql,plc,resolver,encryptor,serviceBase,verifier);
    const app=new Hono();registerAccountApiRoutes(app,new AccountApiRepository(db.sql),new GrantRepository(db.sql),{} as GrantService,
      "https://local.example.com",undefined,undefined,undefined,service);
    const preparedResponse=await app.request("https://local.example.com/api/v1/account/custody/managed",{method:"POST",
      headers:{Authorization:`Bearer ${credentialToken}`,"Content-Type":"application/json"},body:"{}"});
    expect(preparedResponse.status).toBe(200);const preparedWire=await preparedResponse.json() as {transitionId:string;newIdentityKey:string};
    const transition=await service.prepare(prepared.accountId);expect(preparedWire.transitionId).toBe(transition.transitionId);
    expect(preparedWire.newIdentityKey).toBe(transition.newIdentityKey);expect((await service.prepare(prepared.accountId)).newIdentityKey).toBe(transition.newIdentityKey);
    expect((await db.sql`SELECT account_id FROM managed_custody_evidence WHERE account_id=${prepared.accountId}`)).toHaveLength(0);
    await expect(db.sql`UPDATE grant_lineages SET updated_at=clock_timestamp() WHERE grant_id=${grantId}`).rejects.toThrow("custody-transition-fenced");
    const operation=await signOperation(transition.unsignedOperation,owner),operationBytes=new TextEncoder().encode(JSON.stringify(operation));
    const operationCid=(await cidForCbor(operation)).toString(),issued=Math.floor(Date.now()/1000);
    const approval:CustodyTransitionApproval={type:"hailp.custody-transition",version:1,transition_id:transition.transitionId,did,
      direction:"owner-to-managed",provider_service_base:serviceBase,owner_recovery_key:owner.did(),old_identity_key:identity.didKey,
      new_identity_key:transition.newIdentityKey,previous_operation_cid:transition.previousOperationCid,operation_cid:operationCid,
      history_checkpoint_sha256:transition.historyCheckpointDigest,binding_sha256:transition.bindingDigest,
      generation_from:transition.generationFrom,generation_to:transition.generationTo,nonce:randomUUID(),issued_at:issued,expires_at:issued+1800};
    const approvalBytes=encodeDeterministic(approval as unknown as HailValue),tag=new TextEncoder().encode("hailp.custody-transition.v1\0"),input=new Uint8Array(tag.length+approvalBytes.length);
    input.set(tag);input.set(approvalBytes,tag.length);const signature=await owner.sign(input);ambiguousUpdate=true;
    const changedOperation=await signOperation({...transition.unsignedOperation,alsoKnownAs:["at://unapproved.example.com"]},owner);
    await expect(service.commit(prepared.accountId,transition.transitionId,new TextEncoder().encode(JSON.stringify(changedOperation)),approvalBytes,signature)).rejects.toThrow("full state");
    const changedApproval=encodeDeterministic({...approval,binding_sha256:randomBytes(32)} as unknown as HailValue),changedInput=new Uint8Array(tag.length+changedApproval.length);
    changedInput.set(tag);changedInput.set(changedApproval,tag.length);
    await expect(service.commit(prepared.accountId,transition.transitionId,operationBytes,changedApproval,await owner.sign(changedInput))).rejects.toThrow("does not match");
    await expect(service.commit(randomUUID(),transition.transitionId,operationBytes,approvalBytes,signature)).rejects.toThrow("does not exist");
    const completed=await service.commit(prepared.accountId,transition.transitionId,operationBytes,approvalBytes,signature);expect(completed.generation).toBe(2);
    expect(await service.commit(prepared.accountId,transition.transitionId,operationBytes,approvalBytes,signature)).toEqual(completed);
    await expect(service.commit(prepared.accountId,transition.transitionId,operationBytes,approvalBytes,Uint8Array.from(signature,b=>b^1))).rejects.toThrow();
    expect(await db.sql`SELECT account_id FROM portable_custody_evidence WHERE account_id=${prepared.accountId}`).toHaveLength(0);
    expect(await db.sql`SELECT account_id FROM managed_custody_evidence WHERE account_id=${prepared.accountId} AND provider_identity_public_key=${transition.newIdentityKey}`).toHaveLength(1);
    expect(await db.sql`SELECT role FROM account_keys WHERE account_id=${prepared.accountId} AND role='hail-identity' AND public_key=${transition.newIdentityKey}`).toHaveLength(1);
    expect(Number((await db.sql<{generation:number}[]>`SELECT generation FROM account_serving_generations WHERE account_id=${prepared.accountId}`)[0]!.generation)).toBe(2);
    expect((await db.sql<{revoked_at:Date|null}[]>`SELECT revoked_at FROM account_api_credentials WHERE id=${credential}`)[0]!.revoked_at).not.toBeNull();
    expect(await db.sql`SELECT challenge_id FROM account_challenge_generations binding JOIN account_serving_generations current
      ON current.account_id=${prepared.accountId} AND current.generation=binding.generation WHERE binding.challenge_id=${challenge}`).toHaveLength(0);
    expect(await db.sql`SELECT lease_token FROM serving_worker_leases WHERE lease_token=${lease}`).toHaveLength(0);
    expect(await withServingGeneration(prepared.accountId,2,()=>db.sql`UPDATE grant_publications SET state='blocked'
      WHERE grant_id=${grantId} AND revision=1 AND lease_token=${lease} RETURNING grant_id`)).toHaveLength(0);
    const current=(await db.sql<{current_revision:number;current_digest:Uint8Array}[]>`SELECT current_revision,current_digest FROM grant_lineages WHERE grant_id=${grantId}`)[0]!;
    expect(current.current_revision).toBe(2);expect(await db.sql`SELECT grant_id FROM grant_revisions WHERE grant_id=${grantId}`).toHaveLength(2);
    expect(Buffer.from((await db.sql<{cose:Uint8Array}[]>`SELECT cose FROM grant_revisions WHERE grant_id=${grantId} AND revision=1`)[0]!.cose)).toEqual(Buffer.from(grantCose));
    expect((await db.sql<{current_revision:number}[]>`SELECT current_revision FROM grant_lineages WHERE grant_id=${terminalId}`)[0]!.current_revision).toBe(1);
    expect(await db.sql`SELECT transition_id FROM custody_transition_preparations WHERE transition_id=${transition.transitionId}
      AND state='complete' AND retired_custody_evidence IS NOT NULL AND managed_profile_version='hail-managed-custody-v1'`).toHaveLength(1);
    expect(await db.sql`SELECT id FROM address_bindings WHERE account_id=${prepared.accountId}`).toHaveLength(2);
    const connection=await db.sql.reserve();try{await expect(connection.unsafe(await Bun.file(new URL("../migrations/rollback/0045_same_provider_custody_transition.sql",import.meta.url)).text())).rejects.toThrow("rollback refused");}
    finally{await connection.unsafe("ROLLBACK");connection.release();}

    await withServingGeneration(prepared.accountId,2,()=>db.sql`UPDATE grant_publications SET state='acknowledged',acknowledged_etag='"grant-v2"',acknowledged_at=clock_timestamp()
      WHERE grant_id=${grantId} AND revision=2`);
    const nextIdentity=await publicEdKey(),review=await service.reviewOwner(prepared.accountId,nextIdentity.didKey);
    expect(review.direction).toBe("managed-to-owner");expect(review.activeGrants).toHaveLength(1);
    const ownerBinding=await signPayload("hail.address-binding",review.binding,
      createWebCryptoSigner(`${did}#hail-identity`,nextIdentity.pair.privateKey));
    const ownerGrants=await Promise.all(review.activeGrants.map(async item=>({grantId:item.grantId,
      cose:await signPayload("hail.grant",item.payload,createWebCryptoSigner(`${did}#hail-identity`,nextIdentity.pair.privateKey))})));
    const reverseToken=`hailp_${encodeBase64Url(randomBytes(32))}`;
    await withServingGeneration(prepared.accountId,2,()=>db.sql`INSERT INTO account_api_credentials (id,account_id,token_hash,scopes,expires_at)
      VALUES (${randomUUID()},${prepared.accountId},${tokenHash(reverseToken)},'["account:read","account:write"]',clock_timestamp()+interval '1 day')`);
    const reviewResponse=await app.request("https://local.example.com/api/v1/account/custody/owner-controlled/review",{method:"POST",
      headers:{Authorization:`Bearer ${reverseToken}`,"Content-Type":"application/json"},body:JSON.stringify({newIdentityKey:nextIdentity.didKey})});
    expect(reviewResponse.status).toBe(200);expect((await reviewResponse.json() as {direction:string}).direction).toBe("managed-to-owner");
    const reversePreparedResponse=await app.request("https://local.example.com/api/v1/account/custody/owner-controlled",{method:"POST",
      headers:{Authorization:`Bearer ${reverseToken}`,"Content-Type":"application/json"},body:JSON.stringify({newIdentityKey:nextIdentity.didKey,
        binding:encodeBase64Url(ownerBinding),grants:ownerGrants.map(value=>({grantId:value.grantId,cose:encodeBase64Url(value.cose)}))})});
    expect(reversePreparedResponse.status,await reversePreparedResponse.clone().text()).toBe(200);
    const reverse=await service.prepareOwner(prepared.accountId,nextIdentity.didKey,ownerBinding,ownerGrants);
    expect(reverse.direction).toBe("managed-to-owner");expect(reverse.generationFrom).toBe(2);
    const reverseOperation=await signOperation(reverse.unsignedOperation,owner),reverseBytes=new TextEncoder().encode(JSON.stringify(reverseOperation));
    const reverseCid=(await cidForCbor(reverseOperation)).toString(),reverseIssued=Math.floor(Date.now()/1000);
    const reverseApproval:CustodyTransitionApproval={type:"hailp.custody-transition",version:1,transition_id:reverse.transitionId,did,
      direction:"managed-to-owner",provider_service_base:serviceBase,owner_recovery_key:owner.did(),old_identity_key:transition.newIdentityKey,
      new_identity_key:nextIdentity.didKey,previous_operation_cid:reverse.previousOperationCid,operation_cid:reverseCid,
      history_checkpoint_sha256:reverse.historyCheckpointDigest,binding_sha256:reverse.bindingDigest,generation_from:2,generation_to:3,
      nonce:randomUUID(),issued_at:reverseIssued,expires_at:reverseIssued+1800};
    const reverseApprovalBytes=encodeDeterministic(reverseApproval as unknown as HailValue),reverseInput=new Uint8Array(tag.length+reverseApprovalBytes.length);
    reverseInput.set(tag);reverseInput.set(reverseApprovalBytes,tag.length);ambiguousUpdate=true;
    const reverseComplete=await service.commit(prepared.accountId,reverse.transitionId,reverseBytes,reverseApprovalBytes,await owner.sign(reverseInput));
    expect(reverseComplete.generation).toBe(3);
    expect(await db.sql`SELECT account_id FROM managed_custody_evidence WHERE account_id=${prepared.accountId}`).toHaveLength(0);
    expect(await db.sql`SELECT account_id FROM portable_custody_evidence WHERE account_id=${prepared.accountId}
      AND user_identity_public_key=${nextIdentity.didKey} AND monitor_verification_mode='independent'`).toHaveLength(1);
    expect(await db.sql`SELECT role FROM account_keys WHERE account_id=${prepared.accountId} AND role='hail-identity'`).toHaveLength(0);
    expect((await db.sql<{current_revision:number}[]>`SELECT current_revision FROM grant_lineages WHERE grant_id=${grantId}`)[0]!.current_revision).toBe(3);
    expect((await db.sql<{current_revision:number}[]>`SELECT current_revision FROM grant_lineages WHERE grant_id=${terminalId}`)[0]!.current_revision).toBe(1);
    const reverseRollback=await db.sql.reserve();try{await expect(reverseRollback.unsafe(await Bun.file(new URL("../migrations/rollback/0046_reverse_custody_transition.sql",import.meta.url)).text())).rejects.toThrow("rollback refused");}
    finally{await reverseRollback.unsafe("ROLLBACK");reverseRollback.release();}
  }finally{await db.close();await admin.unsafe(`DROP SCHEMA "${schema}" CASCADE`);await admin.close();}
},30_000);
