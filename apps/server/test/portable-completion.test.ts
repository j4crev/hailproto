import {P256Keypair} from "@atproto/crypto";
import {cidForCbor} from "@atproto/common";
import {signOperation} from "@did-plc/lib";
import {encodeBase64Url} from "@hailproto/codec";
import {expect,it,vi} from "vitest";

const fixture=vi.hoisted(()=>({manifest:{
  version:3,transferId:"00000000-0000-4000-8000-000000000001",did:`did:plc:${"a".repeat(24)}`,
  accountId:"00000000-0000-4000-8000-000000000002",sourceServiceBase:"https://source.example/hail",
  destinationServiceBase:"https://target.example/hail",destinationRotationPublicKey:"did:key:zTargetRotation",
  destinationMessagingPublicKey:"did:key:zTargetMessaging",custodyProfile:"portable",capturedAt:new Date(0).toISOString(),
  tables:{portable_custody_evidence:[{monitor_verification_mode:"independent"}]},
}}));

vi.mock("../src/migration/transfer.js",()=>({validateTransferManifest:()=>fixture.manifest}));

import {PortableTransferCompletion} from "../src/migration/poc-completion.js";

it("stages a public portable transfer before requiring monitor evidence",async()=>{
  const key=await P256Keypair.create(),operation=await signOperation({type:"plc_operation",prev:null,
    rotationKeys:[key.did()],verificationMethods:{},alsoKnownAs:[],services:{}},key);
  const operationBytes=new TextEncoder().encode(JSON.stringify(operation)),operationCid=(await cidForCbor(operation)).toString();
  const calls:string[]=[];
  const completion=new PortableTransferCompletion((async()=>[]) as never,
    {async stageImport(){calls.push("stage");return fixture.manifest as never;}},
    {async submit(){calls.push("submit");return operationCid;}},
    {async publish(_id,monitor){expect(monitor).toBeDefined();calls.push("publish");return "binding";}},
    {async activate(_id,monitor){expect(monitor).toBeDefined();calls.push("activate");return {did:fixture.manifest.did,accountId:fixture.manifest.accountId};},
      async issueReceipt(){calls.push("receipt");return {payloadBytes:new Uint8Array([1]),signature:new Uint8Array(64)};}},
    fixture.manifest.destinationServiceBase);
  const snapshot={type:"hail.portable-migration-transfer",version:3,manifest:encodeBase64Url(new Uint8Array([1])),
    digest:encodeBase64Url(new Uint8Array(32)),signature:encodeBase64Url(new Uint8Array(64)),sourceMessagingPublicKey:"did:key:zSource"};
  const input={snapshot,consent:{payload:encodeBase64Url(new Uint8Array([1])),signature:encodeBase64Url(new Uint8Array(64))},
    operation:encodeBase64Url(operationBytes),binding:encodeBase64Url(new Uint8Array([1]))};

  await expect(completion.complete(input)).resolves.toMatchObject({phase:"awaiting-monitor",operationCid});
  expect(calls).toEqual(["stage","submit"]);
  await expect(completion.complete({...input,monitor:{payload:encodeBase64Url(new Uint8Array([1])),
    signature:encodeBase64Url(new Uint8Array(64))}})).resolves.toMatchObject({phase:"active",operationCid});
  expect(calls).toEqual(["stage","submit","stage","submit","publish","activate","receipt"]);
});
