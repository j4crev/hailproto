import {decodeDeterministic,encodeBase64Url} from "@hailproto/codec";
import type {SQL} from "bun";
import type {ManagedTransferAuthorization} from "../migration/managed-authorization.js";
import type {ManagedTransferDelivery} from "../migration/managed-delivery.js";
import type {SignedManagedHandshake} from "../migration/managed-handshake.js";
import type {ManagedMigrationFenceService} from "../migration/managed-fence.js";
import {validateManagedTransferManifest,type ManagedMigrationExportService} from "../migration/managed-snapshot.js";
import {parseRequestWire} from "../migration/wire.js";
import type {AccountApiSession} from "./repository.js";
import {AccountTransferError} from "./transfer.js";

const wire=(signed:SignedManagedHandshake)=>({payload:encodeBase64Url(signed.payloadBytes),signature:encodeBase64Url(signed.signature)});

export class ManagedAccountTransfer {
  constructor(private readonly sql:SQL,private readonly authorization:Pick<ManagedTransferAuthorization,"authorize">,
    private readonly delivery:Pick<ManagedTransferDelivery,"deliver">,private readonly provider:string,
    private readonly exports?:{fence:Pick<ManagedMigrationFenceService,"get">;
      snapshots:Pick<ManagedMigrationExportService,"exportFenced">}) {}

  private async owner(session:AccountApiSession) {
    const rows=await this.sql`SELECT account.id FROM provider_accounts account
      JOIN managed_custody_evidence managed ON managed.account_id=account.id
      JOIN account_api_credentials credential ON credential.account_id=account.id AND credential.id=${session.credential_id}
      WHERE account.id=${session.account_id} AND account.did=${session.did} AND account.canonical_address=${session.canonical_address}
        AND account.onboarding_state='active' AND account.activation_verification_mode='public'
        AND credential.revoked_at IS NULL AND credential.expires_at>clock_timestamp() AND credential.scopes ? 'account:write'
        AND EXISTS (SELECT 1 FROM account_keys held WHERE held.account_id=account.id AND held.role='hail-identity'
          AND held.public_key=managed.provider_identity_public_key)`;
    if(!rows.length)throw new AccountTransferError(403,"Managed transfer requires current provider-custody authority");
  }
  private async writer(session:AccountApiSession) {
    await this.owner(session);
    if((await this.sql`SELECT 1 FROM provider_migration_fences WHERE account_id=${session.account_id}`).length)
      throw new AccountTransferError(409,"A managed source fence cannot start another transfer handshake");
  }

  private signed(input:Record<string,unknown>,session:AccountApiSession) {
    try {
      const signed=parseRequestWire(new TextEncoder().encode(JSON.stringify(input)));
      const payload=decodeDeterministic(signed.payloadBytes) as Record<string,unknown>;
      if(!payload||payload.type!=="hail.managed-transfer-grant"||payload.did!==session.did||
        payload.source_service_base!==`${this.provider}/hail`)throw new Error("Wrong managed transfer subject");
      return signed;
    } catch {throw new AccountTransferError(400,"Signed managed transfer is not for the authenticated account/provider");}
  }

  async offer(session:AccountApiSession,input:Record<string,unknown>) {
    await this.writer(session);const grant=this.signed(input,session);let acknowledgement:SignedManagedHandshake;
    try{acknowledgement=await this.authorization.authorize(grant);}
    catch{throw new AccountTransferError(409,"Managed transfer authorization was refused");}
    try {await this.delivery.deliver(session.did);} catch {}
    return this.status(session,acknowledgement);
  }

  async status(session:AccountApiSession,knownAcknowledgement?:SignedManagedHandshake) {
    const owned=await this.sql`SELECT 1 FROM provider_accounts account JOIN managed_custody_evidence managed ON managed.account_id=account.id
      WHERE account.id=${session.account_id} AND account.did=${session.did}`;
    if(!owned.length)throw new AccountTransferError(403,"Managed transfer status requires managed custody");
    const row=(await this.sql<{custody_profile:string;destination_service_base:string;expires_at:Date;
      invitation_bytes:Uint8Array;invitation_signature:Uint8Array;origin_request_bytes:Uint8Array|null;
      origin_request_signature:Uint8Array|null;origin_confirmed_at:Date|null;consumed_transfer_id:string|null}[]>`
      SELECT custody_profile,destination_service_base,expires_at,invitation_bytes,invitation_signature,
        origin_request_bytes,origin_request_signature,origin_confirmed_at,consumed_transfer_id
      FROM provider_transfer_authorizations WHERE did=${session.did}`)[0];
    if(!row)return {type:"hailp.managed-transfer-status",version:1,provider:this.provider,accountId:session.account_id,
      did:session.did,phase:"none",destinationServiceBase:null,expiresAt:null,originConfirmed:false,transferId:null,
      acknowledgement:null,offer:null};
    if(row.custody_profile!=="managed")throw new AccountTransferError(409,"A portable transfer already occupies this DID");
    const acknowledgement=knownAcknowledgement??{payloadBytes:new Uint8Array(row.invitation_bytes),signature:new Uint8Array(row.invitation_signature)};
    const offer=row.origin_request_bytes&&row.origin_request_signature?{payloadBytes:new Uint8Array(row.origin_request_bytes),
      signature:new Uint8Array(row.origin_request_signature)}:null;
    const expired=row.expires_at.getTime()<=Date.now(),transferId=offer?
      (decodeDeterministic(offer.payloadBytes) as Record<string,unknown>).transfer_id:null;
    return {type:"hailp.managed-transfer-status",version:1,provider:this.provider,accountId:session.account_id,did:session.did,
      phase:expired?row.origin_confirmed_at?"expired-unresolved":"expired":row.origin_confirmed_at?"offer-ready":"acknowledgement-retained",
      destinationServiceBase:row.destination_service_base,expiresAt:row.expires_at.toISOString(),originConfirmed:!!row.origin_confirmed_at,
      transferId:row.consumed_transfer_id??transferId??null,acknowledgement:wire(acknowledgement),offer:offer?wire(offer):null};
  }

  async exportSnapshot(session:AccountApiSession,input:Record<string,unknown>) {
    await this.owner(session);
    if(Object.keys(input).length!==1||typeof input.transferId!=="string"||
      !/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/.test(input.transferId))
      throw new AccountTransferError(400,"Managed export requires the exact transfer ID");
    if(!this.exports)throw new AccountTransferError(409,"Managed snapshot export is not enabled");
    const fence=await this.exports.fence.get(session.did);
    if(!fence||fence.accountId!==session.account_id||fence.transferId!==input.transferId||
      !["fenced","exported"].includes(fence.state))throw new AccountTransferError(409,"Matching managed source fence was not found");
    const snapshot=await this.exports.snapshots.exportFenced(fence);
    validateManagedTransferManifest(snapshot.bytes);
    return {type:"hail.managed-migration-transfer",version:4,manifest:encodeBase64Url(snapshot.bytes),
      digest:encodeBase64Url(snapshot.digest),signature:encodeBase64Url(snapshot.signature),
      sourceMessagingPublicKey:snapshot.sourceMessagingPublicKey};
  }
}
