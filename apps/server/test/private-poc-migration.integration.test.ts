import { createHash,randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { cidForCbor } from "@atproto/common";
import { formatDidDoc, PlcClientError, validateOperationLog,assureValidNextOp,signOperation,didForCreateOp, type Operation } from "@did-plc/lib";
import {CID} from "multiformats/cid";
import { decodeBase64Url, decodeDeterministic, encodeBase64Url, inspectSignedPayload,
   createWebCryptoSigner,signPayload,type HailGrant,type HailEnvelope,type HailAddressBinding,type HailSenderProfile } from "@hailproto/codec";
import { Hono } from "hono";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createUserVault, unlockUserVault,unlockUserIdentity } from "../../hail-user-client-ts/src/vault.js";
import { AccountApiClient } from "../../hail-user-client-ts/src/account-api.js";
import { transferOffer,selectTransferAddress,exportTransferSnapshot,completeAccountTransfer,signAccountTransferCutover } from "../../hail-user-client-ts/src/account-transfer.js";
import { loginAccount } from "../../hail-user-client-ts/src/account-login.js";
import { AccountAccess } from "../src/accounts/access.js";
import { PrivatePocTransferCompletion } from "../src/migration/poc-completion.js";
import {withFreshServingGenerations,withServingGeneration} from "../src/db/serving.js";
import { AccountApiRepository } from "../src/accounts/repository.js";
import { AccountTransfer } from "../src/accounts/transfer.js";
import { registerAccountApiRoutes } from "../src/accounts/routes.js";
import { createApp } from "../src/app.js";
import { ProviderDatabase } from "../src/db/database.js";
import { AddressVerifier } from "../src/discovery/verifier.js";
import { KeyEncryptor } from "../src/identity/key-encryption.js";
import {generateAccountKeys,importEd25519PrivateKey} from "../src/identity/keys.js";
import {GrantRepository} from "../src/grants/repository.js";
import {EnvelopeRepository} from "../src/envelopes/repository.js";
import {DeliveryRepository} from "../src/delivery/repository.js";
import {DeliveryStatusSigner} from "../src/delivery/status.js";
import {TerminalStatusPublisher} from "../src/delivery/status-publisher.js";
import {bodyFromText} from "../src/bodies/service.js";
import {validateReturningEvidence} from "../src/migration/return.js";
import {PrivatePocTransferAbandonment} from "../src/migration/abandonment.js";
import {encodeSignedRecord,decodeSignedRecord} from "../src/migration/wire.js";
import { TransferAddressReservation } from "../src/migration/address-selection.js";
import { PortableMigrationActivation } from "../src/migration/activation.js";
import { MigrationFenceService } from "../src/migration/fence.js";
import { TransferFinalRequestPublisher } from "../src/migration/final-request-publisher.js";
import { TransferInvitationService,type SignedHandshake } from "../src/migration/handshake.js";
import { TransferGrantSubmission } from "../src/migration/grant-submission.js";
import { TransferCancellationService } from "../src/migration/cancellation.js";
import { TransferInvitationDelivery } from "../src/migration/invitation-delivery.js";
import { TransferInvitationReceiver } from "../src/migration/invitation-receiver.js";
import { PrivatePocAddressPublication } from "../src/migration/poc-address-publication.js";
import { PrivatePocCutoverGate } from "../src/migration/poc-cutover-gate.js";
import { PrivatePocPlcSubmission } from "../src/migration/poc-plc-submission.js";
import { registerTransferRoutes } from "../src/migration/routes.js";
import { PreparedMigrationTarget } from "../src/migration/target-keys.js";
import { MigrationTransferService } from "../src/migration/transfer.js";
import { ActivationService } from "../src/onboarding/activation.js";
import { PrivatePocOnboarding } from "../src/onboarding/private-poc.js";
import { OnboardingRepository } from "../src/onboarding/repository.js";
import type { PlcDirectoryClient } from "../src/plc/client.js";
import { PlcHailDidResolver } from "../src/plc/resolver.js";
import type { AppConfig } from "../src/config.js";

const integration = process.env.DATABASE_URL && process.env.TRANSFER_TARGET_DATABASE_URL ? describe : describe.skip;
const registry = "http://plc.fixture:2582";
const oldBase = "https://source.example.com/hail";
const newBase = "https://target.example.com/hail";

