import { def } from "@did-plc/lib";
import type { SQL } from "bun";
import type { DiscoveryFetch, NetworkTargetValidator } from "../discovery/verifier.js";
import type { HailDidResolver } from "../plc/resolver.js";
import { managedHandshakeDigest, verifyManagedOwnerHandshake, verifyManagedProviderHandshake,
  type ManagedTransferFenceRequest, type SignedManagedHandshake } from "./managed-handshake.js";
import { PreparedMigrationTarget, type PreparedTargetKeys } from "./target-keys.js";
import { finalRequestWire, MAX_TRANSFER_WIRE_BYTES, TRANSFER_MEDIA_TYPE } from "./wire.js";

const same = (a: Uint8Array, b: Uint8Array) => Buffer.from(a).equals(Buffer.from(b));

interface PreparedRow {
  did: string; transfer_id: string; grant_bytes: Uint8Array; grant_signature: Uint8Array;
  invitation_bytes: Uint8Array; invitation_signature: Uint8Array; request_bytes: Uint8Array;
  request_signature: Uint8Array; final_request_bytes: Uint8Array | null;
  final_request_signature: Uint8Array | null; destination_service_base: string;
  rotation_public_key: string; messaging_public_key: string; identity_public_key: string | null;
  custody_profile: "portable" | "managed";
}

interface ReservationRow {
  selection_bytes: Uint8Array; selection_signature: Uint8Array; receipt_bytes: Uint8Array;
  receipt_signature: Uint8Array; state: string;
}

export class ManagedTransferFencePublisher {
  constructor(private readonly sql: SQL, private readonly resolver: HailDidResolver,
    private readonly target: PreparedMigrationTarget, private readonly fetch: DiscoveryFetch,
    private readonly validateTarget: NetworkTargetValidator,
    private readonly now = () => Math.floor(Date.now() / 1000)) {}

