import { randomUUID } from "node:crypto";
import { decodeDeterministic } from "@hailproto/codec";
import type { SQL } from "bun";
import type { HailDidResolver } from "../plc/resolver.js";
import { handshakeDigest, sameDigest, verifyHandshake, type SignedHandshake,
  type TransferAddressSelection, type TransferOffer, type TransferReservation } from "./handshake.js";
import { PreparedMigrationTarget, type PreparedTargetKeys } from "./target-keys.js";
import type { TransferRateLimit } from "./rate-limit.js";

interface InvitationRow {
  did: string; nonce: string; transfer_id: string;
  grant_digest: Uint8Array; invitation_digest: Uint8Array;
  grant_bytes: Uint8Array | null; grant_signature: Uint8Array | null;
  invitation_bytes: Uint8Array | null; invitation_signature: Uint8Array | null;
  request_bytes: Uint8Array; request_signature: Uint8Array; expires_at: Date;
}
interface ReservationRow {
  canonical_address: string; selection_bytes: Uint8Array; selection_signature: Uint8Array;
  receipt_bytes: Uint8Array; receipt_signature: Uint8Array; expires_at: Date;
  reserved_account_id: string; state: string;
}

export class TransferAddressReservation {
  constructor(private readonly sql: SQL, private readonly resolver: HailDidResolver,
    private readonly target: PreparedMigrationTarget,
    private readonly rateLimit?: TransferRateLimit) {}

