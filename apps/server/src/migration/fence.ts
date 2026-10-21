import type { SQL } from "bun";
import { canonicalizeHailServiceBase, type HailDidResolver } from "../plc/resolver.js";
import { ed25519PublicKeyFromDidKey } from "../identity/did-key.js";
import { encodeDeterministic } from "@hailproto/codec";
import { verifyActivationReceipt, type SignedActivationReceipt } from "./activation-receipt.js";
import { decodeDeterministic } from "@hailproto/codec";
import { handshakeDigest, sameDigest, verifyHandshake, type SignedHandshake } from "./handshake.js";

export interface MigrationFence {
  did: string;
  accountId: string;
  transferId: string;
  destinationServiceBase: string;
  destinationRotationPublicKey: string;
  destinationMessagingPublicKey: string;
  state: "fenced" | "exported" | "retired";
  snapshotDigest: Uint8Array | null;
}

interface FenceRow {
  did: string;
  account_id: string;
  transfer_id: string;
  destination_service_base: string;
  destination_rotation_public_key: string | null;
  destination_messaging_public_key: string | null;
  state: MigrationFence["state"];
  snapshot_digest: Uint8Array | null;
}

function fromRow(row: FenceRow): MigrationFence {
  return { did: row.did, accountId: row.account_id, transferId: row.transfer_id,
    destinationServiceBase: row.destination_service_base,
    destinationRotationPublicKey: row.destination_rotation_public_key ?? "",
    destinationMessagingPublicKey: row.destination_messaging_public_key ?? "",
    state: row.state,
    snapshotDigest: row.snapshot_digest ? new Uint8Array(row.snapshot_digest) : null };
}

