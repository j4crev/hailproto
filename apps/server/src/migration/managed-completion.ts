import {cidForCbor} from "@atproto/common";
import {def} from "@did-plc/lib";
import {decodeBase64Url,encodeBase64Url} from "@hailproto/codec";
import {parseJsonWithoutDuplicateKeys} from "../discovery/strict-json.js";
import type {ManagedMigrationStageService} from "./managed-stage.js";
import type {ManagedMigrationPlcSubmission} from "./managed-plc-submission.js";
import type {ManagedMigrationActivation} from "./managed-activation.js";
import type {SignedManagedTransferSnapshot} from "./managed-snapshot.js";
import {decodeSignedRecord,encodeSignedRecord} from "./wire.js";

const canonical=(value:string)=>{const bytes=decodeBase64Url(value);if(encodeBase64Url(bytes)!==value)throw new Error("Non-canonical transfer bytes");return bytes;};

export class ManagedMigrationCompletion {
  constructor(private readonly stage:Pick<ManagedMigrationStageService,"stage">,
    private readonly plc:Pick<ManagedMigrationPlcSubmission,"submit">,
    private readonly activation:Pick<ManagedMigrationActivation,"activate"|"issueReceipt">,
    private readonly publicProfile=false) {}

  async complete(input:unknown) {
    if(!input||typeof input!=="object"||Array.isArray(input)||
      Object.keys(input).length!==(this.publicProfile&&"monitor" in input?4:3)||
      !("snapshot" in input)||!("approval" in input)||!("operation" in input)||typeof input.operation!=="string")
      throw new Error("Managed completion requires exact snapshot, approval and operation");
    const monitor=this.publicProfile&&"monitor" in input?decodeSignedRecord(input.monitor):undefined;
    const container=input.snapshot;
    if(!container||typeof container!=="object"||Array.isArray(container)||Object.keys(container).sort().join(",")!==
      "digest,manifest,signature,sourceMessagingPublicKey,type,version"||!("type" in container)||container.type!=="hail.managed-migration-transfer"||
      !("version" in container)||container.version!==4||!("manifest" in container)||typeof container.manifest!=="string"||
      !("digest" in container)||typeof container.digest!=="string"||!("signature" in container)||typeof container.signature!=="string"||
      !("sourceMessagingPublicKey" in container)||typeof container.sourceMessagingPublicKey!=="string")
      throw new Error("Invalid managed snapshot container");
    const snapshot:SignedManagedTransferSnapshot={bytes:canonical(container.manifest),digest:canonical(container.digest),
      signature:canonical(container.signature),sourceMessagingPublicKey:container.sourceMessagingPublicKey};
    if(snapshot.bytes.length>67_108_864||snapshot.digest.length!==32||snapshot.signature.length!==64)
      throw new Error("Managed snapshot exceeds its limits");
    const approval=decodeSignedRecord(input.approval),operationBytes=canonical(input.operation);
    const manifest=await this.stage.stage(snapshot,approval,operationBytes);
    const operation=def.operation.parse(parseJsonWithoutDuplicateKeys(new TextDecoder("utf-8",{fatal:true}).decode(operationBytes)));
    const operationCid=(await cidForCbor(operation)).toString();
    if(await this.plc.submit(manifest.transferId)!==operationCid)throw new Error("Configured PLC retained another operation");
    if(this.publicProfile&&!monitor)return {type:"hailp.managed-transfer-completion",version:1,did:manifest.did,accountId:manifest.accountId,
      transferId:manifest.transferId,operationCid,phase:"awaiting-monitor"};
    const active=await this.activation.activate(manifest.transferId,monitor),receipt=await this.activation.issueReceipt(manifest.transferId);
    return {type:"hailp.managed-transfer-completion",version:1,did:active.did,accountId:active.accountId,
      transferId:manifest.transferId,generation:active.generation,operationCid,phase:"active",receipt:encodeSignedRecord(receipt)};
  }
}