  async reserve(signed: SignedHandshake): Promise<{ offer: SignedHandshake;
    selection: SignedHandshake; receipt: SignedHandshake; prepared: PreparedTargetKeys }> {
    const raw: unknown = decodeDeterministic(signed.payloadBytes);
    if (!raw || typeof raw !== "object" || !("did" in raw) || typeof raw.did !== "string" ||
      !/^did:plc:[a-z2-7]{24}$/.test(raw.did)) throw new Error("Invalid address-selection DID");
    const resolved = await this.resolver.resolve(raw.did);
    const selection = await verifyHandshake(signed, "hail.transfer-address-selection", resolved.identityDidKey);
    const now = Math.floor(Date.now() / 1000);
    if (selection.issued_at > now + 300 || selection.expires_at <= now) throw new Error("Address selection expired");
    if (this.rateLimit && !await this.rateLimit.admitAuthenticated("reservation", selection.did)) {
      throw new Error("Transfer address selection is rate limited");
    }
    return this.sql.begin(async (tx) => {
      const invitations = await tx<InvitationRow[]>`
        SELECT did, nonce, transfer_id, grant_digest, invitation_digest,
          grant_bytes, grant_signature, invitation_bytes, invitation_signature,
          request_bytes, request_signature, expires_at
        FROM received_transfer_invitations WHERE did = ${selection.did} FOR UPDATE`;
      const invitation = invitations[0];
      if (!invitation || invitation.expires_at.getTime() <= Date.now() ||
        invitation.nonce !== selection.nonce || invitation.transfer_id !== selection.transfer_id ||
        !sameDigest(invitation.grant_digest, selection.grant_digest)) {
        throw new Error("No matching live transfer offer");
      }
      if (!invitation.grant_bytes || !invitation.grant_signature ||
        !invitation.invitation_bytes || !invitation.invitation_signature) {
        throw new Error("Transfer invitation lacks current user authority evidence");
      }
      const currentGrant = await verifyHandshake({ payloadBytes: invitation.grant_bytes,
        signature: invitation.grant_signature }, "hail.transfer-grant", resolved.identityDidKey);
      const currentInvitation = await verifyHandshake({ payloadBytes: invitation.invitation_bytes,
        signature: invitation.invitation_signature }, "hail.transfer-invitation", resolved.messagingDidKey);
      if (currentGrant.did !== selection.did || currentGrant.nonce !== selection.nonce ||
        currentGrant.source_service_base !== resolved.serviceBase ||
        !sameDigest(handshakeDigest(invitation.grant_bytes), selection.grant_digest) ||
        currentInvitation.did !== selection.did || currentInvitation.nonce !== selection.nonce ||
        !sameDigest(currentInvitation.grant_digest, selection.grant_digest) ||
        !sameDigest(handshakeDigest(invitation.invitation_bytes), invitation.invitation_digest)) {
        throw new Error("User transfer grant no longer matches current PLC identity");
      }
      const keys = await tx<{ destination_service_base: string; rotation_public_key: string;
        messaging_public_key: string }[]>`
        SELECT destination_service_base, rotation_public_key, messaging_public_key
        FROM prepared_migration_target_keys WHERE transfer_id = ${invitation.transfer_id}`;
      const key = keys[0];
      if (!key) throw new Error("Prepared target key unavailable");
      const prepared: PreparedTargetKeys = { did: selection.did, transferId: invitation.transfer_id,
        destinationServiceBase: key.destination_service_base,
        rotationPublicKey: key.rotation_public_key, messagingPublicKey: key.messaging_public_key };
      const offerSigned: SignedHandshake = { payloadBytes: invitation.request_bytes,
        signature: invitation.request_signature };
      const offer = await verifyHandshake(offerSigned, "hail.transfer-offer", prepared.messagingPublicKey);
      const domain = new URL(prepared.destinationServiceBase).hostname;
      if (offer.did !== selection.did || offer.transfer_id !== prepared.transferId ||
        offer.destination_service_base !== prepared.destinationServiceBase ||
        currentGrant.destination_service_base !== prepared.destinationServiceBase ||
        currentGrant.destination_domain !== domain ||
        offer.destination_messaging_key !== prepared.messagingPublicKey ||
        !sameDigest(offer.invitation_challenge, currentInvitation.challenge) ||
        offer.expires_at <= now || resolved.serviceBase !== offer.source_service_base ||
        !sameDigest(selection.offer_digest, handshakeDigest(offerSigned.payloadBytes)) ||
        selection.address.slice(selection.address.indexOf("@") + 1) !== domain) {
        throw new Error("Address selection is not for this provider's current offer");
      }
      const existing = await tx<ReservationRow[]>`
        SELECT canonical_address, selection_bytes, selection_signature, receipt_bytes,
          receipt_signature, expires_at, reserved_account_id, state
        FROM transfer_address_reservations WHERE transfer_id = ${selection.transfer_id} FOR UPDATE`;
      if (existing[0] && existing[0].expires_at.getTime() <= Date.now() &&
        existing[0].state === "selected" && existing[0].reserved_account_id) {
        // Safe only before any final-request push could have fenced the source.
        await tx`DELETE FROM transfer_address_reservations WHERE transfer_id = ${selection.transfer_id}
          AND state = 'selected'`;
        await tx`DELETE FROM provider_accounts WHERE id = ${existing[0].reserved_account_id}
          AND did IS NULL AND onboarding_state = 'reserved'`;
      } else if (existing[0]) {
        if (existing[0].canonical_address !== selection.address ||
          !sameDigest(existing[0].selection_bytes, signed.payloadBytes) ||
          !sameDigest(existing[0].selection_signature, signed.signature)) {
          throw new Error("A different address is already selected for this transfer");
        }
        return { offer: offerSigned, selection: signed,
          receipt: { payloadBytes: new Uint8Array(existing[0].receipt_bytes),
            signature: new Uint8Array(existing[0].receipt_signature) }, prepared };
      }
      const reservedAccountId = randomUUID();
      const occupied = await tx<{ id: string }[]>`
        INSERT INTO provider_accounts (id, tenant_id, canonical_address, onboarding_state)
        VALUES (${reservedAccountId}, ${randomUUID()}, ${selection.address}, 'reserved')
        ON CONFLICT (canonical_address) DO NOTHING RETURNING id`;
      if (!occupied[0]) throw new Error("Address not available");
      const expiry = Math.min(selection.expires_at, offer.expires_at);
      const payload: TransferReservation = { type: "hail.transfer-reservation", version: 1,
        did: selection.did, nonce: selection.nonce, transfer_id: selection.transfer_id,
        offer_digest: selection.offer_digest, selection_digest: handshakeDigest(signed.payloadBytes),
        address: selection.address, issued_at: now, expires_at: expiry };
      const receipt = await this.target.signReservation(prepared, payload);
      await tx`INSERT INTO transfer_address_reservations
        (transfer_id, did, canonical_address, reserved_account_id, selection_bytes,
         selection_signature, receipt_bytes, receipt_signature, expires_at)
        VALUES (${selection.transfer_id}, ${selection.did}, ${selection.address},
          ${reservedAccountId}, ${signed.payloadBytes}, ${signed.signature},
          ${receipt.payloadBytes}, ${receipt.signature}, ${new Date(expiry * 1000)})`;
      return { offer: offerSigned, selection: signed, receipt, prepared };
    });
  }
}
