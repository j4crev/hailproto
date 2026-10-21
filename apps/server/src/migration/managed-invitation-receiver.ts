import { decodeDeterministic } from "@hailproto/codec";
import type { SQL } from "bun";
import type { HailDidResolver } from "../plc/resolver.js";
import { managedHandshakeDigest, verifyManagedProviderHandshake,
  type ManagedTransferGrant, type SignedManagedHandshake } from "./managed-handshake.js";
import { PreparedMigrationTarget, type PreparedTargetKeys } from "./target-keys.js";

const same=(a:Uint8Array,b:Uint8Array)=>Buffer.from(a).equals(Buffer.from(b));

interface ReceivedManaged {
  nonce:string;grant_digest:Uint8Array;invitation_digest:Uint8Array;transfer_id:string;
  request_bytes:Uint8Array;request_signature:Uint8Array;expires_at:Date;
  destination_service_base:string;rotation_public_key:string;messaging_public_key:string;
  identity_public_key:string|null;custody_profile:"portable"|"managed";
}

export class ManagedTransferInvitationReceiver {
  constructor(private readonly sql:SQL,private readonly resolver:HailDidResolver,
    private readonly target:PreparedMigrationTarget) {}

  async receive(grantSigned:SignedManagedHandshake,acknowledgementSigned:SignedManagedHandshake):Promise<SignedManagedHandshake> {
    if(!grantSigned.payloadBytes.length||grantSigned.payloadBytes.length>8192)throw new Error("Managed grant exceeds limit");
    const decoded=decodeDeterministic(grantSigned.payloadBytes) as Partial<ManagedTransferGrant>;
    if(!decoded||decoded.type!=="hail.managed-transfer-grant"||typeof decoded.did!=="string"||
      !/^did:plc:[a-z2-7]{24}$/.test(decoded.did))throw new Error("Managed grant has no canonical DID");
    const did=decoded.did,grantDigest=managedHandshakeDigest(grantSigned.payloadBytes);
    const acknowledgementDigest=managedHandshakeDigest(acknowledgementSigned.payloadBytes);
    return this.sql.begin(async tx=>{
      await tx`SELECT pg_advisory_xact_lock(684245103,hashtext(${did}))`;
      await this.target.recycleRetiredSlots(tx,did,"managed");
      const cancelled=await tx`SELECT 1 FROM cancelled_transfer_sessions WHERE did=${did} AND nonce=${decoded.nonce}`;
      if(cancelled.length)throw new Error("This managed transfer session was cancelled by the source");
      const row=(await tx<ReceivedManaged[]>`SELECT received.nonce,received.grant_digest,received.invitation_digest,
        received.transfer_id,received.request_bytes,received.request_signature,received.expires_at,
        prepared.destination_service_base,prepared.rotation_public_key,prepared.messaging_public_key,
        prepared.identity_public_key,prepared.custody_profile
        FROM received_transfer_invitations received JOIN prepared_migration_target_keys prepared
          ON prepared.transfer_id=received.transfer_id WHERE received.did=${did} FOR UPDATE OF received`)[0];
      if(row){
        if(row.custody_profile!=="managed"||row.nonce!==decoded.nonce||!same(row.grant_digest,grantDigest)||
          !same(row.invitation_digest,acknowledgementDigest))throw new Error("Another destination transfer already occupies this DID");
        if(row.expires_at.getTime()<=Date.now()||!row.identity_public_key)throw new Error("Managed destination invitation has expired or lost its identity role");
        const prepared:PreparedTargetKeys={transferId:row.transfer_id,did,destinationServiceBase:row.destination_service_base,
          rotationPublicKey:row.rotation_public_key,messagingPublicKey:row.messaging_public_key,
          custodyProfile:"managed",identityPublicKey:row.identity_public_key};
        await this.target.createManagedOffer(prepared,grantSigned,acknowledgementSigned,this.resolver);
        const prior={payloadBytes:new Uint8Array(row.request_bytes),signature:new Uint8Array(row.request_signature)};
        const offer=await verifyManagedProviderHandshake(prior,"hail.managed-transfer-offer",prepared.messagingPublicKey);
        if(offer.did!==did||offer.nonce!==decoded.nonce||offer.transfer_id!==prepared.transferId||
          !same(offer.grant_digest,grantDigest)||!same(offer.acknowledgement_digest,acknowledgementDigest)||
          offer.destination_identity_key!==prepared.identityPublicKey||offer.destination_rotation_key!==prepared.rotationPublicKey)
          throw new Error("Stored managed Offer conflicts with the admitted transfer");
        return prior;
      }
      const prepared=await this.target.prepare(did,"managed");
      const offer=await this.target.createManagedOffer(prepared,grantSigned,acknowledgementSigned,this.resolver);
      const parsed=await verifyManagedProviderHandshake(offer,"hail.managed-transfer-offer",prepared.messagingPublicKey);
      await tx`INSERT INTO received_transfer_invitations(did,nonce,grant_digest,invitation_digest,transfer_id,
        request_bytes,request_signature,grant_bytes,grant_signature,invitation_bytes,invitation_signature,expires_at)
        VALUES (${did},${parsed.nonce},${grantDigest},${acknowledgementDigest},${prepared.transferId},${offer.payloadBytes},
          ${offer.signature},${grantSigned.payloadBytes},${grantSigned.signature},${acknowledgementSigned.payloadBytes},
          ${acknowledgementSigned.signature},${new Date(parsed.expires_at*1000)})`;
      return offer;
    });
  }
}