export class MigrationFenceService {
  constructor(
    private readonly sql: SQL,
    private readonly resolver: HailDidResolver,
    private readonly sourceServiceBase: string,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async begin(signedRequest: SignedHandshake, signedSelection: SignedHandshake,
    signedReservation: SignedHandshake): Promise<MigrationFence> {
    // Untrusted DID is used for lookup only; no fence is committed before all signatures check.
    const raw = decodeDeterministic(signedRequest.payloadBytes);
    if (!raw || typeof raw !== "object" || Array.isArray(raw) || !("did" in raw) ||
      typeof raw.did !== "string" || !/^did:plc:[a-z2-7]{24}$/.test(raw.did)) {
      throw new Error("Transfer request has no canonical DID");
    }
    const did = raw.did;
    const resolved = await this.resolver.resolve(did);
    if (resolved.did !== did || resolved.serviceBase !== this.sourceServiceBase) {
      throw new Error("Current PLC state does not authorize this provider as the source");
    }
    return this.sql.begin(async (tx) => {
      const accounts = await tx<{ id: string; onboarding_state: string; activation_verification_mode: string | null }[]>`
        SELECT id, onboarding_state, activation_verification_mode FROM provider_accounts
        WHERE did = ${did} FOR UPDATE
      `;
      const account = accounts[0];
      if (!account || account.onboarding_state !== "active" ||
        account.activation_verification_mode !== "public") {
        throw new Error("Migration source DID requires public activation");
      }
      const custody = await tx<{ user_recovery_public_key: string; user_identity_public_key: string }[]>`
        SELECT user_recovery_public_key, user_identity_public_key
        FROM portable_custody_evidence WHERE account_id = ${account.id}
      `;
      const evidence = custody[0];
      const data = resolved.evidence.data as { rotationKeys?: unknown };
      const rotationKeys: unknown[] | null = Array.isArray(data.rotationKeys) ? data.rotationKeys : null;
      const keys = await tx<{ role: string; public_key: string }[]>`
        SELECT role, public_key FROM account_keys WHERE account_id = ${account.id}
      `;
      if (!evidence || evidence.user_identity_public_key !== resolved.identityDidKey ||
        !rotationKeys || rotationKeys[0] !== evidence.user_recovery_public_key ||
        !keys.some((key) => key.role === "plc-rotation" && rotationKeys.slice(1).includes(key.public_key)) ||
        !keys.some((key) => key.role === "hail-messaging" && key.public_key === resolved.messagingDidKey) ||
        keys.some((key) => key.role === "hail-identity")) {
        throw new Error("Source does not satisfy portable custody");
      }
      const rows = await tx<{ nonce: string; destination_service_base: string; expires_at: Date;
        grant_bytes: Uint8Array; grant_signature: Uint8Array; invitation_bytes: Uint8Array;
        invitation_signature: Uint8Array; consumed_transfer_id: string | null;
        origin_request_bytes: Uint8Array | null; origin_request_signature: Uint8Array | null;
        origin_confirmed_at: Date | null; final_request_bytes: Uint8Array | null;
        final_request_signature: Uint8Array | null; cancelled_at: Date | null }[]>`
        SELECT nonce, destination_service_base, expires_at, grant_bytes, grant_signature,
          invitation_bytes, invitation_signature, consumed_transfer_id,
          origin_request_bytes, origin_request_signature, origin_confirmed_at,
          final_request_bytes, final_request_signature, cancelled_at
        FROM provider_transfer_authorizations WHERE did = ${did} FOR UPDATE`;
      const stored = rows[0];
      if (!stored || stored.cancelled_at || stored.expires_at.getTime() <= this.now().getTime()) {
        throw new Error("No valid user-authorized invitation for this DID");
      }
      const grant = await verifyHandshake({ payloadBytes: stored.grant_bytes, signature: stored.grant_signature },
        "hail.transfer-grant", resolved.identityDidKey);
      const invitation = await verifyHandshake({ payloadBytes: stored.invitation_bytes,
        signature: stored.invitation_signature }, "hail.transfer-invitation", resolved.messagingDidKey);
      if (!stored.origin_request_bytes || !stored.origin_request_signature || !stored.origin_confirmed_at) {
        throw new Error("Transfer request lacks an authenticated destination-origin offer");
      }
      const offeredRaw: unknown = decodeDeterministic(stored.origin_request_bytes);
      if (!offeredRaw || typeof offeredRaw !== "object" || !("destination_messaging_key" in offeredRaw) ||
        typeof offeredRaw.destination_messaging_key !== "string") throw new Error("Invalid origin offer");
      const offer = await verifyHandshake({ payloadBytes: stored.origin_request_bytes,
        signature: stored.origin_request_signature }, "hail.transfer-offer", offeredRaw.destination_messaging_key);
      const request = await verifyHandshake(signedRequest, "hail.transfer-request", offer.destination_messaging_key);
      const selection = await verifyHandshake(signedSelection, "hail.transfer-address-selection", resolved.identityDidKey);
      const reservation = await verifyHandshake(signedReservation, "hail.transfer-reservation",
        offer.destination_messaging_key);
      const destination = canonicalizeHailServiceBase(request.destination_service_base);
      const destinationRotationPublicKey = request.destination_rotation_key;
      const destinationMessagingPublicKey = request.destination_messaging_key;
      const transferId = request.transfer_id;
      const seconds = Math.floor(this.now().getTime() / 1000);
      if (stored.consumed_transfer_id && stored.consumed_transfer_id !== transferId ||
        grant.did !== did || grant.nonce !== stored.nonce || grant.source_service_base !== this.sourceServiceBase ||
        grant.destination_service_base !== destination || grant.expires_at !== Math.floor(stored.expires_at.getTime() / 1000) ||
        invitation.did !== did || invitation.nonce !== stored.nonce ||
        invitation.source_service_base !== this.sourceServiceBase || invitation.destination_service_base !== destination ||
        invitation.expires_at !== grant.expires_at ||
        !sameDigest(invitation.challenge, offer.invitation_challenge) ||
        !sameDigest(invitation.grant_digest, handshakeDigest(stored.grant_bytes)) ||
        offer.did !== did || offer.nonce !== grant.nonce || offer.transfer_id !== transferId ||
        offer.source_service_base !== this.sourceServiceBase ||
        offer.destination_service_base !== destination ||
        !sameDigest(offer.grant_digest, handshakeDigest(stored.grant_bytes)) ||
        !sameDigest(offer.invitation_digest, handshakeDigest(stored.invitation_bytes)) ||
        offer.destination_rotation_key !== request.destination_rotation_key ||
        offer.destination_messaging_key !== request.destination_messaging_key ||
        request.did !== did || request.nonce !== stored.nonce ||
        request.source_service_base !== this.sourceServiceBase || destination !== stored.destination_service_base ||
        !sameDigest(request.grant_digest, handshakeDigest(stored.grant_bytes)) ||
        !sameDigest(request.invitation_digest, handshakeDigest(stored.invitation_bytes)) ||
        !sameDigest(request.invitation_challenge, invitation.challenge) ||
        !sameDigest(request.offer_digest, handshakeDigest(stored.origin_request_bytes)) ||
        selection.did !== did || selection.nonce !== grant.nonce ||
        selection.transfer_id !== transferId ||
        !sameDigest(selection.grant_digest, handshakeDigest(stored.grant_bytes)) ||
        !sameDigest(selection.offer_digest, handshakeDigest(stored.origin_request_bytes)) ||
        selection.address.slice(selection.address.indexOf("@") + 1) !== grant.destination_domain ||
        request.destination_address !== selection.address ||
        !sameDigest(request.selection_digest, handshakeDigest(signedSelection.payloadBytes)) ||
        reservation.did !== did || reservation.nonce !== grant.nonce ||
        reservation.transfer_id !== transferId || reservation.address !== selection.address ||
        !sameDigest(reservation.offer_digest, handshakeDigest(stored.origin_request_bytes)) ||
        !sameDigest(reservation.selection_digest, handshakeDigest(signedSelection.payloadBytes)) ||
        !sameDigest(request.reservation_digest, handshakeDigest(signedReservation.payloadBytes)) ||
        selection.issued_at > seconds + 300 || selection.expires_at <= seconds ||
        reservation.expires_at <= seconds ||
        request.issued_at > seconds + 300 || request.expires_at <= seconds || request.expires_at > grant.expires_at) {
        throw new Error("Destination request does not accept the exact user-authorized invitation");
      }
      if (!/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/.test(transferId)) {
        throw new Error("Destination preparation requires a canonical transfer ID");
      }
      if (destination === this.sourceServiceBase) throw new Error("Migration destination must differ from the source");
      if (!destinationRotationPublicKey.startsWith("did:key:z") ||
        destinationRotationPublicKey === destinationMessagingPublicKey) {
        throw new Error("Destination provider must supply a distinct PLC rotation key");
      }
      await ed25519PublicKeyFromDidKey(destinationMessagingPublicKey);
      if (rotationKeys.includes(destinationRotationPublicKey) ||
        destinationMessagingPublicKey === resolved.messagingDidKey) {
        throw new Error("Source does not satisfy destination-key separation");
      }
      const existing = await tx<FenceRow[]>`
        SELECT did, account_id, transfer_id, destination_service_base,
          destination_rotation_public_key, destination_messaging_public_key, state, snapshot_digest
        FROM provider_migration_fences WHERE did = ${did}
      `;
      if (existing[0]) {
        if (existing[0].destination_service_base !== destination ||
          existing[0].destination_rotation_public_key !== destinationRotationPublicKey ||
          existing[0].destination_messaging_public_key !== destinationMessagingPublicKey ||
          existing[0].transfer_id !== transferId) {
          throw new Error("DID is already fenced for another destination");
        }
        if (!stored.final_request_bytes || !stored.final_request_signature ||
          !sameDigest(stored.final_request_bytes, signedRequest.payloadBytes) ||
          !sameDigest(stored.final_request_signature, signedRequest.signature)) {
          throw new Error("Fenced DID has another final transfer request");
        }
        return fromRow(existing[0]);
      }
      if (stored.consumed_transfer_id) throw new Error("Transfer grant was already consumed");
      await tx`UPDATE provider_transfer_authorizations SET consumed_transfer_id = ${transferId},
        final_request_bytes = ${signedRequest.payloadBytes},
        final_request_signature = ${signedRequest.signature},
        selection_bytes = ${signedSelection.payloadBytes},
        selection_signature = ${signedSelection.signature},
        reservation_bytes = ${signedReservation.payloadBytes},
        reservation_signature = ${signedReservation.signature}
        WHERE did = ${did} AND consumed_transfer_id IS NULL`;
      const inserted = await tx<FenceRow[]>`
        INSERT INTO provider_migration_fences
          (did, account_id, transfer_id, destination_service_base,
           destination_rotation_public_key, destination_messaging_public_key, state)
        VALUES (${did}, ${account.id}, ${transferId}, ${destination},
          ${destinationRotationPublicKey}, ${destinationMessagingPublicKey}, 'fenced')
        RETURNING did, account_id, transfer_id, destination_service_base,
          destination_rotation_public_key, destination_messaging_public_key, state, snapshot_digest
      `;
      return fromRow(inserted[0]!);
    });
  }

  async get(did: string): Promise<MigrationFence | null> {
    const rows = await this.sql<FenceRow[]>`
      SELECT did, account_id, transfer_id, destination_service_base,
        destination_rotation_public_key, destination_messaging_public_key, state, snapshot_digest
      FROM provider_migration_fences WHERE did = ${did}
    `;
    return rows[0] ? fromRow(rows[0]) : null;
  }

  async previouslyAccepted(request: SignedHandshake, selection: SignedHandshake,
    reservation: SignedHandshake): Promise<boolean> {
    if (request.payloadBytes.length > 4096) return false;
    const raw: unknown = decodeDeterministic(request.payloadBytes);
    if (!raw || typeof raw !== "object" || !("did" in raw) || typeof raw.did !== "string" ||
      !/^did:plc:[a-z2-7]{24}$/.test(raw.did)) return false;
    const rows = await this.sql<{ final_request_bytes: Uint8Array; final_request_signature: Uint8Array;
      selection_bytes: Uint8Array; selection_signature: Uint8Array;
      reservation_bytes: Uint8Array; reservation_signature: Uint8Array; state: string }[]>`
      SELECT a.final_request_bytes, a.final_request_signature, a.selection_bytes,
        a.selection_signature, a.reservation_bytes, a.reservation_signature, f.state
      FROM provider_transfer_authorizations a JOIN provider_migration_fences f
        ON f.did = a.did AND f.transfer_id = a.consumed_transfer_id
      WHERE a.did = ${raw.did}`;
    const saved = rows[0];
    return !!saved && ["fenced", "exported", "retired"].includes(saved.state) &&
      sameDigest(saved.final_request_bytes, request.payloadBytes) &&
      sameDigest(saved.final_request_signature, request.signature) &&
      sameDigest(saved.selection_bytes, selection.payloadBytes) &&
      sameDigest(saved.selection_signature, selection.signature) &&
      sameDigest(saved.reservation_bytes, reservation.payloadBytes) &&
      sameDigest(saved.reservation_signature, reservation.signature);
  }

  // A pre-export abort cannot have produced an acknowledged import. Once
  // exported, release requires invalidating the receiving side first.
  async releaseBeforeExport(did: string, transferId: string): Promise<void> {
    await this.sql.begin(async (tx) => {
      const rows = await tx<FenceRow[]>`
        SELECT did, account_id, transfer_id, destination_service_base,
          destination_rotation_public_key, destination_messaging_public_key, state, snapshot_digest
        FROM provider_migration_fences WHERE did = ${did} FOR UPDATE
      `;
      if (!rows[0] || rows[0].transfer_id !== transferId || rows[0].state !== "fenced") {
        throw new Error("Only an unexported matching migration fence can be released");
      }
      await tx`DELETE FROM provider_migration_fences WHERE did = ${did} AND transfer_id = ${transferId}`;
      await tx`DELETE FROM provider_transfer_authorizations
        WHERE did = ${did} AND consumed_transfer_id = ${transferId}`;
    });
  }

  async retire(did: string, transferId: string, signed: SignedActivationReceipt): Promise<void> {
    const resolved = await this.resolver.resolve(did);
    return this.sql.begin(async (tx) => {
      const fences = await tx<(FenceRow & { fenced_at: Date })[]>`
        SELECT did, account_id, transfer_id, destination_service_base,
          destination_rotation_public_key, destination_messaging_public_key,
          state, snapshot_digest, fenced_at
        FROM provider_migration_fences WHERE did = ${did} AND transfer_id = ${transferId} FOR UPDATE
      `;
      const fence = fences[0];
      if (!fence || !["exported", "retired"].includes(fence.state) || !fence.snapshot_digest ||
        resolved.did !== did || resolved.serviceBase !== fence.destination_service_base ||
        resolved.messagingDidKey !== fence.destination_messaging_public_key) {
        throw new Error("Old provider cannot retire before authenticated destination cutover");
      }
      const receipt = await verifyActivationReceipt(signed, resolved.messagingDidKey,
        Math.floor(this.now().getTime() / 1000));
      if (receipt.did !== did || receipt.transfer_id !== transferId ||
        receipt.destination_service_base !== fence.destination_service_base ||
        receipt.activated_at < Math.floor(fence.fenced_at.getTime() / 1000) ||
        !Buffer.from(receipt.snapshot_digest).equals(Buffer.from(fence.snapshot_digest))) {
        throw new Error("Destination activation receipt does not match the fenced snapshot");
      }
      const bytes = encodeDeterministic({ payload: signed.payloadBytes, signature: signed.signature });
      await tx`UPDATE account_api_credentials SET revoked_at=COALESCE(revoked_at,clock_timestamp())
        WHERE account_id=${fence.account_id}`;
      if (fence.state === "retired") {
        const saved = await tx<{ retirement_receipt_bytes: Uint8Array }[]>`
          SELECT retirement_receipt_bytes FROM provider_migration_fences
          WHERE did = ${did} AND transfer_id = ${transferId}`;
        if (!Buffer.from(saved[0]!.retirement_receipt_bytes).equals(Buffer.from(bytes))) {
          throw new Error("Retired transfer has another activation receipt");
        }
        return;
      }
      await tx`
        UPDATE provider_migration_fences SET state = 'retired', retirement_receipt_bytes = ${bytes},
          retired_at = clock_timestamp(), updated_at = clock_timestamp()
        WHERE did = ${did} AND transfer_id = ${transferId} AND state = 'exported'
      `;
    });
  }
}
