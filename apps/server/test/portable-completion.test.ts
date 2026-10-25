import {P256Keypair} from "@atproto/crypto";
import {cidForCbor} from "@atproto/common";
import {signOperation} from "@did-plc/lib";
import {encodeBase64Url} from "@hailproto/codec";
import {createHash} from "node:crypto";
import {expect,it} from "vitest";
import {TRANSFER_TABLES,TRANSFER_AUTHORITY_TABLES,type TransferManifest} from "../src/migration/transfer.js";

const manifest:TransferManifest={
  version:3,transferId:"00000000-0000-4000-8000-000000000001",did:`did:plc:${"a".repeat(24)}`,
  accountId:"00000000-0000-4000-8000-000000000002",sourceServiceBase:"https://source.example/hail",
  destinationServiceBase:"https://target.example/hail",destinationRotationPublicKey:"did:key:zTargetRotation",
  destinationMessagingPublicKey:"did:key:zTargetMessaging",custodyProfile:"portable",capturedAt:new Date(0).toISOString(),
  tables:Object.fromEntries([...TRANSFER_TABLES,...TRANSFER_AUTHORITY_TABLES].map(table=>[table,[] as Record<string,unknown>[]])) as TransferManifest["tables"],
};
manifest.tables.provider_accounts=[{id:manifest.accountId,did:manifest.did,onboarding_state:"active",activation_verification_mode:"public"}];
manifest.tables.account_keys=[{account_id:manifest.accountId,role:"plc-rotation",public_key:"did:key:zSourceRotation"},
  {account_id:manifest.accountId,role:"hail-messaging",public_key:"did:key:zSource"}];
manifest.tables.portable_custody_evidence=[{account_id:manifest.accountId,user_recovery_public_key:"did:key:zOwnerRecovery",
  user_identity_public_key:"did:key:zOwnerIdentity",monitor_verification_mode:"independent",monitor_origin:"https://monitor.example",
  monitor_public_key:"did:key:zMonitor",monitor_confirmed_at:manifest.capturedAt,backup_confirmed_at:manifest.capturedAt}];

import {PortableTransferCompletion} from "../src/migration/poc-completion.js";

it("stages a public portable transfer before requiring monitor evidence",async()=>{
  const key=await P256Keypair.create(),operation=await signOperation({type:"plc_operation",prev:null,
    rotationKeys:[key.did()],verificationMethods:{},alsoKnownAs:[],services:{}},key);
  const operationBytes=new TextEncoder().encode(JSON.stringify(operation)),operationCid=(await cidForCbor(operation)).toString();
  const calls:string[]=[];
  const manifestBytes=new TextEncoder().encode(JSON.stringify(manifest));
  const completion=new PortableTransferCompletion((async()=>[]) as never,
    {async stageImport(snapshot){expect(snapshot.bytes).toEqual(manifestBytes);calls.push("stage");return manifest;}},
    {async submit(){calls.push("submit");return operationCid;}},
    {async publish(_id,monitor){expect(monitor).toBeDefined();calls.push("publish");return "binding";}},
    {async activate(_id,monitor){expect(monitor).toBeDefined();calls.push("activate");return {did:manifest.did,accountId:manifest.accountId};},
      async issueReceipt(){calls.push("receipt");return {payloadBytes:new Uint8Array([1]),signature:new Uint8Array(64)};}},
    manifest.destinationServiceBase);
  const snapshot={type:"hail.portable-migration-transfer",version:3,manifest:encodeBase64Url(manifestBytes),
    digest:encodeBase64Url(new Uint8Array(createHash("sha256").update(manifestBytes).digest())),signature:encodeBase64Url(new Uint8Array(64)),sourceMessagingPublicKey:"did:key:zSource"};
  const input={snapshot,consent:{payload:encodeBase64Url(new Uint8Array([1])),signature:encodeBase64Url(new Uint8Array(64))},
    operation:encodeBase64Url(operationBytes),binding:encodeBase64Url(new Uint8Array([1]))};

  await expect(completion.complete({...input,snapshot:{...snapshot,manifest:encodeBase64Url(new Uint8Array([1]))}})).rejects.toThrow("Invalid JSON value");
  expect(calls).toEqual([]);
  await expect(completion.complete(input)).resolves.toMatchObject({phase:"awaiting-monitor",operationCid});
  expect(calls).toEqual(["stage","submit"]);
  await expect(completion.complete({...input,monitor:{payload:encodeBase64Url(new Uint8Array([1])),
    signature:encodeBase64Url(new Uint8Array(64))}})).resolves.toMatchObject({phase:"active",operationCid});
  expect(calls).toEqual(["stage","submit","stage","submit","publish","activate","receipt"]);
});
