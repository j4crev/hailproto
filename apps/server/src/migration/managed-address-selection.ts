import { randomUUID } from "node:crypto";
import { def } from "@did-plc/lib";
import { decodeDeterministic } from "@hailproto/codec";
import type { SQL } from "bun";
import type { HailDidResolver } from "../plc/resolver.js";
import { managedHandshakeDigest, verifyManagedOwnerHandshake, verifyManagedProviderHandshake,
  type ManagedTransferGrant, type ManagedTransferReservation,
  type SignedManagedHandshake } from "./managed-handshake.js";
import { PreparedMigrationTarget, type PreparedTargetKeys } from "./target-keys.js";
import type { TransferRateLimit } from "./rate-limit.js";

const same = (a: Uint8Array, b: Uint8Array) => Buffer.from(a).equals(Buffer.from(b));

interface ManagedInvitationRow {
  nonce: string; transfer_id: string; grant_digest: Uint8Array; invitation_digest: Uint8Array;
  grant_bytes: Uint8Array; grant_signature: Uint8Array; invitation_bytes: Uint8Array;
  invitation_signature: Uint8Array; request_bytes: Uint8Array; request_signature: Uint8Array;
  expires_at: Date; destination_service_base: string; rotation_public_key: string;
  messaging_public_key: string; identity_public_key: string | null; custody_profile: "portable" | "managed";
}

interface ReservationRow {
  canonical_address: string; selection_bytes: Uint8Array; selection_signature: Uint8Array;
  receipt_bytes: Uint8Array; receipt_signature: Uint8Array; expires_at: Date;
  reserved_account_id: string; state: string;
}

export class ManagedTransferAddressReservation {
  constructor(private readonly sql: SQL, private readonly resolver: HailDidResolver,
    private readonly target: PreparedMigrationTarget, private readonly rateLimit?: TransferRateLimit,
    private readonly now = () => Math.floor(Date.now() / 1000)) {}

