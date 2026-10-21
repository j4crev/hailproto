import { def } from "@did-plc/lib";
import { decodeDeterministic } from "@hailproto/codec";
import type { SQL } from "bun";
import type { HailDidResolver } from "../plc/resolver.js";
import type { SignedActivationReceipt } from "./activation-receipt.js";
import { MigrationFenceService } from "./fence.js";
import { managedHandshakeDigest, verifyManagedOwnerHandshake, verifyManagedProviderHandshake,
  type SignedManagedHandshake } from "./managed-handshake.js";

const same = (a: Uint8Array, b: Uint8Array) => Buffer.from(a).equals(Buffer.from(b));

export interface ManagedMigrationFence {
  did: string; accountId: string; transferId: string; destinationServiceBase: string;
  ownerRecoveryPublicKey: string; sourceIdentityPublicKey: string; destinationIdentityPublicKey: string;
  destinationRotationPublicKey: string; destinationMessagingPublicKey: string; state: "fenced" | "exported" | "retired";
}

interface FenceRow {
  did: string; account_id: string; transfer_id: string; destination_service_base: string;
  owner_recovery_public_key: string | null; source_identity_public_key: string | null;
  destination_identity_public_key: string | null; destination_rotation_public_key: string | null;
  destination_messaging_public_key: string | null; state: ManagedMigrationFence["state"];
}

function fromRow(row: FenceRow): ManagedMigrationFence {
  if (!row.owner_recovery_public_key || !row.source_identity_public_key || !row.destination_identity_public_key ||
    !row.destination_rotation_public_key || !row.destination_messaging_public_key) {
    throw new Error("Managed migration fence is missing authority metadata");
  }
  return { did: row.did, accountId: row.account_id, transferId: row.transfer_id,
    destinationServiceBase: row.destination_service_base, ownerRecoveryPublicKey: row.owner_recovery_public_key,
    sourceIdentityPublicKey: row.source_identity_public_key,
    destinationIdentityPublicKey: row.destination_identity_public_key,
    destinationRotationPublicKey: row.destination_rotation_public_key,
    destinationMessagingPublicKey: row.destination_messaging_public_key, state: row.state };
}

export class ManagedMigrationFenceService {
  constructor(private readonly sql: SQL, private readonly resolver: HailDidResolver,
    private readonly sourceServiceBase: string, private readonly now = () => Math.floor(Date.now() / 1000),
    private readonly verificationMode:"strict-public-v1"|"poc-local"="strict-public-v1") {}