  async publish(transferId: string): Promise<void> {
    if (!/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/.test(transferId)) {
      throw new Error("Managed transfer ID is not canonical");
    }
    const records = await this.sql.begin(async (tx) => {
      const row = (await tx<PreparedRow[]>`SELECT received.did,received.transfer_id,received.grant_bytes,
        received.grant_signature,received.invitation_bytes,received.invitation_signature,received.request_bytes,
        received.request_signature,received.final_request_bytes,received.final_request_signature,
        prepared.destination_service_base,prepared.rotation_public_key,prepared.messaging_public_key,
        prepared.identity_public_key,prepared.custody_profile
        FROM received_transfer_invitations received JOIN prepared_migration_target_keys prepared
          ON prepared.transfer_id=received.transfer_id WHERE received.transfer_id=${transferId}
        FOR UPDATE OF received`)[0];
      if (!row || row.custody_profile !== "managed" || !row.identity_public_key) {
        throw new Error("No prepared managed transfer Offer");
      }
      const reserved = (await tx<ReservationRow[]>`SELECT selection_bytes,selection_signature,receipt_bytes,
        receipt_signature,state FROM transfer_address_reservations WHERE transfer_id=${transferId} FOR UPDATE`)[0];
      if (!reserved) throw new Error("No authenticated managed address reservation");
      const grantSigned = { payloadBytes: new Uint8Array(row.grant_bytes), signature: new Uint8Array(row.grant_signature) };
      const acknowledgementSigned = { payloadBytes: new Uint8Array(row.invitation_bytes),
        signature: new Uint8Array(row.invitation_signature) };
      const offerSigned = { payloadBytes: new Uint8Array(row.request_bytes), signature: new Uint8Array(row.request_signature) };
      const selectionSigned = { payloadBytes: new Uint8Array(reserved.selection_bytes),
        signature: new Uint8Array(reserved.selection_signature) };
      const reservationSigned = { payloadBytes: new Uint8Array(reserved.receipt_bytes),
        signature: new Uint8Array(reserved.receipt_signature) };
      const state = await this.resolver.resolve(row.did);
      const plc = def.documentData.parse(state.evidence.data);
      const ownerRecoveryKey = plc.rotationKeys[0];
      if (!ownerRecoveryKey || !state.evidence.verification || state.did !== row.did) {
        throw new Error("Managed fence publication requires strict current PLC authority");
      }
      const grant = await verifyManagedOwnerHandshake(grantSigned, "hail.managed-transfer-grant", ownerRecoveryKey);
      const acknowledgement = await verifyManagedProviderHandshake(acknowledgementSigned,
        "hail.managed-transfer-acknowledgement", state.messagingDidKey);
      const offer = await verifyManagedProviderHandshake(offerSigned,
        "hail.managed-transfer-offer", row.messaging_public_key);
      const selection = await verifyManagedOwnerHandshake(selectionSigned,
        "hail.managed-transfer-address-selection", ownerRecoveryKey);
      const reservation = await verifyManagedProviderHandshake(reservationSigned,
        "hail.managed-transfer-reservation", row.messaging_public_key);
      const prepared: PreparedTargetKeys = { did: row.did, transferId, destinationServiceBase: row.destination_service_base,
        rotationPublicKey: row.rotation_public_key, messagingPublicKey: row.messaging_public_key,
        custodyProfile: "managed", identityPublicKey: row.identity_public_key };
      const now = this.now();
      const grantDigest = managedHandshakeDigest(grantSigned.payloadBytes);
      const acknowledgementDigest = managedHandshakeDigest(acknowledgementSigned.payloadBytes);
      const offerDigest = managedHandshakeDigest(offerSigned.payloadBytes);
      const selectionDigest = managedHandshakeDigest(selectionSigned.payloadBytes);
      if (state.serviceBase !== grant.source_service_base || state.identityDidKey !== grant.source_identity_key ||
        grant.did !== row.did || grant.destination_service_base !== prepared.destinationServiceBase ||
        acknowledgement.did !== grant.did || acknowledgement.nonce !== grant.nonce ||
        !same(acknowledgement.grant_digest, grantDigest) || offer.did !== grant.did || offer.nonce !== grant.nonce ||
        offer.transfer_id !== transferId || !same(offer.grant_digest, grantDigest) ||
        !same(offer.acknowledgement_digest, acknowledgementDigest) || selection.did !== grant.did ||
        selection.nonce !== grant.nonce || selection.transfer_id !== transferId ||
        !same(selection.grant_digest, grantDigest) || !same(selection.offer_digest, offerDigest) ||
        reservation.did !== grant.did || reservation.nonce !== grant.nonce || reservation.transfer_id !== transferId ||
        reservation.address !== selection.address || !same(reservation.offer_digest, offerDigest) ||
        !same(reservation.selection_digest, selectionDigest) || reservation.destination_rotation_key !== prepared.rotationPublicKey ||
        reservation.destination_identity_key !== prepared.identityPublicKey ||
        reservation.destination_messaging_key !== prepared.messagingPublicKey ||
        [grant, acknowledgement, offer, selection, reservation].some((value) => value.expires_at <= now)) {
        throw new Error("Managed fence artifacts do not form one current exact chain");
      }
      let requestSigned: SignedManagedHandshake;
      if (row.final_request_bytes && row.final_request_signature) {
        requestSigned = { payloadBytes: new Uint8Array(row.final_request_bytes),
          signature: new Uint8Array(row.final_request_signature) };
        const prior = await verifyManagedProviderHandshake(requestSigned,
          "hail.managed-transfer-fence-request", prepared.messagingPublicKey);
        if (prior.did !== row.did || prior.transfer_id !== transferId ||
          !same(prior.reservation_digest, managedHandshakeDigest(reservationSigned.payloadBytes))) {
          throw new Error("Stored managed fence request conflicts with its reservation");
        }
      } else {
        const request: ManagedTransferFenceRequest = { type: "hail.managed-transfer-fence-request", version: 1,
          did: row.did, nonce: grant.nonce, transfer_id: transferId, source_service_base: grant.source_service_base,
          destination_service_base: prepared.destinationServiceBase, destination_address: selection.address,
          owner_recovery_key: ownerRecoveryKey, source_identity_key: state.identityDidKey,
          destination_rotation_key: prepared.rotationPublicKey, destination_identity_key: prepared.identityPublicKey,
          destination_messaging_key: prepared.messagingPublicKey, grant_digest: grantDigest,
          acknowledgement_digest: acknowledgementDigest, offer_digest: offerDigest, selection_digest: selectionDigest,
          reservation_digest: managedHandshakeDigest(reservationSigned.payloadBytes), issued_at: now,
          expires_at: Math.min(now + 300, grant.expires_at, selection.expires_at, reservation.expires_at) };
        requestSigned = await this.target.signManagedArtifact(prepared, request);
        await tx`UPDATE received_transfer_invitations SET final_request_bytes=${requestSigned.payloadBytes},
          final_request_signature=${requestSigned.signature},final_submitted_at=clock_timestamp(),
          next_final_attempt_at=clock_timestamp()+interval '30 seconds'
          WHERE transfer_id=${transferId} AND final_request_bytes IS NULL`;
      }
      await tx`UPDATE transfer_address_reservations SET state='submitted'
        WHERE transfer_id=${transferId} AND state='selected'`;
      return { selectionSigned, reservationSigned, requestSigned, sourceServiceBase: grant.source_service_base };
    });
    const url = new URL(`${records.sourceServiceBase}/transfers/managed-requests`);
    await this.validateTarget(url);
    const body = finalRequestWire(records.selectionSigned, records.reservationSigned, records.requestSigned);
    if (body.length > MAX_TRANSFER_WIRE_BYTES) throw new Error("Managed fence request is too large");
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error("Managed fence request timed out")), 10_000);
    try {
      const response = await this.fetch(new Request(url, { method: "POST", body: Uint8Array.from(body),
        signal: controller.signal, redirect: "manual", headers: { "Content-Type": TRANSFER_MEDIA_TYPE,
          "Cache-Control": "no-store", "Accept-Encoding": "identity" } }));
      if (response.status !== 204 || response.body || response.headers.has("location") ||
        response.headers.has("content-encoding") || response.redirected) {
        await response.body?.cancel().catch(() => {});
        throw new Error("Source did not durably acknowledge the managed fence request");
      }
      await this.sql`UPDATE received_transfer_invitations
        SET final_acknowledged_at=COALESCE(final_acknowledged_at,clock_timestamp()),next_final_attempt_at=NULL
        WHERE transfer_id=${transferId} AND final_request_bytes=${records.requestSigned.payloadBytes}`;
    } finally { clearTimeout(timer); controller.abort(); }
  }
}
