import {createHash,randomUUID} from "node:crypto";
import {cidForCbor} from "@atproto/common";
import {P256Keypair} from "@atproto/crypto";
import {mkdtemp,readFile,rm,stat,writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {decodeBase64Url,decodeDeterministic,encodeBase64Url,encodeDeterministic,type HailValue} from "@hailproto/codec";
import {base58btc} from "multiformats/bases/base58";
import {expect,it} from "vitest";
import type {AccountApiClient} from "../src/account-api.js";
import {completeManagedTransfer,exportManagedTransferSnapshot,managedTransferOffer,managedTransferStatus,
  selectManagedTransferAddress,signManagedTransferCutover} from "../src/managed-account-transfer.js";
import {createUserVault} from "../src/vault.js";

it.each(["poc-local","strict-public-v1"])("orchestrates exact-retry managed owner authorization and completion (%s)",async profile=>{
  const generated=await createUserVault(),directory=await mkdtemp(join(tmpdir(),"hail-managed-transfer-"));
  const did=`did:plc:${"a".repeat(24)}`,vault={...generated.vault,did},vaultPath=join(directory,"vault.json"),statePath=join(directory,"state.json");
  await writeFile(vaultPath,JSON.stringify(vault),{mode:0o600});
  const key=async()=>{const pair=await crypto.subtle.generateKey("Ed25519",true,["sign","verify"]),raw=new Uint8Array(await crypto.subtle.exportKey("raw",pair.publicKey));
    return {pair,did:`did:key:${base58btc.encode(new Uint8Array([0xed,1,...raw]))}`};};
  const [sourceIdentity,sourceMessaging,destinationIdentity,destinationMessaging]=await Promise.all([key(),key(),key(),key()]),
    sourceRotation=await P256Keypair.create(),destinationRotationKey=await P256Keypair.create(),destinationRotation={did:destinationRotationKey.did()};
  const sign=async(value:Record<string,HailValue>,pair:CryptoKeyPair)=>{const payload=encodeDeterministic(value),tag=new TextEncoder().encode(`${value.type}.v1\0`),input=new Uint8Array(tag.length+payload.length);
    input.set(tag);input.set(payload,tag.length);return {payload:encodeBase64Url(payload),signature:encodeBase64Url(new Uint8Array(await crypto.subtle.sign("Ed25519",pair.privateKey,input)))};};
  const hash=(bytes:Uint8Array)=>new Uint8Array(createHash("sha256").update(bytes).digest());
  const account={provider:"https://source.example.com",accountId:randomUUID(),did,custodyProfile:"managed",migrationState:null as string|null,
    scopes:["account:read","account:write"],ownerRecoveryPublicKey:vault.recovery.publicDidKey,identityPublicKey:sourceIdentity.did};
  let grant:Record<string,any>,acknowledgement:any,offer:any,lostOffer=true,snapshot:Record<string,unknown>|undefined;
  const status=()=>({type:"hailp.managed-transfer-status",version:1,provider:account.provider,accountId:account.accountId,did,
    phase:"offer-ready",destinationServiceBase:"https://target.example.com/hail",expiresAt:new Date(Date.now()+3600000).toISOString(),
    originConfirmed:true,transferId:offer&&(decodeDeterministic(decodeBase64Url(offer.payload)) as Record<string,any>).transfer_id,
    acknowledgement,offer});
  const requests:unknown[]=[];
  const client={account:async()=>({...account}),request:async(path:string,body?:Record<string,unknown>)=>{
    if(path==="/transfers/managed")return status();
    if(path==="/transfers/managed/export")return snapshot!;
    requests.push(body);grant=decodeDeterministic(decodeBase64Url(body!.payload as string)) as Record<string,any>;
    acknowledgement??=await sign({type:"hail.managed-transfer-acknowledgement",version:1,did,nonce:grant.nonce,
      source_service_base:grant.source_service_base,destination_service_base:grant.destination_service_base,
      grant_digest:hash(decodeBase64Url(body!.payload as string)),source_messaging_key:sourceMessaging.did,issued_at:grant.issued_at,expires_at:grant.expires_at},sourceMessaging.pair);
    offer??=await sign({type:"hail.managed-transfer-offer",version:1,did,nonce:grant.nonce,transfer_id:randomUUID(),
      source_service_base:grant.source_service_base,destination_service_base:grant.destination_service_base,
      grant_digest:hash(decodeBase64Url(body!.payload as string)),acknowledgement_digest:hash(decodeBase64Url(acknowledgement.payload)),
      destination_rotation_key:destinationRotation.did,destination_identity_key:destinationIdentity.did,
      destination_messaging_key:destinationMessaging.did,issued_at:grant.issued_at,expires_at:grant.expires_at},destinationMessaging.pair);
    if(lostOffer){lostOffer=false;throw new Error("lost source response");}return status();
  }} as unknown as AccountApiClient;
  let prompts=0;const secret=async()=>{prompts++;return encodeBase64Url(generated.recoverySecret);};
  try {
    const prepare=()=>managedTransferOffer(client,"https://target.example.com",vaultPath,statePath,secret);
    await expect(prepare()).rejects.toThrow("lost source response");
    expect(await prepare()).toMatchObject({phase:"offer-ready",destinationIdentityPublicKey:destinationIdentity.did});
    expect(prompts).toBe(1);expect(requests[0]).toEqual(requests[1]);expect((await stat(statePath)).mode&0o777).toBe(0o600);
    expect((await managedTransferStatus(client)).phase).toBe("offer-ready");
    let lostReservation=true,reservation:any;const targetBodies:string[]=[];
    const transport=(async(url:string,init:RequestInit)=>{
      expect(url).toBe("https://target.example.com/.well-known/hail/transfers/managed-reservations");
      expect(new Headers(init.headers).has("Authorization")).toBe(false);targetBodies.push(init.body as string);
      const selectionWire=JSON.parse(init.body as string),selection=decodeDeterministic(decodeBase64Url(selectionWire.payload)) as Record<string,any>;
      reservation??=await sign({type:"hail.managed-transfer-reservation",version:1,did,nonce:selection.nonce,transfer_id:selection.transfer_id,
        offer_digest:selection.offer_digest,selection_digest:hash(decodeBase64Url(selectionWire.payload)),address:selection.address,
        destination_rotation_key:destinationRotation.did,destination_identity_key:destinationIdentity.did,destination_messaging_key:destinationMessaging.did,
        issued_at:selection.issued_at,expires_at:selection.expires_at},destinationMessaging.pair);
      if(lostReservation){lostReservation=false;throw new Error("lost destination response");}
      return new Response(JSON.stringify(reservation),{status:202,headers:{"Content-Type":"application/hail-transfer+json"}});
    }) as typeof fetch;
    const select=()=>selectManagedTransferAddress(client,"alice",vaultPath,statePath,secret,transport);
    await expect(select()).rejects.toThrow("lost destination response");
    expect(await select()).toMatchObject({address:"alice@target.example.com",requestAcknowledged:false});
    expect(prompts).toBe(2);expect(targetBodies[0]).toBe(targetBodies[1]);
    await expect(selectManagedTransferAddress(client,"bob",vaultPath,statePath,secret,transport)).rejects.toThrow("reviewed address/Offer");
    const saved=JSON.parse(await readFile(statePath,"utf8"));expect(saved.reservation).toEqual(reservation);
    account.migrationState="fenced";
    const previousCid=(await cidForCbor({fixture:"managed-source"})).toString(),currentState={did,rotationKeys:[vault.recovery.publicDidKey,sourceRotation.did()],
      verificationMethods:{"hail-identity":sourceIdentity.did,"hail-messaging":sourceMessaging.did},alsoKnownAs:[],
      services:{hail:{type:"HailMessaging",endpoint:"https://source.example.com/hail"}}},manifest={version:4,custodyProfile:"managed",did,
      accountId:account.accountId,transferId:(decodeDeterministic(decodeBase64Url(offer.payload)) as Record<string,any>).transfer_id,
      sourceServiceBase:"https://source.example.com/hail",destinationServiceBase:"https://target.example.com/hail",
      ownerRecoveryPublicKey:vault.recovery.publicDidKey,sourceIdentityPublicKey:sourceIdentity.did,
      destinationRotationPublicKey:destinationRotation.did,destinationIdentityPublicKey:destinationIdentity.did,
      destinationMessagingPublicKey:destinationMessaging.did,sourceGeneration:1,historyCheckpointDigest:encodeBase64Url(new Uint8Array(32).fill(7)),
      tables:{managed_custody_evidence:[{owner_recovery_public_key:vault.recovery.publicDidKey,
        provider_identity_public_key:sourceIdentity.did,verification_mode:profile}],
        account_keys:[{role:"plc-rotation",public_key:sourceRotation.did()}],
        plc_operation_evidence:[{operation_cid:previousCid,expected_state:currentState}]}};
    const manifestBytes=new TextEncoder().encode(JSON.stringify(manifest)),snapshotDigest=hash(manifestBytes),
      snapshotInput=new Uint8Array("hail-migration-snapshot-v4\0".length+32);
    snapshotInput.set(new TextEncoder().encode("hail-migration-snapshot-v4\0"));snapshotInput.set(snapshotDigest,"hail-migration-snapshot-v4\0".length);
    snapshot={type:"hail.managed-migration-transfer",version:4,manifest:encodeBase64Url(manifestBytes),digest:encodeBase64Url(snapshotDigest),
      signature:encodeBase64Url(new Uint8Array(await crypto.subtle.sign("Ed25519",sourceMessaging.pair.privateKey,snapshotInput))),
      sourceMessagingPublicKey:sourceMessaging.did};
    const snapshotPath=join(directory,"snapshot.json"),operationPath=join(directory,"operation.json"),approvalPath=join(directory,"approval.json");
    expect(await exportManagedTransferSnapshot(client,statePath,snapshotPath)).toMatchObject({state:"exported",snapshotFile:snapshotPath});
    const cutover=await signManagedTransferCutover(vaultPath,statePath,snapshotPath,operationPath,approvalPath,secret);
    expect(cutover).toMatchObject({operationFile:operationPath,approvalFile:approvalPath});
    let completionAttempts=0,retirementAttempts=0;const completionBodies:string[]=[],retirementBodies:string[]=[];
    const finishTransport=(async(url:string,init:RequestInit)=>{
      if(url.endsWith("managed-completions")) {
        completionBodies.push(init.body as string);completionAttempts++;
        const activatedAt=Math.floor(Date.now()/1000),value={type:"hail.portable-migration-activated",version:1,did,
          transfer_id:manifest.transferId,snapshot_digest:snapshotDigest,destination_service_base:manifest.destinationServiceBase,
          destination_messaging_key:destinationMessaging.did,destination_address:"alice@target.example.com",
          address_binding_digest:new Uint8Array(32).fill(8),activated_at:activatedAt},signedReceipt=await sign(value as unknown as Record<string,HailValue>,destinationMessaging.pair),
          result={type:"hailp.managed-transfer-completion",version:1,did,accountId:account.accountId,transferId:manifest.transferId,
            generation:2,operationCid:cutover.operationCid,phase:"active",receipt:signedReceipt};
        if(completionAttempts===1)throw new Error("lost completion response");
        return new Response(JSON.stringify(result),{status:200,headers:{"Content-Type":"application/hail-transfer+json"}});
      }
      retirementBodies.push(init.body as string);retirementAttempts++;
      if(retirementAttempts===1)throw new Error("lost retirement response");
      return new Response(null,{status:204});
    }) as typeof fetch;
    const monitorPath=join(directory,"monitor.json"),monitor={payload:encodeBase64Url(encodeDeterministic({type:"hail.plc-monitor-attestation",version:2})),
      signature:encodeBase64Url(new Uint8Array(64))};
    await writeFile(monitorPath,JSON.stringify(monitor),{mode:0o600});
    if(profile==="strict-public-v1") {
      const submissionTransport=(async(_url:string,_init:RequestInit)=>new Response(JSON.stringify({type:"hailp.managed-transfer-completion",version:1,did,
        accountId:account.accountId,transferId:manifest.transferId,operationCid:cutover.operationCid,phase:"awaiting-monitor"}),
        {headers:{"Content-Type":"application/hail-transfer+json"}})) as typeof fetch;
      expect(await completeManagedTransfer(statePath,snapshotPath,submissionTransport)).toMatchObject({phase:"awaiting-monitor",pending:true,monitorRequired:true});
      expect(JSON.parse(await readFile(statePath,"utf8")).retired).not.toBe(true);
    } else await expect(completeManagedTransfer(statePath,snapshotPath,finishTransport,monitorPath)).rejects.toThrow(/Private/);
    expect(completionBodies).toHaveLength(0);
    const finish=()=>completeManagedTransfer(statePath,snapshotPath,finishTransport,profile==="strict-public-v1"?monitorPath:undefined);
    await expect(finish()).rejects.toThrow("lost completion response");
    await expect(finish()).rejects.toThrow("lost retirement response");
    expect(await finish()).toMatchObject({generation:2,destinationActive:true,sourceRetired:true});
    expect(JSON.parse(completionBodies[0]!).monitor).toEqual(profile==="strict-public-v1"?monitor:undefined);
    expect(new Set(completionBodies).size).toBe(1);expect(new Set(retirementBodies).size).toBe(1);
  } finally {generated.recoverySecret.fill(0);await rm(directory,{recursive:true,force:true});}
});