  async begin(requestSigned: SignedManagedHandshake, selectionSigned: SignedManagedHandshake,
    reservationSigned: SignedManagedHandshake): Promise<ManagedMigrationFence> {
    const raw = decodeDeterministic(requestSigned.payloadBytes) as Partial<{ did: string }>;
    if (!raw || typeof raw.did !== "string" || !/^did:plc:[a-z2-7]{24}$/.test(raw.did)) {
      throw new Error("Managed fence request has no canonical DID");
    }
    const did = raw.did;
    const resolved = await this.resolver.resolve(did);
    const plc = def.documentData.parse(resolved.evidence.data);
    const ownerRecoveryKey = plc.rotationKeys[0];
    if (!ownerRecoveryKey || resolved.evidence.verification?.profile!==this.verificationMode || resolved.did !== did ||
      resolved.serviceBase !== this.sourceServiceBase) {
      throw new Error("Managed fence requires strict current source authority");
    }
    return this.sql.begin(async (tx) => {
      const account = (await tx<{ id: string; onboarding_state: string; activation_verification_mode: string | null;
        owner_recovery_public_key: string; provider_identity_public_key: string; verification_mode: string }[]>`
        SELECT account.id,account.onboarding_state,account.activation_verification_mode,
          managed.owner_recovery_public_key,managed.provider_identity_public_key,managed.verification_mode
        FROM provider_accounts account JOIN managed_custody_evidence managed ON managed.account_id=account.id
        WHERE account.did=${did} FOR UPDATE OF account`)[0];
      const held = account ? await tx<{ role: string; public_key: string }[]>`
        SELECT role,public_key FROM account_keys WHERE account_id=${account.id}` : [];
      if (!account || account.onboarding_state !== "active" || account.activation_verification_mode !== "public" ||
        account.owner_recovery_public_key !== ownerRecoveryKey ||
        account.provider_identity_public_key !== resolved.identityDidKey ||
        account.verification_mode !== this.verificationMode ||
        !held.some((key) => key.role === "hail-identity" && key.public_key === resolved.identityDidKey) ||
        !held.some((key) => key.role === "hail-messaging" && key.public_key === resolved.messagingDidKey) ||
        !held.some((key) => key.role === "plc-rotation" && plc.rotationKeys.slice(1).includes(key.public_key))) {
        throw new Error("Source does not hold strict managed custody");
      }
      if ((await tx`SELECT 1 FROM serving_worker_leases WHERE account_id=${account.id} LIMIT 1`).length) {
        throw new Error("Managed source workers must drain before fencing");
      }
      const unacknowledged = await tx`SELECT 1 FROM grant_lineages lineage
        LEFT JOIN grant_publications publication ON publication.grant_id=lineage.grant_id
          AND publication.revision=lineage.current_revision
        WHERE lineage.local_account_id=${account.id} AND lineage.local_role='grantor'
          AND lineage.current_status='active' AND (publication.state IS DISTINCT FROM 'acknowledged'
            OR publication.acknowledged_etag IS NULL OR publication.acknowledged_at IS NULL) LIMIT 1`;
      if (unacknowledged.length) {
        throw new Error("Every active authoritative Grant needs an acknowledged predecessor before fencing");
      }
      const stored = (await tx<{ nonce: string; destination_service_base: string; expires_at: Date;
        custody_profile: "portable" | "managed"; owner_recovery_public_key: string | null;
        grant_bytes: Uint8Array; grant_signature: Uint8Array; invitation_bytes: Uint8Array;
        invitation_signature: Uint8Array; origin_request_bytes: Uint8Array | null;
        origin_request_signature: Uint8Array | null; origin_confirmed_at: Date | null;
        consumed_transfer_id: string | null; final_request_bytes: Uint8Array | null;
        final_request_signature: Uint8Array | null; selection_bytes: Uint8Array | null;
        selection_signature: Uint8Array | null; reservation_bytes: Uint8Array | null;
        reservation_signature: Uint8Array | null; cancelled_at: Date | null }[]>`
        SELECT nonce,destination_service_base,expires_at,custody_profile,owner_recovery_public_key,
          grant_bytes,grant_signature,invitation_bytes,invitation_signature,origin_request_bytes,
          origin_request_signature,origin_confirmed_at,consumed_transfer_id,final_request_bytes,
          final_request_signature,selection_bytes,selection_signature,reservation_bytes,reservation_signature,cancelled_at
        FROM provider_transfer_authorizations WHERE did=${did} FOR UPDATE`)[0];
      if (!stored || stored.custody_profile !== "managed" || stored.owner_recovery_public_key !== ownerRecoveryKey ||
        stored.cancelled_at || stored.expires_at.getTime() <= this.now() * 1000 ||
        !stored.origin_request_bytes || !stored.origin_request_signature || !stored.origin_confirmed_at) {
        throw new Error("No current managed transfer authorization and Offer");
      }
      const grantSigned = { payloadBytes: new Uint8Array(stored.grant_bytes),
        signature: new Uint8Array(stored.grant_signature) };
      const acknowledgementSigned = { payloadBytes: new Uint8Array(stored.invitation_bytes),
        signature: new Uint8Array(stored.invitation_signature) };
      const offerSigned = { payloadBytes: new Uint8Array(stored.origin_request_bytes),
        signature: new Uint8Array(stored.origin_request_signature) };
      const grant = await verifyManagedOwnerHandshake(grantSigned, "hail.managed-transfer-grant", ownerRecoveryKey);
      const acknowledgement = await verifyManagedProviderHandshake(acknowledgementSigned,
        "hail.managed-transfer-acknowledgement", resolved.messagingDidKey);
      const offeredRaw = decodeDeterministic(offerSigned.payloadBytes) as Partial<{ destination_messaging_key: string }>;
      if (!offeredRaw || typeof offeredRaw.destination_messaging_key !== "string") throw new Error("Managed Offer has no signer");
      const offer = await verifyManagedProviderHandshake(offerSigned,
        "hail.managed-transfer-offer", offeredRaw.destination_messaging_key);
      const selection = await verifyManagedOwnerHandshake(selectionSigned,
        "hail.managed-transfer-address-selection", ownerRecoveryKey);
      const reservation = await verifyManagedProviderHandshake(reservationSigned,
        "hail.managed-transfer-reservation", offer.destination_messaging_key);
      const request = await verifyManagedProviderHandshake(requestSigned,
        "hail.managed-transfer-fence-request", offer.destination_messaging_key);
      const now = this.now();
      const grantDigest = managedHandshakeDigest(grantSigned.payloadBytes);
      const acknowledgementDigest = managedHandshakeDigest(acknowledgementSigned.payloadBytes);
      const offerDigest = managedHandshakeDigest(offerSigned.payloadBytes);
      const selectionDigest = managedHandshakeDigest(selectionSigned.payloadBytes);
      const reservationDigest = managedHandshakeDigest(reservationSigned.payloadBytes);
      const destinationKeys = [offer.destination_rotation_key, offer.destination_identity_key,
        offer.destination_messaging_key];
      const currentSourceKeys = new Set([ownerRecoveryKey, resolved.identityDidKey,
        resolved.messagingDidKey, ...plc.rotationKeys]);
      if (stored.consumed_transfer_id && stored.consumed_transfer_id !== offer.transfer_id ||
        grant.did !== did || grant.nonce !== stored.nonce || grant.source_service_base !== this.sourceServiceBase ||
        grant.destination_service_base !== stored.destination_service_base ||
        grant.owner_recovery_key !== ownerRecoveryKey || grant.source_identity_key !== resolved.identityDidKey ||
        acknowledgement.did !== did || acknowledgement.nonce !== grant.nonce ||
        acknowledgement.source_service_base !== this.sourceServiceBase ||
        acknowledgement.destination_service_base !== grant.destination_service_base ||
        acknowledgement.source_messaging_key !== resolved.messagingDidKey ||
        !same(acknowledgement.grant_digest, grantDigest) || offer.did !== did || offer.nonce !== grant.nonce ||
        offer.source_service_base !== this.sourceServiceBase || offer.destination_service_base !== grant.destination_service_base ||
        !same(offer.grant_digest, grantDigest) || !same(offer.acknowledgement_digest, acknowledgementDigest) ||
        selection.did !== did || selection.nonce !== grant.nonce || selection.transfer_id !== offer.transfer_id ||
        !same(selection.grant_digest, grantDigest) || !same(selection.offer_digest, offerDigest) ||
        selection.address.slice(selection.address.indexOf("@") + 1) !== grant.destination_domain ||
        reservation.did !== did || reservation.nonce !== grant.nonce || reservation.transfer_id !== offer.transfer_id ||
        reservation.address !== selection.address || !same(reservation.offer_digest, offerDigest) ||
        !same(reservation.selection_digest, selectionDigest) ||
        reservation.destination_rotation_key !== offer.destination_rotation_key ||
        reservation.destination_identity_key !== offer.destination_identity_key ||
        reservation.destination_messaging_key !== offer.destination_messaging_key ||
        request.did !== did || request.nonce !== grant.nonce || request.transfer_id !== offer.transfer_id ||
        request.source_service_base !== this.sourceServiceBase ||
        request.destination_service_base !== grant.destination_service_base ||
        request.destination_address !== selection.address || request.owner_recovery_key !== ownerRecoveryKey ||
        request.source_identity_key !== resolved.identityDidKey ||
        request.destination_rotation_key !== offer.destination_rotation_key ||
        request.destination_identity_key !== offer.destination_identity_key ||
        request.destination_messaging_key !== offer.destination_messaging_key ||
        !same(request.grant_digest, grantDigest) || !same(request.acknowledgement_digest, acknowledgementDigest) ||
        !same(request.offer_digest, offerDigest) || !same(request.selection_digest, selectionDigest) ||
        !same(request.reservation_digest, reservationDigest) || destinationKeys.some((key) => currentSourceKeys.has(key)) ||
        [grant, acknowledgement, offer, selection, reservation, request].some((value) =>
          value.issued_at > now + 300 || value.expires_at <= now) || request.expires_at > grant.expires_at) {
        throw new Error("Managed fence request does not accept the exact current authority chain");
      }
      const existing = (await tx<FenceRow[]>`SELECT did,account_id,transfer_id,destination_service_base,
        owner_recovery_public_key,source_identity_public_key,destination_identity_public_key,
        destination_rotation_public_key,destination_messaging_public_key,state
        FROM provider_migration_fences WHERE did=${did}`)[0];
      if (existing) {
        if (existing.transfer_id !== request.transfer_id ||
          existing.destination_service_base !== request.destination_service_base ||
          existing.owner_recovery_public_key !== ownerRecoveryKey ||
          existing.source_identity_public_key !== resolved.identityDidKey ||
          existing.destination_identity_public_key !== request.destination_identity_key ||
          existing.destination_rotation_public_key !== request.destination_rotation_key ||
          existing.destination_messaging_public_key !== request.destination_messaging_key ||
          !stored.final_request_bytes || !stored.final_request_signature || !stored.selection_bytes ||
          !stored.selection_signature || !stored.reservation_bytes || !stored.reservation_signature ||
          !same(stored.final_request_bytes, requestSigned.payloadBytes) ||
          !same(stored.final_request_signature, requestSigned.signature) ||
          !same(stored.selection_bytes, selectionSigned.payloadBytes) ||
          !same(stored.selection_signature, selectionSigned.signature) ||
          !same(stored.reservation_bytes, reservationSigned.payloadBytes) ||
          !same(stored.reservation_signature, reservationSigned.signature)) {
          throw new Error("Managed DID is already fenced by another exact request");
        }
        return fromRow(existing);
      }
      if (stored.consumed_transfer_id) throw new Error("Managed transfer authorization was already consumed");
      await tx`UPDATE provider_transfer_authorizations SET consumed_transfer_id=${request.transfer_id},
        final_request_bytes=${requestSigned.payloadBytes},final_request_signature=${requestSigned.signature},
        selection_bytes=${selectionSigned.payloadBytes},selection_signature=${selectionSigned.signature},
        reservation_bytes=${reservationSigned.payloadBytes},reservation_signature=${reservationSigned.signature}
        WHERE did=${did} AND consumed_transfer_id IS NULL`;
      const inserted = await tx<FenceRow[]>`INSERT INTO provider_migration_fences
        (did,account_id,transfer_id,destination_service_base,destination_rotation_public_key,
          destination_messaging_public_key,state,source_custody_profile,owner_recovery_public_key,
          source_identity_public_key,destination_identity_public_key)
        VALUES (${did},${account.id},${request.transfer_id},${request.destination_service_base},
          ${request.destination_rotation_key},${request.destination_messaging_key},'fenced','managed',
          ${ownerRecoveryKey},${resolved.identityDidKey},${request.destination_identity_key})
        RETURNING did,account_id,transfer_id,destination_service_base,owner_recovery_public_key,
          source_identity_public_key,destination_identity_public_key,destination_rotation_public_key,
          destination_messaging_public_key,state`;
      return fromRow(inserted[0]!);
    });
  }