  async reserve(signed: SignedManagedHandshake): Promise<{ offer: SignedManagedHandshake;
    selection: SignedManagedHandshake; reservation: SignedManagedHandshake; prepared: PreparedTargetKeys }> {
    const raw = decodeDeterministic(signed.payloadBytes) as Partial<{ did: string }>;
    if (!raw || typeof raw.did !== "string" || !/^did:plc:[a-z2-7]{24}$/.test(raw.did)) {
      throw new Error("Managed address selection has no canonical DID");
    }
    const resolved = await this.resolver.resolve(raw.did);
    const plc = def.documentData.parse(resolved.evidence.data);
    const ownerRecoveryKey = plc.rotationKeys[0];
    if (!ownerRecoveryKey || !resolved.evidence.verification || resolved.did !== raw.did) {
      throw new Error("Managed reservation requires strict current PLC authority");
    }
    const selection = await verifyManagedOwnerHandshake(signed,
      "hail.managed-transfer-address-selection", ownerRecoveryKey);
    const seconds = this.now();
    if (selection.issued_at > seconds + 300 || selection.expires_at <= seconds) {
      throw new Error("Managed address selection expired");
    }
    if (this.rateLimit && !await this.rateLimit.admitAuthenticated("reservation", selection.did)) {
      throw new Error("Managed address selection is rate limited");
    }
    return this.sql.begin(async (tx) => {
      const row = (await tx<ManagedInvitationRow[]>`SELECT received.nonce,received.transfer_id,
        received.grant_digest,received.invitation_digest,received.grant_bytes,received.grant_signature,
        received.invitation_bytes,received.invitation_signature,received.request_bytes,received.request_signature,
        received.expires_at,prepared.destination_service_base,prepared.rotation_public_key,
        prepared.messaging_public_key,prepared.identity_public_key,prepared.custody_profile
        FROM received_transfer_invitations received JOIN prepared_migration_target_keys prepared
          ON prepared.transfer_id=received.transfer_id
        WHERE received.did=${selection.did} FOR UPDATE OF received`)[0];
      if (!row || row.custody_profile !== "managed" || !row.identity_public_key ||
        row.expires_at.getTime() <= seconds * 1000 || row.nonce !== selection.nonce ||
        row.transfer_id !== selection.transfer_id || !same(row.grant_digest, selection.grant_digest)) {
        throw new Error("No matching live managed Offer");
      }
      const grantSigned = { payloadBytes: new Uint8Array(row.grant_bytes),
        signature: new Uint8Array(row.grant_signature) };
      const acknowledgementSigned = { payloadBytes: new Uint8Array(row.invitation_bytes),
        signature: new Uint8Array(row.invitation_signature) };
      const offerSigned = { payloadBytes: new Uint8Array(row.request_bytes),
        signature: new Uint8Array(row.request_signature) };
      const grant = await verifyManagedOwnerHandshake(grantSigned, "hail.managed-transfer-grant", ownerRecoveryKey);
      const acknowledgement = await verifyManagedProviderHandshake(acknowledgementSigned,
        "hail.managed-transfer-acknowledgement", resolved.messagingDidKey);
      const offer = await verifyManagedProviderHandshake(offerSigned,
        "hail.managed-transfer-offer", row.messaging_public_key);
      const prepared: PreparedTargetKeys = { did: selection.did, transferId: row.transfer_id,
        destinationServiceBase: row.destination_service_base, rotationPublicKey: row.rotation_public_key,
        messagingPublicKey: row.messaging_public_key, custodyProfile: "managed",
        identityPublicKey: row.identity_public_key };
      const grantDigest = managedHandshakeDigest(grantSigned.payloadBytes);
      const acknowledgementDigest = managedHandshakeDigest(acknowledgementSigned.payloadBytes);
      const offerDigest = managedHandshakeDigest(offerSigned.payloadBytes);
      const domain = new URL(prepared.destinationServiceBase).hostname;
      const sourceKeys = new Set([ownerRecoveryKey, resolved.identityDidKey, resolved.messagingDidKey, ...plc.rotationKeys]);
      if (grant.did !== selection.did || grant.nonce !== selection.nonce ||
        grant.source_service_base !== resolved.serviceBase || grant.source_identity_key !== resolved.identityDidKey ||
        grant.destination_service_base !== prepared.destinationServiceBase || grant.destination_domain !== domain ||
        acknowledgement.did !== grant.did || acknowledgement.nonce !== grant.nonce ||
        acknowledgement.source_service_base !== grant.source_service_base ||
        acknowledgement.destination_service_base !== grant.destination_service_base ||
        !same(acknowledgement.grant_digest, grantDigest) ||
        offer.did !== grant.did || offer.nonce !== grant.nonce || offer.transfer_id !== prepared.transferId ||
        offer.source_service_base !== grant.source_service_base ||
        offer.destination_service_base !== prepared.destinationServiceBase ||
        !same(offer.grant_digest, grantDigest) || !same(offer.acknowledgement_digest, acknowledgementDigest) ||
        !same(selection.offer_digest, offerDigest) || selection.address.slice(selection.address.indexOf("@") + 1) !== domain ||
        offer.destination_rotation_key !== prepared.rotationPublicKey ||
        offer.destination_identity_key !== prepared.identityPublicKey ||
        offer.destination_messaging_key !== prepared.messagingPublicKey ||
        [prepared.rotationPublicKey, prepared.identityPublicKey, prepared.messagingPublicKey].some((key) => sourceKeys.has(key))) {
        throw new Error("Managed address selection does not match current source authority and destination Offer");
      }
      const existing = (await tx<ReservationRow[]>`SELECT canonical_address,selection_bytes,selection_signature,
        receipt_bytes,receipt_signature,expires_at,reserved_account_id,state FROM transfer_address_reservations
        WHERE transfer_id=${selection.transfer_id} FOR UPDATE`)[0];
      if (existing && existing.expires_at.getTime() <= seconds * 1000 && existing.state === "selected" &&
        existing.reserved_account_id) {
        await tx`DELETE FROM transfer_address_reservations WHERE transfer_id=${selection.transfer_id} AND state='selected'`;
        await tx`DELETE FROM provider_accounts WHERE id=${existing.reserved_account_id}
          AND did IS NULL AND onboarding_state='reserved'`;
      } else if (existing) {
        if (existing.canonical_address !== selection.address || !same(existing.selection_bytes, signed.payloadBytes) ||
          !same(existing.selection_signature, signed.signature)) {
          throw new Error("A different managed address selection already exists");
        }
        return { offer: offerSigned, selection: signed,
          reservation: { payloadBytes: new Uint8Array(existing.receipt_bytes),
            signature: new Uint8Array(existing.receipt_signature) }, prepared };
      }
      const reservedAccountId = randomUUID();
      const inserted = await tx<{ id: string }[]>`INSERT INTO provider_accounts
        (id,tenant_id,canonical_address,onboarding_state) VALUES
        (${reservedAccountId},${randomUUID()},${selection.address},'reserved')
        ON CONFLICT (canonical_address) DO NOTHING RETURNING id`;
      if (!inserted[0]) throw new Error("Address not available");
      const expiry = Math.min(selection.expires_at, offer.expires_at, grant.expires_at);
      const value: ManagedTransferReservation = { type: "hail.managed-transfer-reservation", version: 1,
        did: selection.did, nonce: selection.nonce, transfer_id: selection.transfer_id,
        offer_digest: offerDigest, selection_digest: managedHandshakeDigest(signed.payloadBytes),
        address: selection.address, destination_rotation_key: prepared.rotationPublicKey,
        destination_identity_key: prepared.identityPublicKey, destination_messaging_key: prepared.messagingPublicKey,
        issued_at: seconds, expires_at: expiry };
      const reservation = await this.target.signManagedArtifact(prepared, value);
      await tx`INSERT INTO transfer_address_reservations(transfer_id,did,canonical_address,reserved_account_id,
        selection_bytes,selection_signature,receipt_bytes,receipt_signature,expires_at)
        VALUES (${selection.transfer_id},${selection.did},${selection.address},${reservedAccountId},
          ${signed.payloadBytes},${signed.signature},${reservation.payloadBytes},${reservation.signature},
          ${new Date(expiry * 1000)})`;
      return { offer: offerSigned, selection: signed, reservation, prepared };
    });
  }
}
