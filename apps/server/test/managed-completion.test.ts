import {createHash} from "node:crypto";
import {cidForCbor} from "@atproto/common";
import {P256Keypair} from "@atproto/crypto";
import {signOperation} from "@did-plc/lib";
import {encodeBase64Url} from "@hailproto/codec";
import {expect,it,vi} from "vitest";
import {ManagedMigrationCompletion} from "../src/migration/managed-completion.js";

it("completes only the exact retained managed artifacts",async()=>{
  const owner=await P256Keypair.create(),operation=await signOperation({type:"plc_operation",prev:"bafy-old",
    rotationKeys:[owner.did()],verificationMethods:{},alsoKnownAs:[],services:{}},owner),
    operationBytes=new TextEncoder().encode(JSON.stringify(operation)),operationCid=(await cidForCbor(operation)).toString(),
    bytes=new TextEncoder().encode('{"version":4}'),digest=new Uint8Array(createHash("sha256").update(bytes).digest()),
    signature=new Uint8Array(64).fill(1),transferId="019a0000-0000-7000-8000-000000000001",
    did=`did:plc:${"a".repeat(24)}`,accountId="019a0000-0000-7000-8000-000000000002",
    snapshot={type:"hail.managed-migration-transfer",version:4,manifest:encodeBase64Url(bytes),digest:encodeBase64Url(digest),
      signature:encodeBase64Url(signature),sourceMessagingPublicKey:"did:key:zsource"},
    approval={payload:encodeBase64Url(new Uint8Array([1])),signature:encodeBase64Url(signature)};
  const stage=vi.fn(async()=>({transferId,did,accountId})),submit=vi.fn(async()=>operationCid),activate=vi.fn(async()=>({did,accountId,generation:2})),
    receipt={payloadBytes:new Uint8Array([2]),signature},issueReceipt=vi.fn(async()=>receipt),
    completion=new ManagedMigrationCompletion({stage} as never,{submit},{activate,issueReceipt});
  await expect(completion.complete({snapshot,approval,operation:encodeBase64Url(operationBytes)})).resolves.toMatchObject({
    type:"hailp.managed-transfer-completion",transferId,did,accountId,generation:2,operationCid,phase:"active"});
  expect(stage).toHaveBeenCalledOnce();expect(submit).toHaveBeenCalledWith(transferId);
  expect(activate).toHaveBeenCalledWith(transferId,undefined);expect(issueReceipt).toHaveBeenCalledWith(transferId);
  await expect(completion.complete({...snapshot})).rejects.toThrow(/requires exact/);
  const publicCompletion=new ManagedMigrationCompletion({stage} as never,{submit},{activate,issueReceipt},true);
  stage.mockClear();submit.mockClear();
  const input={snapshot,approval,operation:encodeBase64Url(operationBytes)};
  activate.mockClear();issueReceipt.mockClear();
  await expect(publicCompletion.complete(input)).resolves.toMatchObject({phase:"awaiting-monitor",did,accountId,operationCid});
  expect(activate).not.toHaveBeenCalled();expect(issueReceipt).not.toHaveBeenCalled();
  stage.mockClear();submit.mockClear();
  await expect(publicCompletion.complete({...input,monitor:{payload:"",signature:""}})).rejects.toThrow();
  expect(stage).not.toHaveBeenCalled();expect(submit).not.toHaveBeenCalled();
  await expect(completion.complete({...input,monitor:approval})).rejects.toThrow(/requires exact/);
  await publicCompletion.complete({...input,monitor:approval});
  expect(activate).toHaveBeenLastCalledWith(transferId,{payloadBytes:new Uint8Array([1]),signature});
});
