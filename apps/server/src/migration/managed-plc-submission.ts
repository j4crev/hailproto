import {createHash} from "node:crypto";
import {isDeepStrictEqual} from "node:util";
import {cidForCbor} from "@atproto/common";
import {def,validateOperationLog,type Operation} from "@did-plc/lib";
import {decodeBase64Url} from "@hailproto/codec";
import type {SQL} from "bun";
import {parseJsonWithoutDuplicateKeys} from "../discovery/strict-json.js";
import type {PlcDirectoryClient} from "../plc/client.js";
import type {HailDidResolver} from "../plc/resolver.js";
import {verifyManagedOwnerHandshake} from "./managed-handshake.js";
import {validateManagedTransferManifest} from "./managed-snapshot.js";

const same=(a:Uint8Array,b:Uint8Array)=>Buffer.from(a).equals(Buffer.from(b));

export class ManagedMigrationPlcSubmission {
  constructor(private readonly sql:SQL,private readonly plc:Pick<PlcDirectoryClient,"getOperationLog"|"sendOperation">,
    private readonly resolver:HailDidResolver,private readonly destinationServiceBase:string) {}

  async submit(transferId:string):Promise<string> {
    return this.sql.begin(async tx=>{
      const row=(await tx<{did:string;state:string;custody_profile:string;manifest_bytes:Uint8Array;
        signed_plc_operation_bytes:Uint8Array;user_consent_payload:Uint8Array;user_consent_signature:Uint8Array;
        owner_recovery_public_key:string;destination_identity_public_key:string}[]>`
        SELECT did,state,custody_profile,manifest_bytes,signed_plc_operation_bytes,user_consent_payload,
          user_consent_signature,owner_recovery_public_key,destination_identity_public_key
        FROM pending_migration_imports WHERE transfer_id=${transferId} FOR UPDATE`)[0];
      if(!row||!["staged","active"].includes(row.state)||row.custody_profile!=="managed")
        throw new Error("Managed PLC write requires the retained staged or active import");
      const manifest=validateManagedTransferManifest(row.manifest_bytes);
      if(manifest.transferId!==transferId||manifest.did!==row.did||manifest.destinationServiceBase!==this.destinationServiceBase||
        manifest.ownerRecoveryPublicKey!==row.owner_recovery_public_key||
        manifest.destinationIdentityPublicKey!==row.destination_identity_public_key)
        throw new Error("Managed PLC write differs from the retained destination import");
      const approval=await verifyManagedOwnerHandshake({payloadBytes:new Uint8Array(row.user_consent_payload),
        signature:new Uint8Array(row.user_consent_signature)},"hail.managed-transfer-approval",manifest.ownerRecoveryPublicKey);
      const operation=def.operation.parse(parseJsonWithoutDuplicateKeys(new TextDecoder("utf-8",{fatal:true}).decode(row.signed_plc_operation_bytes)));
      const expectedCid=(await cidForCbor(operation)).toString();
      if(approval.did!==manifest.did||approval.transfer_id!==manifest.transferId||
        approval.source_service_base!==manifest.sourceServiceBase||approval.owner_recovery_key!==manifest.ownerRecoveryPublicKey||
        approval.source_identity_key!==manifest.sourceIdentityPublicKey||approval.snapshot_version!==4||
        !same(approval.snapshot_digest,new Uint8Array(createHash("sha256").update(row.manifest_bytes).digest()))||
        !same(approval.history_checkpoint_digest,decodeBase64Url(manifest.historyCheckpointDigest))||
        approval.source_generation!==manifest.sourceGeneration||approval.operation_cid!==expectedCid||approval.previous_operation_cid!==operation.prev||
        approval.destination_service_base!==manifest.destinationServiceBase||
        approval.destination_identity_key!==manifest.destinationIdentityPublicKey||
        approval.destination_messaging_key!==manifest.destinationMessagingPublicKey||
        approval.destination_rotation_key!==manifest.destinationRotationPublicKey)
        throw new Error("Managed PLC operation differs from the retained owner approval");
      let log=await this.plc.getOperationLog(row.did),last=log.at(-1),current=last?(await cidForCbor(last)).toString():null;
      if(current!==expectedCid) {
        if(current!==operation.prev||!await validateOperationLog(row.did,[...log,operation]))
          throw new Error("PLC history advanced beyond the approved managed predecessor");
        try {await this.plc.sendOperation(row.did,operation as Operation);}
        catch(error) {
          log=await this.plc.getOperationLog(row.did);last=log.at(-1);current=last?(await cidForCbor(last)).toString():null;
          if(current!==expectedCid)throw new Error("Managed PLC cutover write remains ambiguous; retry the exact operation",{cause:error});
        }
      }
      log=await this.plc.getOperationLog(row.did);last=log.at(-1);current=last?(await cidForCbor(last)).toString():null;
      if(current!==expectedCid)throw new Error("PLC did not retain the exact owner-approved managed cutover");
      const expected=await validateOperationLog(row.did,log),resolved=await this.resolver.resolve(row.did);
      if(!expected||resolved.did!==row.did||resolved.serviceBase!==manifest.destinationServiceBase||
        resolved.identityDidKey!==manifest.destinationIdentityPublicKey||resolved.messagingDidKey!==manifest.destinationMessagingPublicKey||
        resolved.evidence.verification?.operationCid!==expectedCid||!isDeepStrictEqual(resolved.evidence.data,expected))
        throw new Error("Validated public reader does not confirm the exact managed destination state");
      return expectedCid;
    });
  }
}
