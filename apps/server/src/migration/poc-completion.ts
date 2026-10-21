import { decodeBase64Url,encodeBase64Url } from "@hailproto/codec";
import { cidForCbor } from "@atproto/common";
import { def } from "@did-plc/lib";
import type { SQL } from "bun";
import { parseJsonWithoutDuplicateKeys } from "../discovery/strict-json.js";
import { validateTransferManifest,type MigrationTransferService } from "./transfer.js";
import { decodeSignedRecord,encodeSignedRecord } from "./wire.js";
import type { PrivatePocPlcSubmission } from "./poc-plc-submission.js";
import type { PrivatePocAddressPublication } from "./poc-address-publication.js";
import type { PortableMigrationActivation } from "./activation.js";

export class PrivatePocTransferCompletion {
  constructor(private readonly sql:SQL,private readonly imports:Pick<MigrationTransferService,"stageImport">,
    private readonly submission:Pick<PrivatePocPlcSubmission,"submit">,private readonly publication:Pick<PrivatePocAddressPublication,"publish">,
    private readonly activation:Pick<PortableMigrationActivation,"activate"|"issueReceipt">,private readonly serviceBase:string){}

  async complete(input:unknown) {
    if(!input||typeof input!=="object"||Array.isArray(input)||Object.keys(input).sort().join(",")!=="binding,consent,operation,snapshot")throw new Error("Invalid completion envelope");
    const row=input as Record<string,unknown>,snapshot=row.snapshot as Record<string,unknown>;
    if(!snapshot||typeof snapshot!=="object"||Object.keys(snapshot).sort().join(",")!=="digest,manifest,signature,sourceMessagingPublicKey,type,version"||
      snapshot.type!=="hail.portable-migration-transfer"||![2,3].includes(snapshot.version as number)||typeof snapshot.sourceMessagingPublicKey!=="string")throw new Error("Invalid source snapshot");
    const decode=(value:unknown,max:number)=>{if(typeof value!=="string")throw new Error("Invalid transfer bytes");const bytes=decodeBase64Url(value);
      if(!bytes.length||bytes.length>max||encodeBase64Url(bytes)!==value)throw new Error("Transfer bytes exceed limit or are not canonical");return bytes;};
    const bytes=decode(snapshot.manifest,67108864),digest=decode(snapshot.digest,32),signature=decode(snapshot.signature,64);
    if(digest.length!==32||signature.length!==64)throw new Error("Invalid snapshot signature/digest length");
    const manifest=validateTransferManifest(bytes),consent=decodeSignedRecord(row.consent),operation=decode(row.operation,16000),binding=decode(row.binding,16384);
    if(snapshot.version!==manifest.version)throw new Error("Snapshot container and manifest versions differ");
    if(manifest.destinationServiceBase!==this.serviceBase||manifest.tables.portable_custody_evidence[0]?.monitor_verification_mode!=="poc-local")throw new Error("Completion requires this private-POC destination");
    const retained=await this.sql<{state:string;manifest_bytes:Uint8Array;manifest_digest:Uint8Array;signature:Uint8Array;source_messaging_public_key:string;
      user_consent_payload:Uint8Array;user_consent_signature:Uint8Array;signed_plc_operation_bytes:Uint8Array;destination_binding_cose:Uint8Array}[]>`
      SELECT state,manifest_bytes,manifest_digest,signature,source_messaging_public_key,user_consent_payload,user_consent_signature,
        signed_plc_operation_bytes,destination_binding_cose FROM pending_migration_imports WHERE transfer_id=${manifest.transferId}`;
    const prior=retained[0],same=(a:Uint8Array,b:Uint8Array)=>Buffer.from(a).equals(Buffer.from(b));
    if(prior){
      // Exact durably accepted artifacts authorize resumption after PLC cutover; never re-stage against the old source.
      if(!["staged","active"].includes(prior.state)||prior.source_messaging_public_key!==snapshot.sourceMessagingPublicKey||!same(prior.manifest_bytes,bytes)||
        !same(prior.manifest_digest,digest)||!same(prior.signature,signature)||!same(prior.user_consent_payload,consent.payloadBytes)||
        !same(prior.user_consent_signature,consent.signature)||!same(prior.signed_plc_operation_bytes,operation)||!same(prior.destination_binding_cose,binding))throw new Error("Completion conflicts with retained signed artifacts");
    }else await this.imports.stageImport({bytes,digest,signature,sourceMessagingPublicKey:snapshot.sourceMessagingPublicKey},consent,operation,binding);
    const operationCid=(await cidForCbor(def.operation.parse(parseJsonWithoutDuplicateKeys(new TextDecoder("utf-8",{fatal:true}).decode(operation))))).toString();
    if(prior?.state!=="active") {await this.submission.submit(manifest.transferId);await this.publication.publish(manifest.transferId);}
    const activated=await this.activation.activate(manifest.transferId),receipt=await this.activation.issueReceipt(manifest.transferId);
    return {type:"hailp.transfer-completion",version:1,did:activated.did,accountId:activated.accountId,transferId:manifest.transferId,
      operationCid,phase:"active",receipt:encodeSignedRecord(receipt)};
  }
}
