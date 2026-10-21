import { decodeDeterministic,encodeBase64Url } from "@hailproto/codec";
import type { SQL } from "bun";
import type { AccountApiSession } from "./repository.js";
import type { TransferGrantSubmission } from "../migration/grant-submission.js";
import type { TransferCancellationService } from "../migration/cancellation.js";
import type { SignedHandshake } from "../migration/handshake.js";
import { parseRequestWire } from "../migration/wire.js";
import type { MigrationFenceService } from "../migration/fence.js";
import { validateTransferManifest, type MigrationTransferService } from "../migration/transfer.js";

export class AccountTransferError extends Error {constructor(readonly status:400|403|409,message:string){super(message);}}
const wire=(signed:SignedHandshake)=>({payload:encodeBase64Url(signed.payloadBytes),signature:encodeBase64Url(signed.signature)});
export class AccountTransfer {
  constructor(private readonly sql:SQL,private readonly submission:Pick<TransferGrantSubmission,"submit">,
    private readonly cancellation:Pick<TransferCancellationService,"cancel">,private readonly provider:string,
    private readonly exports?:{fence:Pick<MigrationFenceService,"get">;snapshots:Pick<MigrationTransferService,"exportFenced">}){}

  private async owner(session:AccountApiSession) {
    const rows=await this.sql`SELECT account.id FROM provider_accounts account
      JOIN portable_custody_evidence owner ON owner.account_id=account.id
      JOIN account_api_credentials credential ON credential.account_id=account.id AND credential.id=${session.credential_id}
      WHERE account.id=${session.account_id} AND account.did=${session.did} AND account.canonical_address=${session.canonical_address}
        AND account.onboarding_state='active' AND account.activation_verification_mode='public'
        AND credential.revoked_at IS NULL AND credential.expires_at>clock_timestamp() AND credential.scopes ? 'account:write'
        AND NOT EXISTS (SELECT 1 FROM managed_custody_evidence managed WHERE managed.account_id=account.id)
        AND NOT EXISTS (SELECT 1 FROM account_keys held WHERE held.account_id=account.id AND held.role='hail-identity')`;
    if(!rows.length)throw new AccountTransferError(403,"Transfer preparation requires current owner-controlled account authority");
  }
  private async writer(session:AccountApiSession) {
    await this.owner(session);
    if((await this.sql`SELECT did FROM provider_migration_fences WHERE account_id=${session.account_id}`).length)throw new AccountTransferError(409,"A source fence requires reviewed cutover/recovery, not a new Offer or cancellation");
  }
  private signed(input:Record<string,unknown>,session:AccountApiSession,kind:string) {
    try {
      const signed=parseRequestWire(new TextEncoder().encode(JSON.stringify(input)));
      const payload=decodeDeterministic(signed.payloadBytes) as Record<string,unknown>;
      if(!payload||payload.type!==kind||payload.did!==session.did||kind==="hail.transfer-grant"&&payload.source_service_base!==`${this.provider}/hail`)throw new Error("Wrong transfer subject");
      return signed;
    }catch{throw new AccountTransferError(400,"Signed transfer is not for the authenticated account/provider");}
  }
  async offer(session:AccountApiSession,input:Record<string,unknown>) {
    await this.writer(session);const signed=this.signed(input,session,"hail.transfer-grant");
    await this.submission.submit(signed); // Exact bytes persist before attempted destination-origin delivery.
    return this.status(session);
  }
  async cancel(session:AccountApiSession,input:Record<string,unknown>) {
    await this.writer(session);const signed=this.signed(input,session,"hail.transfer-cancellation");
    const receipt=await this.cancellation.cancel(signed);
    const keys=await this.sql<{public_key:string}[]>`SELECT public_key FROM account_keys WHERE account_id=${session.account_id} AND role='hail-messaging'`;
    if(!keys[0])throw new AccountTransferError(409,"Cancellation operational key unavailable");
    return {type:"hailp.transfer-cancellation",version:1,cancelled:true,sourceMessagingPublicKey:keys[0].public_key,receipt:wire(receipt)};
  }
  async exportSnapshot(session:AccountApiSession,input:Record<string,unknown>) {
    await this.owner(session);
    if(Object.keys(input).length!==1||typeof input.transferId!=="string"||!/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/.test(input.transferId))throw new AccountTransferError(400,"Export requires the exact transfer ID");
    if(!this.exports)throw new AccountTransferError(409,"Snapshot export is not enabled");
    const fence=await this.exports.fence.get(session.did);
    if(!fence||fence.accountId!==session.account_id||fence.transferId!==input.transferId||!["fenced","exported"].includes(fence.state))throw new AccountTransferError(409,"Matching fenced/exported source was not found");
    const snapshot=await this.exports.snapshots.exportFenced(fence);
    const version=validateTransferManifest(snapshot.bytes).version;
    return {type:"hail.portable-migration-transfer",version,manifest:encodeBase64Url(snapshot.bytes),digest:encodeBase64Url(snapshot.digest),
      signature:encodeBase64Url(snapshot.signature),sourceMessagingPublicKey:snapshot.sourceMessagingPublicKey};
  }
  async status(session:AccountApiSession) {
    const rows=await this.sql<{nonce:string;destination_service_base:string;expires_at:Date;origin_confirmed_at:Date|null;
      origin_request_bytes:Uint8Array|null;origin_request_signature:Uint8Array|null;cancelled_at:Date|null;consumed_transfer_id:string|null}[]>`
      SELECT nonce,destination_service_base,expires_at,origin_confirmed_at,origin_request_bytes,origin_request_signature,cancelled_at,consumed_transfer_id
      FROM provider_transfer_authorizations WHERE did=${session.did}`;
    const fences=await this.sql<{state:string;transfer_id:string}[]>`SELECT state,transfer_id FROM provider_migration_fences
      WHERE account_id=${session.account_id} AND did=${session.did}`;
    const row=rows[0],fence=fences[0],expired=!!row&&row.expires_at.getTime()<=Date.now();
    const offerId=row?.origin_request_bytes?(decodeDeterministic(row.origin_request_bytes) as Record<string,unknown>).transfer_id:null;
    const phase=fence?.state ?? (!row?"none":row.cancelled_at?"cancelled":expired?row.origin_confirmed_at?"expired-unresolved":"expired":row.origin_confirmed_at?"offer-ready":"invitation-pending");
    return {type:"hailp.transfer-status",version:1,provider:this.provider,accountId:session.account_id,did:session.did,
      phase,nonce:row?.nonce ?? null,destinationServiceBase:row?.destination_service_base ?? null,expiresAt:row?.expires_at.toISOString() ?? null,
      originConfirmed:!!row?.origin_confirmed_at,transferId:fence?.transfer_id ?? row?.consumed_transfer_id ?? offerId ?? null,
      offer:row?.origin_request_bytes&&row.origin_request_signature?wire({payloadBytes:new Uint8Array(row.origin_request_bytes),signature:new Uint8Array(row.origin_request_signature)}):null};
  }
}