  async previouslyAccepted(request: SignedManagedHandshake, selection: SignedManagedHandshake,
    reservation: SignedManagedHandshake): Promise<boolean> {
    if (!request.payloadBytes.length || request.payloadBytes.length > 8192) return false;
    const raw = decodeDeterministic(request.payloadBytes) as Partial<{ did: string }>;
    if (!raw || typeof raw.did !== "string" || !/^did:plc:[a-z2-7]{24}$/.test(raw.did)) return false;
    const row = (await this.sql<{ final_request_bytes: Uint8Array; final_request_signature: Uint8Array;
      selection_bytes: Uint8Array; selection_signature: Uint8Array; reservation_bytes: Uint8Array;
      reservation_signature: Uint8Array; state: string; source_custody_profile: string }[]>`
      SELECT a.final_request_bytes,a.final_request_signature,a.selection_bytes,a.selection_signature,
        a.reservation_bytes,a.reservation_signature,f.state,f.source_custody_profile
      FROM provider_transfer_authorizations a JOIN provider_migration_fences f
        ON f.did=a.did AND f.transfer_id=a.consumed_transfer_id
      WHERE a.did=${raw.did}`)[0];
    return !!row && row.source_custody_profile === "managed" && ["fenced", "exported", "retired"].includes(row.state) &&
      same(row.final_request_bytes, request.payloadBytes) && same(row.final_request_signature, request.signature) &&
      same(row.selection_bytes, selection.payloadBytes) && same(row.selection_signature, selection.signature) &&
      same(row.reservation_bytes, reservation.payloadBytes) && same(row.reservation_signature, reservation.signature);
  }

  async get(did:string):Promise<ManagedMigrationFence|null> {
    const row=(await this.sql<FenceRow[]>`SELECT did,account_id,transfer_id,destination_service_base,
      owner_recovery_public_key,source_identity_public_key,destination_identity_public_key,
      destination_rotation_public_key,destination_messaging_public_key,state
      FROM provider_migration_fences WHERE did=${did}`)[0];
    return row?fromRow(row):null;
  }

  async retire(did:string,transferId:string,signed:SignedActivationReceipt):Promise<void> {
    await new MigrationFenceService(this.sql,this.resolver,this.sourceServiceBase,
      ()=>new Date(this.now()*1000)).retire(did,transferId,signed);
  }
}