integration("private PLC transfer between disposable POC providers", () => {
  let source: ProviderDatabase;
  let target: ProviderDatabase;
  beforeAll(async () => {
    source = new ProviderDatabase(process.env.DATABASE_URL!);
    target = new ProviderDatabase(process.env.TRANSFER_TARGET_DATABASE_URL!);
    await source.migrate();
    await target.migrate();
  });
  afterAll(async () => { if (source) await source.close(); if (target) await target.close(); });

  it.each(["protective-first","cutover-first"] as const)("transfers, returns and coordinates never-active abandonment (%s)", async race => {
    const log: Operation[] = [];
    const peerLogs=new Map<string,Operation[]>();
    let did = "";
    const plc: PlcDirectoryClient = {
      health: async () => ({ status: "ok" }),
      async getOperationLog(value) {
        if(peerLogs.has(value))return peerLogs.get(value)!;
        if (value !== did || !log.length) throw new PlcClientError(404, null, "Unknown POC DID");
        return [...log];
      },
      async getDocumentData(value) {
        const state = await validateOperationLog(value, await this.getOperationLog(value));
        if (!state) throw new Error("Invalid POC PLC history");
        return state;
      },
      async getDocument(value) { return formatDidDoc(await this.getDocumentData(value)); },
      async getAuditableLog(value) {
        return Promise.all((await this.getOperationLog(value)).map(async (operation) => ({
          did: value, operation, cid: (await cidForCbor(operation)).toString(),
          nullified: false, createdAt: new Date().toISOString(),
        })));
      },
      async sendOperation(value, operation) {
        if (!did) {
          did = value;
          if (log.length) throw new Error("Duplicate genesis");
        } else if (value !== did || operation.prev !== (await cidForCbor(log.at(-1)!)).toString()) {
          throw new Error("Private PLC predecessor changed");
        }
        const updated = await validateOperationLog(value, [...log, operation]);
        if (!updated) throw new Error("Invalid private PLC operation");
        log.push(operation);
      },
    };
    const resolver = new PlcHailDidResolver(plc);
    const sourceRepo = new OnboardingRepository(source.sql);
    const targetRepo = new OnboardingRepository(target.sql);
    const sourceEncryptor = new KeyEncryptor(encodeBase64Url(randomBytes(32)));
    const targetEncryptor = new KeyEncryptor(encodeBase64Url(randomBytes(32)));
    const vault = await createUserVault();
    const client = await unlockUserVault(JSON.parse(JSON.stringify(vault.vault)), vault.recoverySecret);
    const sourceAddress = `poc-${randomUUID()}@source.example.com`;
    const sourceOnboarding = new PrivatePocOnboarding(source.sql, plc, sourceEncryptor, registry, oldBase);
    const prepared = await sourceOnboarding.prepare(sourceAddress,
      vault.vault.recovery.publicDidKey, vault.vault.identity.publicDidKey, true);
    const genesis = await client.signPlcOperation({ type: "plc_operation", prev: null,
      rotationKeys: [prepared.userRecoveryKey, prepared.providerRotationKey],
      verificationMethods: { "hail-identity": prepared.userIdentityKey,
        "hail-messaging": prepared.providerMessagingKey }, alsoKnownAs: [],
      services: { hail: { type: "HailMessaging", endpoint: oldBase } },
    });
    await client.bindDid(genesis.did, genesis.operation);
    const now = Math.floor(Date.now() / 1000);
    const oldBinding = await client.signAddressBinding({ type: "hail.address-binding", version: 1,
      address: sourceAddress, did: genesis.did, issued_at: now, expires_at: now + 90 * 86400,
      key_id: `${genesis.did}#hail-identity` });
    expect((await sourceOnboarding.register(prepared.accountId,
      new TextEncoder().encode(JSON.stringify(genesis.operation)), oldBinding)).state)
      .toBe("address-staged");
    const sourcePublished = await sourceRepo.getBindingForAccount(prepared.accountId);
    await new ActivationService(sourceRepo, { async verify() {
      return { address: sourceAddress, did: genesis.did, serviceBase: oldBase,
        messagingDidKey: prepared.providerMessagingKey, identityDidKey: prepared.userIdentityKey,
        plcEvidence: { document: await plc.getDocument(genesis.did),
          data: await plc.getDocumentData(genesis.did), log: await plc.getOperationLog(genesis.did) },
        verifiedAt: new Date(), binding: inspectSignedPayload("hail.address-binding", oldBinding).payload,
        representation: oldBinding, digest: sourcePublished.digest };
    } }, oldBase, "public").activate(prepared.accountId);
    expect((await sourceRepo.getAccount(prepared.accountId)).state).toBe("active");
    const oldAccess=new AccountAccess(source.sql,resolver,"https://source.example.com"),oldLoginToken=`hailp_${encodeBase64Url(randomBytes(32))}`;
    const hash=(bytes:Uint8Array)=>new Uint8Array(createHash("sha256").update(bytes).digest());
    const oldChallenge=await oldAccess.prepare({did:genesis.did,signer:"identity",publicKey:client.vault.identity.publicDidKey,scopes:["account:read"],tokenHash:encodeBase64Url(hash(new TextEncoder().encode(oldLoginToken)))});
    const oldLoginSignature=encodeBase64Url(await (await unlockUserIdentity(client.vault,vault.recoverySecret)).signAccountAccess(oldChallenge));
    const peerAccount=randomUUID(),peerEncryptor=sourceEncryptor,peerKeys=await generateAccountKeys(peerAccount,peerEncryptor);
    const peerGenesis=await signOperation({type:"plc_operation",prev:null,rotationKeys:[peerKeys.rotationDidKey],verificationMethods:{"hail-identity":peerKeys.identityDidKey,"hail-messaging":peerKeys.messagingDidKey},alsoKnownAs:[],services:{hail:{type:"HailMessaging",endpoint:oldBase}}},peerKeys.rotationKey);
    const peerDid=await didForCreateOp(peerGenesis);peerLogs.set(peerDid,[peerGenesis]);
    // A second local account proves returning materialization preserves collocated ownership.
    await source.sql`INSERT INTO provider_accounts (id,tenant_id,canonical_address,did,onboarding_state,activated_at,activation_binding_digest,activation_verification_mode)
      VALUES (${peerAccount},${randomUUID()},${`peer-${peerAccount}@source.example.com`},${peerDid},'active',now(),${randomBytes(32)},'public')`;
    for(const key of peerKeys.keys)await source.sql`INSERT INTO account_keys (account_id,role,algorithm,public_key,encrypted_private_key,encryption_nonce,encryption_version,kek_id)
      VALUES (${peerAccount},${key.role},${key.algorithm},${key.publicKey},${key.ciphertext},${key.nonce},${key.encryptionVersion},${key.kekId})`;
    const peerMessaging=peerKeys.keys.find(key=>key.role==="hail-messaging")!;
    const peerIdentity=peerKeys.identityPrivateKey;
    const peerBinding:HailAddressBinding={type:"hail.address-binding",version:1,address:`peer-${peerAccount}@source.example.com`,did:peerDid,issued_at:now,expires_at:now+86400,key_id:`${peerDid}#hail-identity`};
    const bindingCose=await signPayload("hail.address-binding",peerBinding,createWebCryptoSigner(peerBinding.key_id,peerIdentity));
    const rawPeer=await peerEncryptor.decrypt(peerAccount,peerMessaging.role,peerMessaging.algorithm,peerMessaging.publicKey,peerMessaging);
    let peerSigner:CryptoKey;try{peerSigner=await importEd25519PrivateKey(rawPeer);}finally{rawPeer.fill(0);}
    const profile:HailSenderProfile={type:"hail.sender-profile",version:1,did:peerDid,revision:1,updated_at:now,display_name:"Remote peer",offers_uncategorized:false,categories:[{id:"updates",label:"Updates"}],key_id:`${peerDid}#hail-messaging`};
    const profileCose=await signPayload("hail.sender-profile",profile,createWebCryptoSigner(profile.key_id,peerSigner));
    const peerEvidence={document:await plc.getDocument(peerDid),data:await plc.getDocumentData(peerDid),log:await plc.getOperationLog(peerDid)};
    const grant:HailGrant={type:"hail.grant",version:1,grant_id:Bun.randomUUIDv7(),revision:1,previous:null,grantor:genesis.did,grantee:peerDid,
      scope:[{type:"categories",values:["updates"]}],status:"active",issued_at:now,updated_at:now,expires_at:null,
      consent_context:{grantee_address:peerBinding.address,address_binding_hash:{algorithm:"sha-256",value:hash(bindingCose)},sender_profile_hash:{algorithm:"sha-256",value:hash(profileCose)}},key_id:`${genesis.did}#hail-identity`};
    const grantCose=await client.signGrant(grant);
    await new GrantRepository(source.sql).insertAuthoritativeRevision1({revision:{localAccountId:prepared.accountId,localRole:"grantor",payload:grant,representation:grantCose,digest:hash(grantCose),signingPublicKey:client.vault.identity.publicDidKey,
      signingPlcEvidence:{document:await plc.getDocument(genesis.did),data:await plc.getDocumentData(genesis.did),log:await plc.getOperationLog(genesis.did)}},destinationServiceBase:oldBase,
      consent:{address:{address:peerBinding.address,did:peerDid,serviceBase:oldBase,identityDidKey:peerKeys.identityDidKey,messagingDidKey:peerKeys.messagingDidKey,plcEvidence:peerEvidence,verifiedAt:new Date(),binding:peerBinding,representation:bindingCose,digest:hash(bindingCose)},
        senderProfile:{did:peerDid,serviceBase:oldBase,messagingDidKey:peerKeys.messagingDidKey,plcEvidence:peerEvidence,verifiedAt:new Date(),profile,representation:profileCose,digest:hash(profileCose),etag:'"peer-profile"'}}});
    await source.sql`INSERT INTO collocated_grant_receivers (grant_id,grantee_account_id) VALUES (${grant.grant_id},${peerAccount})`;
    const messageBody=bodyFromText("State survives A to B to A");
    const seedMessage=async(db:ProviderDatabase)=>{
      const timestamp=Math.floor(Date.now()/1000),payload:HailEnvelope={type:"hail.envelope",version:1,message_id:Bun.randomUUIDv7(),from:peerDid,to:genesis.did,authorization:{type:"grant",grant_id:grant.grant_id},category:"updates",created_at:timestamp,expires_at:timestamp+3600,
        body:{digest:{algorithm:"sha-256",value:hash(messageBody)},size:messageBody.length,media_type:"application/hail-body+cbor",profile:"spt-1",available_until:timestamp+31*86400,access:{type:"bearer",token:randomBytes(32),expires_at:timestamp+31*86400}},reply:{allowed:false}};
      const representation=await signPayload("hail.envelope",payload,createWebCryptoSigner(`${peerDid}#hail-messaging`,peerSigner)),digest=hash(inspectSignedPayload("hail.envelope",representation).payloadBytes);
      expect(await new EnvelopeRepository(db.sql).accept({payload,representation,payloadDigest:digest,envelopeDigest:digest,localAccountId:prepared.accountId,signingPublicKey:peerKeys.messagingDidKey,evidence:peerEvidence,now:timestamp})).toBe("accepted");
      return payload;
    };
    const firstMessage=await seedMessage(source),oldDeliveryClaim=(await new DeliveryRepository(source.sql).claimDue())!;
    const oldPublication=(await new GrantRepository(source.sql).claimDuePublication(60000))!;
    let resumeOldRequest!:()=>void;
    const paused=new Promise<void>(resolve=>{resumeOldRequest=resolve;});
    const admittedBeforeMove=withServingGeneration(prepared.accountId,1,async()=>{await paused;
      await source.sql`UPDATE provider_accounts SET updated_at=clock_timestamp() WHERE id=${prepared.accountId}`;});
    const pausedResult=Promise.resolve(admittedBeforeMove).then(()=>null,error=>error as Error);
    const targetKeys = new PreparedMigrationTarget(target.sql, targetEncryptor, newBase);
    const targetReceiver = new TransferInvitationReceiver(target.sql, resolver, targetKeys);
    const sourceFence = new MigrationFenceService(source.sql, resolver, oldBase);
    const sourceRoutes = new Hono();
    registerTransferRoutes(sourceRoutes,
      new TransferInvitationReceiver(source.sql, resolver,
        new PreparedMigrationTarget(source.sql, sourceEncryptor, oldBase)),
      undefined, sourceFence);
    const publisher = new TransferFinalRequestPublisher(target.sql, resolver, targetKeys,
      async (request) => withFreshServingGenerations(source.sql,()=>sourceRoutes.fetch(request)),
      (url) => { if (url.href !== `${oldBase}/transfers/requests`) throw new Error("Wrong old service"); });
    const targetRoutes = new Hono();
    registerTransferRoutes(targetRoutes, targetReceiver,
      new TransferAddressReservation(target.sql, resolver, targetKeys), undefined, publisher);
    const delivery = new TransferInvitationDelivery(source.sql, resolver, oldBase,
      async (request) => withFreshServingGenerations(target.sql,()=>targetRoutes.fetch(request)), (url) => {
        if (url.href !== "https://target.example.com/.well-known/hail/transfers/invitations") {
          throw new Error("Wrong new provider domain");
        }
      });
    const accounts=new AccountApiRepository(source.sql),credential=await accounts.issue(sourceAddress,false,undefined,["account:read","account:write"]);
    registerAccountApiRoutes(sourceRoutes,accounts,{} as never,{} as never,"https://source.example.com",undefined,undefined,
      new AccountTransfer(source.sql,new TransferGrantSubmission(source.sql,resolver,oldBase,sourceRepo,sourceEncryptor,
        new TransferInvitationService(source.sql,resolver,oldBase),delivery),
      new TransferCancellationService(source.sql,resolver,oldBase,sourceRepo,sourceEncryptor),"https://source.example.com",
      {fence:sourceFence,snapshots:new MigrationTransferService(source.sql,sourceRepo,sourceEncryptor,resolver,oldBase)}));
    const reader=await accounts.issue(sourceAddress);
    const preparationDir=await mkdtemp("/tmp/opencode/hail-transfer-client-");
    const destinationUsername=`moved-${randomUUID()}`,destinationAddress=`${destinationUsername}@target.example.com`;
    let offered:SignedHandshake,reservation:SignedHandshake,retainedTransferState:string,exportedSnapshot:Record<string,unknown>;
    try {
      const vaultPath=join(preparationDir,"vault.json"),statePath=join(preparationDir,"state.json"),credentialPath=join(preparationDir,"credential.json");
      await writeFile(vaultPath,JSON.stringify({...client.vault,recovery:{...client.vault.recovery,ciphertext:"AA"}}),{mode:0o600});
      await writeFile(credentialPath,JSON.stringify({type:"hailp.api-credential",version:1,provider:"https://source.example.com",...credential}),{mode:0o600});
      const api=await AccountApiClient.fromCredentialFile(credentialPath);
      let loseExport=true;
      const sourceFetch=vi.spyOn(globalThis,"fetch").mockImplementation(async(input,init)=>{
        const request=new Request(input,init);expect(new URL(request.url).origin).toBe("https://source.example.com");
        const response=await sourceRoutes.fetch(request);
        if(loseExport&&response.ok&&new URL(request.url).pathname.endsWith("/export")){loseExport=false;return new Response(null,{status:503});}return response;
      });
      let loseResponse=true;const received:string[]=[];
      const targetFetch=(async(input:RequestInfo|URL,init?:RequestInit)=>{
        const request=new Request(input,init);expect(request.headers.has("Authorization")).toBe(false);
        expect(new URL(request.url).origin).toBe("https://target.example.com");received.push(await request.clone().text());
        const response=await withFreshServingGenerations(target.sql,()=>targetRoutes.fetch(request));
        if(loseResponse&&response.ok){loseResponse=false;throw new Error("Destination committed but selection response was lost");}return response;
      }) as typeof fetch;
      try {
        const secret=async()=>encodeBase64Url(vault.recoverySecret);
        const exportRequest=(token:string,transferId:string)=>sourceRoutes.request("https://source.example.com/api/v1/account/transfers/export",{
          method:"POST",headers:{Authorization:`Bearer ${token}`,"Content-Type":"application/json"},body:JSON.stringify({transferId})});
        expect((await exportRequest(credential.token,randomUUID())).status).toBe(409);
        expect((await exportRequest(reader.token,randomUUID())).status).toBe(403);
        expect((await transferOffer(api,"https://target.example.com",vaultPath,statePath,secret)).phase).toBe("offer-ready");
        await expect(selectTransferAddress(api,destinationUsername,vaultPath,statePath,secret,targetFetch)).rejects.toThrow("response was lost");
        expect((await sourceFence.get(genesis.did))?.state).toBe("fenced");
        expect((await selectTransferAddress(api,destinationUsername,vaultPath,statePath,secret,targetFetch)).requestAcknowledged).toBe(true);
        expect(received[0]).toBe(received[1]);
        const saved=JSON.parse(await readFile(statePath,"utf8"));
        offered={payloadBytes:decodeBase64Url(saved.offer.payload),signature:decodeBase64Url(saved.offer.signature)};
        reservation={payloadBytes:decodeBase64Url(saved.reservation.payload),signature:decodeBase64Url(saved.reservation.signature)};
        expect((await exportRequest(credential.token,randomUUID())).status).toBe(409);
        const snapshotPath=join(preparationDir,"snapshot.json");
        await expect(exportTransferSnapshot(api,statePath,snapshotPath)).rejects.toThrow("HTTP 503");
        expect((await sourceFence.get(genesis.did))?.state).toBe("exported");
        expect((await exportTransferSnapshot(api,statePath,snapshotPath)).state).toBe("exported");
        const firstSnapshot=await readFile(snapshotPath);
        await exportTransferSnapshot(api,statePath,snapshotPath);expect(await readFile(snapshotPath)).toEqual(firstSnapshot);
        exportedSnapshot=JSON.parse(firstSnapshot.toString("utf8"));
        retainedTransferState=await readFile(statePath,"utf8");
      }finally{sourceFetch.mockRestore();}
    }finally{await rm(preparationDir,{recursive:true,force:true});}
    const offer = decodeDeterministic(offered.payloadBytes) as unknown as {
      transfer_id: string; destination_rotation_key: string;
      destination_messaging_key: string };
    expect((await sourceFence.get(genesis.did))?.state).toBe("exported");
    const sourceTransfer = new MigrationTransferService(source.sql, sourceRepo,
      sourceEncryptor, resolver, oldBase);
    const signedSnapshot = await sourceTransfer.exportFenced((await sourceFence.get(genesis.did))!);
    expect(exportedSnapshot.manifest).toBe(encodeBase64Url(signedSnapshot.bytes));
    expect(exportedSnapshot.signature).toBe(encodeBase64Url(signedSnapshot.signature));
    const ceremony = await mkdtemp("/tmp/opencode/hail-cutover-client-");
    let operationCid: string;
    const completionStatePath=join(ceremony,"transfer-state.json"),completionSnapshotPath=join(ceremony,"snapshot.json");
    try {
      const paths = { vault: join(ceremony, "vault.json"), snapshot: join(ceremony, "snapshot.json"),
        state:join(ceremony,"transfer-state.json"),
        offer: join(ceremony, "offer.json"), reservation: join(ceremony, "reservation.json"),
        consent: join(ceremony, "consent.json"), operation: join(ceremony, "operation.json"),
        binding: join(ceremony, "binding.cose") };
      await Promise.all([
        writeFile(paths.vault, JSON.stringify(client.vault), { mode: 0o600 }),
        writeFile(paths.state,retainedTransferState,{mode:0o600}),
        writeFile(paths.snapshot, JSON.stringify({ type: "hail.portable-migration-transfer",
          version: 3, manifest: encodeBase64Url(signedSnapshot.bytes),
          digest: encodeBase64Url(signedSnapshot.digest),
          signature: encodeBase64Url(signedSnapshot.signature),
          sourceMessagingPublicKey: signedSnapshot.sourceMessagingPublicKey }), { mode: 0o600 }),
        writeFile(paths.offer, JSON.stringify({ payload: encodeBase64Url(offered.payloadBytes),
          signature: encodeBase64Url(offered.signature) }), { mode: 0o600 }),
        writeFile(paths.reservation, JSON.stringify({ payload: encodeBase64Url(reservation.payloadBytes),
          signature: encodeBase64Url(reservation.signature) }), { mode: 0o600 }),
      ]);
      const runClient = async (operation=paths.operation) => {
        const child = Bun.spawn(["bun", "src/cli/hailp.ts","account","transfer","sign-cutover",
          "--vault",paths.vault,"--state",paths.state,"--snapshot",paths.snapshot,
          "--consent",paths.consent,"--operation",operation,"--binding",paths.binding],
        { cwd: new URL("../../hail-user-client-ts/", import.meta.url).pathname,
          stdin: "pipe", stdout: "pipe", stderr: "pipe" });
        child.stdin.write(`${encodeBase64Url(vault.recoverySecret)}\n`);
        child.stdin.end();
        const [code,stdout,stderr]=await Promise.all([child.exited,new Response(child.stdout).text(),new Response(child.stderr).text()]);
        expect(stdout+stderr).not.toContain(encodeBase64Url(vault.recoverySecret));
        if(code!==0)throw new Error(stderr);
      };
      await runClient();
      await expect(runClient(join(ceremony,"competing-operation.json"))).rejects.toThrow("paths changed");
      const firstOperation = await readFile(paths.operation);
      const firstConsent = await readFile(paths.consent);
      const firstBinding = await readFile(paths.binding);
      await rm(paths.operation);
      await expect(runClient()).rejects.toThrow("restore the originals");
      await writeFile(paths.operation,firstOperation,{mode:0o600});
      const originalSnapshot=await readFile(paths.snapshot);
      await writeFile(paths.snapshot,JSON.stringify({...JSON.parse(originalSnapshot.toString("utf8")),digest:encodeBase64Url(new Uint8Array(32))}));
      await expect(runClient()).rejects.toThrow("snapshot digest mismatch");
      await writeFile(paths.snapshot,originalSnapshot);
      await runClient();
      expect(await readFile(paths.operation)).toEqual(firstOperation);
      expect(await readFile(paths.consent)).toEqual(firstConsent);
      expect(await readFile(paths.binding)).toEqual(firstBinding);
      const legacy=Bun.spawn(["bun","src/cli/sign-private-poc-cutover.ts",paths.vault,paths.snapshot,paths.offer,paths.reservation,
        paths.consent,paths.operation,paths.binding],{cwd:new URL("../../hail-user-client-ts/",import.meta.url).pathname,stdin:"pipe",stdout:"pipe",stderr:"pipe"});
      legacy.stdin.write(`${encodeBase64Url(vault.recoverySecret)}\n`);legacy.stdin.end();
      expect(await legacy.exited,await new Response(legacy.stderr).text()).toBe(0);
      expect(await readFile(paths.operation)).toEqual(firstOperation);expect(await readFile(paths.consent)).toEqual(firstConsent);
      operationCid = (await cidForCbor(JSON.parse(firstOperation.toString("utf8")) as Operation)).toString();
    } catch(error) {await rm(ceremony,{recursive:true,force:true});throw error;}
    try {
    const targetTransfer = new MigrationTransferService(target.sql, sourceRepo,
      targetEncryptor, resolver, newBase);
    await expect(sourceFence.releaseBeforeExport(genesis.did, offer.transfer_id))
      .rejects.toThrow("Only an unexported");
    const lostResponsePlc = { ...plc, async sendOperation(value: string, operation: Operation) {
      await plc.sendOperation(value, operation);
      throw new Error("PLC committed, but its response was lost");
    } };
    const submission = new PrivatePocPlcSubmission(target.sql, lostResponsePlc, registry, newBase);
    const gate = new PrivatePocCutoverGate(target.sql, { origin: registry,
      resolver, audit: (value) => plc.getAuditableLog(value) }, registry, newBase);
    const publication=new PrivatePocAddressPublication(target.sql,resolver,gate,registry,newBase);
    const config = { publicOrigin: "https://target.example.com", providerId: "target",
      hailServiceBase: newBase } as AppConfig;
    const app = createApp(config, {servingSql:target.sql, discoveryStore: targetRepo,accountAccess:{access:new AccountAccess(target.sql,resolver,"https://target.example.com"),sql:target.sql},
      async checkReadiness() { return { ready: true }; } });
    const targetAccounts=new AccountApiRepository(target.sql);
    registerAccountApiRoutes(app,targetAccounts,{} as never,{} as never,"https://target.example.com");
    let addressAvailable=false;
    const verifier = new AddressVerifier(plc, async (request) => {if(!addressAvailable)throw new Error("Destination HTTPS unavailable");return app.fetch(request);}, (url) => {
      if (url.origin !== "https://target.example.com") throw new Error("Unexpected Hail address domain");
    });
    const activation = new PortableMigrationActivation(target.sql, targetEncryptor, resolver,
      gate, verifier, newBase, registry, undefined, "private-poc");
    let expiryProbed=false;
    const completion=new PrivatePocTransferCompletion(target.sql,targetTransfer,{async submit(id){
      if(!expiryProbed){expiryProbed=true;const clock=vi.spyOn(Date,"now").mockReturnValue(Date.now()+7200000);
        try {await expect(submission.submit(id)).rejects.toThrow("stale");expect(log).toHaveLength(1);}finally{clock.mockRestore();}}
      return submission.submit(id);
    }},publication,activation,newBase);
    registerTransferRoutes(app,targetReceiver,undefined,undefined,undefined,undefined,undefined,undefined,undefined,completion);
    const retirementRoutes=new Hono();
    registerTransferRoutes(retirementRoutes,new TransferInvitationReceiver(source.sql,resolver,new PreparedMigrationTarget(source.sql,sourceEncryptor,oldBase)),
      undefined,sourceFence,undefined,undefined,undefined,undefined,undefined,completion);
    let loseActive=true,loseRetirement=true;const destinationRequests:string[]=[];
    const completionTransport=(async(input:RequestInfo|URL,init?:RequestInit)=>{
      const request=new Request(input,init);expect(request.headers.has("Authorization")).toBe(false);
      if(new URL(request.url).origin==="https://target.example.com") {
        destinationRequests.push(await request.clone().text());const response=await app.fetch(request);
        if(loseActive&&response.ok){loseActive=false;return new Response(null,{status:503});}return response;
      }
      expect(request.url).toBe("https://source.example.com/.well-known/hail/transfers/retirements");
      const response=await retirementRoutes.fetch(request);
      if(loseRetirement&&response.ok){loseRetirement=false;return new Response(null,{status:503});}return response;
    }) as typeof fetch;
    const complete=()=>completeAccountTransfer(completionStatePath,completionSnapshotPath,completionTransport);
    await expect(complete()).rejects.toThrow("HTTP 400");
    expect(await targetRepo.getAccountByDid(genesis.did)).toBeNull();
    expect((await sourceFence.get(genesis.did))?.state).toBe("exported");
    expect(log).toHaveLength(2);addressAvailable=true;
    await expect(complete()).rejects.toThrow("HTTP 503");
    expect((await targetRepo.getAccountByDid(genesis.did))?.state).toBe("active");
    const clock=vi.spyOn(Date,"now").mockReturnValue(Date.now()+7200000);
    try {await expect(complete()).rejects.toThrow("source retirement is unconfirmed");
      expect(await complete()).toMatchObject({destinationActive:true,sourceRetired:true,operationCid});}
    finally{clock.mockRestore();}
    expect(destinationRequests.every(bytes=>bytes===destinationRequests[0])).toBe(true);
    const saved=JSON.parse(await readFile(completionStatePath,"utf8"));expect(saved.retired).toBe(true);expect(saved.activationReceipt).toBeDefined();
    const request=JSON.parse(destinationRequests[0]!);request.binding=encodeBase64Url(new Uint8Array([1]));
    const changed=await app.request("https://target.example.com/.well-known/hail/transfers/completions",{method:"POST",headers:{"Content-Type":"application/hail-transfer+json"},body:JSON.stringify(request)});
    expect(changed.status).toBe(400);
    const webfinger=await app.request(`https://target.example.com/.well-known/webfinger?resource=${encodeURIComponent(`acct:${destinationAddress}`)}&rel=${encodeURIComponent("https://hailproto.com/rel/address-binding")}`);
    expect(webfinger.status).toBe(200);
    const receipt = await activation.issueReceipt(offer.transfer_id);
    await sourceFence.retire(genesis.did, offer.transfer_id, receipt);
    await sourceFence.retire(genesis.did, offer.transfer_id, receipt);
    await expect(sourceFence.retire(genesis.did, offer.transfer_id,
      { ...receipt, signature: new Uint8Array(64) })).rejects.toThrow();
    expect((await sourceFence.get(genesis.did))?.state).toBe("retired");
    const archived=(await source.sql<{export_record:Record<string,unknown>;fence_record:Record<string,unknown>}[]>`
      SELECT export_record,fence_record FROM provider_retired_transfer_history WHERE transfer_id=${offer.transfer_id}`)[0]!;
    expect(archived.export_record.manifest_bytes).toBe(`\\x${Buffer.from(signedSnapshot.bytes).toString("hex")}`);
    expect(archived.export_record.signature).toBe(`\\x${Buffer.from(signedSnapshot.signature).toString("hex")}`);
    expect(archived.fence_record.state).toBe("retired");
    const originalReceipt=(await source.sql<{retirement_receipt_bytes:Uint8Array}[]>`
      SELECT retirement_receipt_bytes FROM provider_migration_fences WHERE transfer_id=${offer.transfer_id}`)[0]!.retirement_receipt_bytes;
    expect(archived.fence_record.retirement_receipt_bytes).toBe(`\\x${Buffer.from(originalReceipt).toString("hex")}`);
    expect(await sourceRepo.findPublishedByAddress(sourceAddress)).toBeNull();
    expect(await targetRepo.findPublishedByAddress(destinationAddress)).not.toBeNull();
    expect((await targetRepo.getAccountByDid(genesis.did))?.state).toBe("active");
    expect(log).toHaveLength(2);
    expect(await target.sql`SELECT canonical_address FROM provider_accounts
      WHERE did = ${genesis.did}`).toHaveLength(1);
    const loginFetch=vi.spyOn(globalThis,"fetch").mockImplementation(async(input,init)=>{
      const request=new Request(input,init);expect(new URL(request.url).origin).toBe("https://target.example.com");return app.fetch(request);
    });
    try {
      const credentialPath=join(ceremony,"destination-credential.json"),loginState=join(ceremony,"destination-login.json");
      await loginAccount("https://target.example.com",genesis.did,"identity",["account:read"],join(ceremony,"vault.json"),loginState,credentialPath,async()=>encodeBase64Url(vault.recoverySecret));
      const ownerApi=await AccountApiClient.fromCredentialFile(credentialPath);expect((await ownerApi.account()).did).toBe(genesis.did);
      const acquired=JSON.parse(await readFile(credentialPath,"utf8"));expect(acquired.token).not.toBe(credential.token);
      expect(await new AccountApiRepository(source.sql).authenticate(`Bearer ${acquired.token}`)).toBeNull();
    }finally{loginFetch.mockRestore();}
    // New accepted/delivered work and a publication acknowledgement while B owns the DID.
    const betaDelivery=new DeliveryRepository(target.sql),betaClaim=(await withFreshServingGenerations(target.sql,()=>betaDelivery.claimDue()))!;
    expect(betaClaim.messageId).toBe(firstMessage.message_id);
    expect(await withFreshServingGenerations(target.sql,()=>betaDelivery.deliver(betaClaim,messageBody))).toBe("delivered");
    const betaStatus=await withFreshServingGenerations(target.sql,()=>new DeliveryStatusSigner(target.sql,targetRepo,targetEncryptor,resolver,newBase).signCurrent(peerDid,firstMessage.message_id));
    const secondMessage=await withFreshServingGenerations(target.sql,()=>seedMessage(target));
    const betaPending=(await withFreshServingGenerations(target.sql,()=>betaDelivery.claimDue()))!;expect(betaPending.messageId).toBe(secondMessage.message_id);
    let betaGrant:Awaited<ReturnType<GrantRepository["claimDuePublication"]>>=null;for(let attempt=0;attempt<3;attempt++){
      betaGrant=await withFreshServingGenerations(target.sql,()=>new GrantRepository(target.sql).claimDuePublication(60000));
      if(betaGrant?.grant.payload.grant_id===grant.grant_id)break;
    }
    if(!betaGrant)throw new Error("Current transfer Grant publication was not claimable");
    expect(betaGrant.grant.payload.grant_id).toBe(grant.grant_id);
    // A destination's pre-existing grantee replica has its own arrival time,
    // even when the COSE/digest/signer checkpoint is identical.
    await withFreshServingGenerations(target.sql,async()=>{await target.sql`UPDATE grant_revisions SET received_at=received_at+interval '1 second' WHERE grant_id=${grant.grant_id} AND revision=1`;});
    const acknowledgedEtag=`"${encodeBase64Url(betaGrant.grant.digest)}"`;
    await withFreshServingGenerations(target.sql,()=>new GrantRepository(target.sql).acknowledgePublication({grantId:grant.grant_id,revision:1,leaseToken:betaGrant.leaseToken,etag:acknowledgedEtag,httpStatus:201}));

    const backFence=new MigrationFenceService(target.sql,resolver,newBase),backSourceRoutes=new Hono();
    const backKeys=new PreparedMigrationTarget(source.sql,sourceEncryptor,oldBase,true),backReceiver=new TransferInvitationReceiver(source.sql,resolver,backKeys);
    const backGate=new PrivatePocCutoverGate(source.sql,{origin:registry,resolver,audit:did=>plc.getAuditableLog(did)},registry,oldBase);
    let returningApp:ReturnType<typeof createApp>;
    const backVerifier=new AddressVerifier(plc,async request=>returningApp.fetch(request),url=>{if(url.origin!=="https://source.example.com")throw new Error("Wrong returning origin");});
    const backCompletion=new PrivatePocTransferCompletion(source.sql,new MigrationTransferService(source.sql,sourceRepo,sourceEncryptor,resolver,oldBase,true),
      new PrivatePocPlcSubmission(source.sql,plc,registry,oldBase),new PrivatePocAddressPublication(source.sql,resolver,backGate,registry,oldBase),
      new PortableMigrationActivation(source.sql,sourceEncryptor,resolver,backGate,backVerifier,oldBase,registry,undefined,"private-poc",true),oldBase);
    const backPublisher=new TransferFinalRequestPublisher(source.sql,resolver,backKeys,async request=>withFreshServingGenerations(target.sql,()=>backSourceRoutes.fetch(request)),()=>{});
    const alphaAccounts=new AccountApiRepository(source.sql);
    returningApp=createApp({publicOrigin:"https://source.example.com",providerId:"source",hailServiceBase:oldBase} as AppConfig,{
      servingSql:source.sql,discoveryStore:sourceRepo,transferInvitationReceiver:backReceiver,transferAddressReservation:new TransferAddressReservation(source.sql,resolver,backKeys),
      transferFinalRequestPublisher:backPublisher,transferCompletion:backCompletion,accountApi:{accounts:alphaAccounts,grants:new GrantRepository(source.sql),service:{} as never},
      accountAccess:{access:new AccountAccess(source.sql,resolver,"https://source.example.com"),sql:source.sql},async checkReadiness(){return {ready:true};}});
    const backDelivery=new TransferInvitationDelivery(target.sql,resolver,newBase,async request=>returningApp.fetch(request),()=>{});
    const backCredential=await targetAccounts.issue(destinationAddress,false,undefined,["account:read","account:write"]);
    registerAccountApiRoutes(backSourceRoutes,targetAccounts,{} as never,{} as never,"https://target.example.com",undefined,undefined,
      new AccountTransfer(target.sql,new TransferGrantSubmission(target.sql,resolver,newBase,targetRepo,targetEncryptor,new TransferInvitationService(target.sql,resolver,newBase),backDelivery),
        new TransferCancellationService(target.sql,resolver,newBase,targetRepo,targetEncryptor),"https://target.example.com",
        {fence:backFence,snapshots:new MigrationTransferService(target.sql,targetRepo,targetEncryptor,resolver,newBase)}));
    registerTransferRoutes(backSourceRoutes,new TransferInvitationReceiver(target.sql,resolver,new PreparedMigrationTarget(target.sql,targetEncryptor,newBase)),undefined,backFence,undefined,undefined,undefined,undefined,undefined,backCompletion);
    const backState=join(ceremony,"return-state.json"),backSnapshot=join(ceremony,"return-snapshot.json"),backCredentialPath=join(ceremony,"return-source-credential.json"),username=`returned-${randomUUID()}`;
    await writeFile(backCredentialPath,JSON.stringify({type:"hailp.api-credential",version:1,provider:"https://target.example.com",...backCredential}),{mode:0o600});
    const backApi=await AccountApiClient.fromCredentialFile(backCredentialPath);
    let loseReturn=true;
    const returnFetch=vi.spyOn(globalThis,"fetch").mockImplementation(async(input,init)=>{
      const request=new Request(input,init),origin=new URL(request.url).origin;
      if(origin==="https://source.example.com"){
        const response=await returningApp.fetch(request);
        if(loseReturn&&new URL(request.url).pathname.endsWith("/completions")&&response.ok){loseReturn=false;return new Response(null,{status:503});}return response;
      }
      expect(origin).toBe("https://target.example.com");return withFreshServingGenerations(target.sql,()=>backSourceRoutes.fetch(request));
    });
    try {
      const secret=async()=>encodeBase64Url(vault.recoverySecret);
      expect((await transferOffer(backApi,"https://source.example.com",join(ceremony,"vault.json"),backState,secret)).phase).toBe("offer-ready");
      expect((await selectTransferAddress(backApi,username,join(ceremony,"vault.json"),backState,secret)).requestAcknowledged).toBe(true);
      await exportTransferSnapshot(backApi,backState,backSnapshot);
      const reviewed=JSON.parse(await readFile(backSnapshot,"utf8"));
      const missingWork=JSON.parse(new TextDecoder().decode(decodeBase64Url(reviewed.manifest)));
      missingWork.tables.delivery_work=[];
      await expect(validateReturningEvidence(source.sql,missingWork)).rejects.toThrow("delivery responsibility");
      await signAccountTransferCutover(join(ceremony,"vault.json"),backState,backSnapshot,join(ceremony,"return-consent.json"),join(ceremony,"return-operation.json"),join(ceremony,"return-binding.cose"),secret);
      await expect(completeAccountTransfer(backState,backSnapshot)).rejects.toThrow("HTTP 503");
      expect(await completeAccountTransfer(backState,backSnapshot)).toMatchObject({destinationActive:true,sourceRetired:true,did:genesis.did});
      expect(log).toHaveLength(3);
      const generation=(await source.sql<{generation:string}[]>`SELECT generation FROM account_serving_generations WHERE account_id=${prepared.accountId}`)[0]!.generation;
      expect(Number(generation)).toBe(2);
      const rollbackConnection=await source.sql.reserve();
      try {await expect(rollbackConnection.unsafe(await Bun.file(new URL("../migrations/rollback/0037_generation_admission.sql",import.meta.url)).text())).rejects.toThrow("prevent rollback");}
      finally{await rollbackConnection.unsafe("ROLLBACK");rollbackConnection.release();}
      expect((await sourceFence.get(genesis.did))).toBeNull();expect((await backFence.get(genesis.did))?.state).toBe("retired");
      expect((await source.sql`SELECT transfer_id FROM provider_retired_transfer_history WHERE did=${genesis.did}`).length).toBe(1);
      expect((await target.sql`SELECT transfer_id FROM provider_retired_import_history WHERE did=${genesis.did}`).length).toBe(1);
      expect(await alphaAccounts.authenticate(`Bearer ${credential.token}`)).toBeNull();
      resumeOldRequest();expect((await pausedResult)?.message).toContain("stale");
      await source.sql`UPDATE account_api_credentials SET revoked_at=NULL WHERE id=${credential.credentialId}`;
      expect(await alphaAccounts.authenticate(`Bearer ${credential.token}`)).toBeNull();
      await expect(withFreshServingGenerations(source.sql,()=>alphaAccounts.issue(`${username}@source.example.com`,false,credential.token,["account:read","account:write"]))).rejects.toThrow("cannot be reused");
      expect(await sourceRepo.findPublishedByAddress(sourceAddress)).toBeNull();
      await expect(withFreshServingGenerations(source.sql,()=>oldAccess.complete(oldChallenge.challengeId,oldLoginToken,oldLoginSignature))).rejects.toThrow("expired");
      await expect(withServingGeneration(prepared.accountId,1,async()=>{await source.sql`UPDATE provider_accounts SET updated_at=clock_timestamp() WHERE id=${prepared.accountId}`;})).rejects.toThrow("stale");
      await expect(withServingGeneration(prepared.accountId,1,()=>new DeliveryRepository(source.sql).deliver(oldDeliveryClaim,messageBody))).rejects.toThrow("stale");
      await expect(withFreshServingGenerations(source.sql,()=>new GrantRepository(source.sql).acknowledgePublication({grantId:grant.grant_id,revision:1,leaseToken:oldPublication.leaseToken,etag:acknowledgedEtag}))).rejects.toThrow("lease");
      await expect(withFreshServingGenerations(target.sql,()=>betaDelivery.deliver(betaPending,messageBody))).rejects.toThrow("fenced");
      const outbox=(await source.sql<{state:string;attempt_count:number;acknowledged_etag:string}[]>`SELECT state,attempt_count,acknowledged_etag FROM grant_publications WHERE grant_id=${grant.grant_id}`)[0]!;
      expect(outbox).toMatchObject({state:"acknowledged",attempt_count:2,acknowledged_etag:acknowledgedEtag});
      expect((await new GrantRepository(source.sql).findReceivedForSender(grant.grant_id,peerDid))?.localAccountId).toBe(peerAccount);
      expect((await sourceRepo.getAccount(peerAccount)).state).toBe("active");
      const firstDelivery=(await source.sql<{state:string;attempt_count:number;status_revision:number}[]>`SELECT state,attempt_count,status_revision FROM delivery_work WHERE sender_did=${peerDid} AND message_id=${firstMessage.message_id}`)[0]!;
      expect(firstDelivery).toMatchObject({state:"delivered",attempt_count:2,status_revision:2});
      const alphaDelivery=new DeliveryRepository(source.sql),resumed=(await withFreshServingGenerations(source.sql,()=>alphaDelivery.claimDue()))!;
      expect(resumed.messageId).toBe(secondMessage.message_id);expect(resumed.attemptCount).toBe(2);
      const leased=(await source.sql<{generation:string}[]>`SELECT generation FROM serving_worker_leases WHERE lease_token=${resumed.leaseToken}`)[0]!;expect(Number(leased.generation)).toBe(2);
      expect(await withFreshServingGenerations(source.sql,()=>alphaDelivery.deliver(resumed,messageBody))).toBe("delivered");
      const alphaSigner=new DeliveryStatusSigner(source.sql,sourceRepo,sourceEncryptor,resolver,oldBase);
      const alphaStatus=await withFreshServingGenerations(source.sql,()=>alphaSigner.signCurrent(peerDid,firstMessage.message_id));
      expect(inspectSignedPayload("hail.delivery-status",alphaStatus!).payloadBytes).toEqual(inspectSignedPayload("hail.delivery-status",betaStatus!).payloadBytes);
      const returnedCredential=join(ceremony,"returned-credential.json");
      await loginAccount("https://source.example.com",genesis.did,"identity",["account:read"],join(ceremony,"vault.json"),join(ceremony,"returned-login.json"),returnedCredential,secret);
      expect((await (await AccountApiClient.fromCredentialFile(returnedCredential)).account()).address).toBe(`${username}@source.example.com`);
      const ownerCount=async(db:ProviderDatabase)=>Number((await db.sql<{count:number}[]>`SELECT count(*)::integer AS count FROM provider_accounts a
        WHERE a.did=${genesis.did} AND a.onboarding_state='active' AND NOT EXISTS(SELECT 1 FROM provider_migration_fences f WHERE f.account_id=a.id)`)[0]!.count);
      expect(await ownerCount(source)+await ownerCount(target)).toBe(1);
      // Complete these fixture outboxes through normal signed publication, so unrelated worker tests have no due jobs.
      const publisher=new TerminalStatusPublisher(source.sql,alphaSigner,resolver,async()=>new Response(null,{status:204}),()=>{});
      expect(await withFreshServingGenerations(source.sql,()=>publisher.publishOne())).toBe("acknowledged");
      expect(await withFreshServingGenerations(source.sql,()=>publisher.publishOne())).toBe("acknowledged");

      // A fresh staged move from returned A back to B is abandoned without reopening an old snapshot.
      const nextKeys=new PreparedMigrationTarget(target.sql,targetEncryptor,newBase,true),nextReceiver=new TransferInvitationReceiver(target.sql,resolver,nextKeys);
      const nextPublisher=new TransferFinalRequestPublisher(target.sql,resolver,nextKeys,async request=>withFreshServingGenerations(source.sql,()=>sourceRoutes.fetch(request)),()=>{});
      const nextApp=createApp(config,{servingSql:target.sql,discoveryStore:targetRepo,transferInvitationReceiver:nextReceiver,
        transferAddressReservation:new TransferAddressReservation(target.sql,resolver,nextKeys),transferFinalRequestPublisher:nextPublisher,async checkReadiness(){return {ready:true};}});
      const nextSourceCredential=await withFreshServingGenerations(source.sql,()=>alphaAccounts.issue(`${username}@source.example.com`,false,undefined,["account:read","account:write"]));
      const nextCredentialPath=join(ceremony,"abandon-source-credential.json"),nextState=join(ceremony,"abandon-state.json"),nextSnapshot=join(ceremony,"abandon-snapshot.json");
      await writeFile(nextCredentialPath,JSON.stringify({type:"hailp.api-credential",version:1,provider:"https://source.example.com",...nextSourceCredential}),{mode:0o600});
      const nextApi=await AccountApiClient.fromCredentialFile(nextCredentialPath);
      // The existing source delivery service routes its destination request through this replacement test boundary.
      const nextFetch=vi.spyOn(globalThis,"fetch").mockImplementation(async(input,init)=>{
        const request=new Request(input,init);return new URL(request.url).origin==="https://source.example.com"?
          withFreshServingGenerations(source.sql,()=>sourceRoutes.fetch(request)):nextApp.fetch(request);
      });
      let thirdSnapshot:any,thirdOperation:Operation,thirdOperationBytes:Uint8Array,thirdTransfer:string;
      try {
        let targetError:unknown;
        const delivery=new TransferInvitationDelivery(source.sql,resolver,oldBase,async request=>{
          const body=await request.clone().json() as any,response=await nextApp.fetch(request);
          if(response.status===400)try{await withFreshServingGenerations(target.sql,()=>nextReceiver.receive(decodeSignedRecord(body.grant),decodeSignedRecord(body.invitation)));}catch(error){targetError=error;}
          return response;
        },()=>{});
        const grantUser=(await unlockUserIdentity(client.vault,vault.recoverySecret)),time=Math.floor(Date.now()/1000);
        const signedGrant=await grantUser.signTransferGrant({type:"hail.transfer-grant",version:1,did:genesis.did,nonce:randomUUID(),source_service_base:oldBase,destination_service_base:newBase,destination_domain:"target.example.com",issued_at:time,expires_at:time+3600});
        await withFreshServingGenerations(source.sql,()=>new TransferGrantSubmission(source.sql,resolver,oldBase,sourceRepo,sourceEncryptor,new TransferInvitationService(source.sql,resolver,oldBase),delivery).submit(signedGrant));
        if(targetError)throw targetError;
        const credentialAccount=await nextApi.account(),status=await nextApi.request("/transfers");
        await writeFile(nextState,JSON.stringify({type:"hailp.account-transfer",version:1,provider:credentialAccount.provider,accountId:credentialAccount.accountId,did:genesis.did,key:client.vault.identity.publicDidKey,destination:"https://target.example.com",grant:encodeSignedRecord(signedGrant),offer:status.offer}),{mode:0o600});
        expect((await selectTransferAddress(nextApi,`abandoned-${randomUUID()}`,join(ceremony,"vault.json"),nextState,secret)).requestAcknowledged).toBe(true);
        await exportTransferSnapshot(nextApi,nextState,nextSnapshot);
        await signAccountTransferCutover(join(ceremony,"vault.json"),nextState,nextSnapshot,join(ceremony,"abandon-consent.json"),join(ceremony,"abandon-operation.json"),join(ceremony,"abandon-binding.cose"),secret);
        thirdSnapshot=JSON.parse(await readFile(nextSnapshot,"utf8"));thirdOperationBytes=new Uint8Array(await readFile(join(ceremony,"abandon-operation.json")));thirdOperation=JSON.parse(new TextDecoder().decode(thirdOperationBytes));
        thirdTransfer=(decodeDeterministic(decodeSignedRecord(status.offer).payloadBytes) as any).transfer_id;
        const consentContainer=JSON.parse(await readFile(join(ceremony,"abandon-consent.json"),"utf8"));
        await withFreshServingGenerations(target.sql,async()=>new MigrationTransferService(target.sql,targetRepo,targetEncryptor,resolver,newBase,true).stageImport({bytes:decodeBase64Url(thirdSnapshot.manifest),digest:decodeBase64Url(thirdSnapshot.digest),signature:decodeBase64Url(thirdSnapshot.signature),sourceMessagingPublicKey:thirdSnapshot.sourceMessagingPublicKey},
          decodeSignedRecord({payload:consentContainer.payload,signature:consentContainer.signature}),thirdOperationBytes,new Uint8Array(await readFile(join(ceremony,"abandon-binding.cose")))));
      }finally{nextFetch.mockRestore();}
      const sourceAbandon=new PrivatePocTransferAbandonment(source.sql,sourceEncryptor,plc,oldBase,registry,backVerifier);
      const targetAbandon=new PrivatePocTransferAbandonment(target.sql,targetEncryptor,plc,newBase,registry,verifier);
      const cutoverCid=(await cidForCbor(thirdOperation!)).toString(),digest=decodeBase64Url(thirdSnapshot.digest),approvalTime=Math.floor(Date.now()/1000);
      const intent=encodeSignedRecord(await client.signTransferRecoveryApproval({type:"hailp.transfer-abandon",version:1,did:genesis.did,transfer_id:thirdTransfer!,source_service_base:oldBase,destination_service_base:newBase,source_generation:2,snapshot_digest:digest,
        cutover_operation_cid:cutoverCid,user_recovery_key:client.vault.recovery.publicDidKey,nonce:randomUUID(),issued_at:approvalTime,expires_at:approvalTime+3600}));
      const activeAttempt=JSON.parse(await readFile(backState,"utf8")),activeSnapshot=JSON.parse(await readFile(backSnapshot,"utf8"));
      const activeTransfer=(decodeDeterministic(decodeSignedRecord(activeAttempt.offer).payloadBytes) as any).transfer_id;
      const cannotUndoActive=encodeSignedRecord(await client.signTransferRecoveryApproval({type:"hailp.transfer-abandon",version:1,did:genesis.did,transfer_id:activeTransfer,source_service_base:newBase,destination_service_base:oldBase,source_generation:1,snapshot_digest:decodeBase64Url(activeSnapshot.digest),
        cutover_operation_cid:activeAttempt.cutover.operationCid,user_recovery_key:client.vault.recovery.publicDidKey,nonce:randomUUID(),issued_at:approvalTime,expires_at:approvalTime+3600}));
      await expect(withFreshServingGenerations(source.sql,()=>sourceAbandon.invalidate(cannotUndoActive))).rejects.toThrow("reverse transfer");
      let signalStarted!:()=>void,finishRemote!:()=>void;
      const started=new Promise<void>(resolve=>{signalStarted=resolve;}),remote=new Promise<void>(resolve=>{finishRemote=resolve;});
      const delayedPlc={...plc,async sendOperation(){signalStarted();await remote;throw new Error("External PLC request remains ambiguous");}};
      const pendingSend=withFreshServingGenerations(target.sql,()=>new PrivatePocPlcSubmission(target.sql,delayedPlc,registry,newBase).submit(thirdTransfer!));
      const observedSend=pendingSend.then(()=>null,error=>error as Error);await started;
      let invalidationDone=false;
      const invalidating=withFreshServingGenerations(target.sql,()=>targetAbandon.invalidate(intent)).then(receipt=>{invalidationDone=true;return receipt;});
      let blocked=false;for(let attempt=0;attempt<100&&!blocked;attempt++){
        blocked=Number((await target.sql<{count:number}[]>`SELECT count(*)::integer AS count FROM pg_stat_activity WHERE datname=current_database() AND cardinality(pg_blocking_pids(pid))>0`)[0]!.count)>0;
        if(!blocked)await Bun.sleep(10);
      }
      expect(blocked).toBe(true);expect(invalidationDone).toBe(false);finishRemote();expect((await observedSend)?.message).toContain("ambiguous");
      const invalidation=await invalidating;expect(await withFreshServingGenerations(target.sql,()=>targetAbandon.invalidate(intent))).toEqual(invalidation);
      expect(await target.sql`SELECT evidence_digest FROM public_cutover_evidence`).toHaveLength(0);
      const rollbackTarget=await target.sql.reserve();try {
        await expect(rollbackTarget.unsafe(await Bun.file(new URL("../migrations/rollback/0039_transfer_abandonment.sql",import.meta.url)).text())).rejects.toThrow("prevents rollback");
      }finally{await rollbackTarget.unsafe("ROLLBACK");rollbackTarget.release();}
      await target.migrate();
      await expect(withFreshServingGenerations(target.sql,()=>new PrivatePocPlcSubmission(target.sql,plc,registry,newBase).submit(thirdTransfer!))).rejects.toThrow("inactive staged");
      const manifest=JSON.parse(new TextDecoder().decode(decodeBase64Url(thirdSnapshot.manifest))),baseline=manifest.tables.plc_operation_evidence.at(-1),restore=typeof baseline.expected_state==="string"?JSON.parse(baseline.expected_state):baseline.expected_state;
      const originalProtective=await client.signPlcOperation({type:"plc_operation",prev:baseline.operation_cid,rotationKeys:restore.rotationKeys,verificationMethods:restore.verificationMethods,services:restore.services,alsoKnownAs:restore.alsoKnownAs});
      let protective=originalProtective;
      if(race==="cutover-first") {
        await plc.sendOperation(genesis.did,thirdOperation!);
        await expect(plc.sendOperation(genesis.did,originalProtective.operation)).rejects.toThrow("predecessor changed");
        // A fresh, explicit owner approval appends to the recognized committed cutover; never a hidden same-key fork.
        protective=await client.signPlcOperation({type:"plc_operation",prev:cutoverCid,rotationKeys:restore.rotationKeys,verificationMethods:restore.verificationMethods,services:restore.services,alsoKnownAs:restore.alsoKnownAs});
      }
      const resume=encodeSignedRecord(await client.signTransferRecoveryApproval({type:"hailp.transfer-resume",version:1,did:genesis.did,transfer_id:thirdTransfer!,source_service_base:oldBase,destination_service_base:newBase,source_generation:2,snapshot_digest:digest,
        cutover_operation_cid:cutoverCid,protective_operation_cid:protective.cid,invalidation_digest:hash(decodeSignedRecord(invalidation).payloadBytes),user_recovery_key:client.vault.recovery.publicDidKey,nonce:randomUUID(),issued_at:approvalTime,expires_at:approvalTime+3600}));
      await expect(withFreshServingGenerations(source.sql,()=>sourceAbandon.resume(resume,invalidation, new TextEncoder().encode(JSON.stringify(protective.operation))))).rejects.toThrow("protective source operation is not current");
      expect((await sourceFence.get(genesis.did))?.state).toBe("exported");
      await plc.sendOperation(genesis.did,protective.operation);
      const indexed=await Promise.all(log.map(async(operation,index)=>({did:genesis.did,nullified:false,operation,cid:CID.parse((await cidForCbor(operation)).toString()),createdAt:new Date(Date.now()-(log.length-index)*1000)})));
      await expect(assureValidNextOp(genesis.did,indexed,thirdOperation!,new Date())).rejects.toThrow();
      const protectiveBytes=new TextEncoder().encode(JSON.stringify(protective.operation));
      const release=await withFreshServingGenerations(target.sql,()=>targetAbandon.release(resume,protectiveBytes));
      expect(await withFreshServingGenerations(target.sql,()=>targetAbandon.release(resume,protectiveBytes))).toEqual(release);
      const badRelease={...release,signature:encodeBase64Url(new Uint8Array(64))};
      await expect(withFreshServingGenerations(source.sql,()=>sourceAbandon.resume(resume,badRelease,protectiveBytes))).rejects.toThrow("receipt signature");
      const resumedReceipt=await withFreshServingGenerations(source.sql,()=>sourceAbandon.resume(resume,release,protectiveBytes));
      const restarted=new PrivatePocTransferAbandonment(source.sql,sourceEncryptor,plc,oldBase,registry,backVerifier);
      expect(await withFreshServingGenerations(source.sql,()=>restarted.resume(resume,release,protectiveBytes))).toEqual(resumedReceipt);
      expect(Number((await source.sql<{generation:string}[]>`SELECT generation FROM account_serving_generations WHERE account_id=${prepared.accountId}`)[0]!.generation)).toBe(3);
      expect(await sourceFence.get(genesis.did)).toBeNull();expect(await ownerCount(source)+await ownerCount(target)).toBe(1);
      expect(await alphaAccounts.authenticate(`Bearer ${nextSourceCredential.token}`)).toBeNull();
      expect((await source.sql<{state:string;status_revision:number}[]>`SELECT state,status_revision FROM delivery_work WHERE sender_did=${peerDid} AND message_id=${secondMessage.message_id}`)[0]).toMatchObject({state:"delivered",status_revision:2});
      expect((await target.sql`SELECT transfer_id FROM pending_migration_imports WHERE transfer_id=${thirdTransfer!}`).length).toBe(0);
      const cancelledNonce=(decodeDeterministic(decodeSignedRecord((JSON.parse(await readFile(nextState,"utf8"))).grant).payloadBytes) as any).nonce;
      expect((await target.sql`SELECT did FROM cancelled_transfer_sessions WHERE did=${genesis.did} AND nonce=${cancelledNonce}`).length).toBe(1);
      const escrow=(await source.sql<{evidence:Record<string,any>}[]>`SELECT evidence FROM provider_transfer_abandonments WHERE transfer_id=${thirdTransfer!}`)[0]!.evidence;
      expect(escrow.export.manifest_bytes).toBe(`\\x${Buffer.from(decodeBase64Url(thirdSnapshot.manifest)).toString('hex')}`);
      const oldGrant=decodeSignedRecord(JSON.parse(await readFile(nextState,"utf8")).grant),sourceMessaging=await sourceRepo.getKey(prepared.accountId,"hail-messaging");
      const sourceRaw=await sourceEncryptor.decrypt(prepared.accountId,sourceMessaging.role,sourceMessaging.algorithm,sourceMessaging.publicKey,sourceMessaging);
      try {const signer=await importEd25519PrivateKey(sourceRaw);
        await expect(withFreshServingGenerations(source.sql,()=>new TransferInvitationService(source.sql,resolver,oldBase).issue(oldGrant,signer))).rejects.toThrow("nonce cannot be reused");
      }finally{sourceRaw.fill(0);}
      const resumedFetch=vi.spyOn(globalThis,"fetch").mockImplementation(async(input,init)=>{
        const request=new Request(input,init);expect(new URL(request.url).origin).toBe("https://source.example.com");return returningApp.fetch(request);
      });
      try {const newCredential=join(ceremony,"resumed-source-credential.json");
        await loginAccount("https://source.example.com",genesis.did,"identity",["account:read"],join(ceremony,"vault.json"),join(ceremony,"resumed-source-login.json"),newCredential,secret);
        expect((await (await AccountApiClient.fromCredentialFile(newCredential)).account()).migrationState).toBeNull();
      }finally{resumedFetch.mockRestore();}
    }finally{returnFetch.mockRestore();}
    }finally{await rm(ceremony,{recursive:true,force:true});vault.recoverySecret.fill(0);}
  },30000);
});
