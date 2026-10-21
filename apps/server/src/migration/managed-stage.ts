import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { cidForCbor } from "@atproto/common";
import { assureValidSig, def, validateOperationLog, type DocumentData } from "@did-plc/lib";
import * as dagCbor from "@ipld/dag-cbor";
import { decodeBase64Url } from "@hailproto/codec";
import type { SQL } from "bun";
import { ed25519PublicKeyFromDidKey } from "../identity/did-key.js";
import type { HailDidResolver } from "../plc/resolver.js";
import { parseJsonWithoutDuplicateKeys } from "../discovery/strict-json.js";
import { managedHandshakeDigest, verifyManagedOwnerHandshake, verifyManagedProviderHandshake,
  type SignedManagedHandshake } from "./managed-handshake.js";
import { managedSnapshotSignatureInput, validateManagedTransferManifest,
  type SignedManagedTransferSnapshot } from "./managed-snapshot.js";
import { PreparedMigrationTarget, type PreparedTargetKeys } from "./target-keys.js";

const sha256 = (bytes: Uint8Array) => new Uint8Array(createHash("sha256").update(bytes).digest());
const same = (a: Uint8Array, b: Uint8Array) => Buffer.from(a).equals(Buffer.from(b));

interface DestinationRow {
  nonce: string; transfer_id: string; grant_bytes: Uint8Array; grant_signature: Uint8Array;
  invitation_bytes: Uint8Array; invitation_signature: Uint8Array; request_bytes: Uint8Array;
  request_signature: Uint8Array; destination_service_base: string; rotation_public_key: string;
  identity_public_key: string | null; messaging_public_key: string; custody_profile: "portable" | "managed";
  canonical_address: string; selection_bytes: Uint8Array; selection_signature: Uint8Array;
  receipt_bytes: Uint8Array; receipt_signature: Uint8Array; reservation_state: string;
}

export class ManagedMigrationStageService {
  constructor(private readonly sql: SQL, private readonly resolver: HailDidResolver,
    private readonly target: PreparedMigrationTarget, private readonly destinationServiceBase: string,
    private readonly now = () => Math.floor(Date.now() / 1000),
    private readonly verificationMode:"strict-public-v1"|"poc-local"="strict-public-v1") {}

  async stage(snapshot: SignedManagedTransferSnapshot, approvalSigned: SignedManagedHandshake,
    operationBytes: Uint8Array): Promise<ReturnType<typeof validateManagedTransferManifest>> {
    const snapshotDigest = sha256(snapshot.bytes);
    if (!same(snapshotDigest, snapshot.digest) || snapshot.signature.length !== 64) {
      throw new Error("Managed snapshot digest or signature is invalid");
    }
    const manifest = validateManagedTransferManifest(snapshot.bytes);
    if(manifest.tables.managed_custody_evidence[0]?.verification_mode!==this.verificationMode)
      throw new Error("Managed snapshot authority profile is not enabled here");
    if(this.verificationMode==="strict-public-v1"&&(!manifest.tables.plc_operation_evidence.length||
      manifest.tables.plc_operation_evidence.some(row=>row.registry_origin!=="https://plc.directory")))
      throw new Error("Public managed staging requires canonical registration evidence; private records cannot be relabeled");
    const retained=(await this.sql<{manifest_bytes:Uint8Array;manifest_digest:Uint8Array;signature:Uint8Array;
      source_messaging_public_key:string;user_consent_payload:Uint8Array;user_consent_signature:Uint8Array;
      signed_plc_operation_bytes:Uint8Array;state:string;custody_profile:string}[]>`
      SELECT manifest_bytes,manifest_digest,signature,source_messaging_public_key,user_consent_payload,
        user_consent_signature,signed_plc_operation_bytes,state,custody_profile FROM pending_migration_imports
      WHERE transfer_id=${manifest.transferId}`)[0];
    if(retained) {
      if(!["staged","active"].includes(retained.state)||retained.custody_profile!=="managed"||
        !same(retained.manifest_bytes,snapshot.bytes)||!same(retained.manifest_digest,snapshotDigest)||
        !same(retained.signature,snapshot.signature)||retained.source_messaging_public_key!==snapshot.sourceMessagingPublicKey||
        !same(retained.user_consent_payload,approvalSigned.payloadBytes)||!same(retained.user_consent_signature,approvalSigned.signature)||
        !same(retained.signed_plc_operation_bytes,operationBytes))throw new Error("Managed migration retry changed retained exact artifacts");
      return manifest;
    }
    if (manifest.destinationServiceBase !== this.destinationServiceBase) {
      throw new Error("Managed snapshot names another destination");
    }
    if (manifest.tables.account_keys.find((key) => key.role === "hail-messaging")?.public_key !==
      snapshot.sourceMessagingPublicKey) throw new Error("Managed snapshot signer differs from its retained messaging role");
    const resolved = await this.resolver.resolve(manifest.did);
    const plc = def.documentData.parse(resolved.evidence.data);
    if (resolved.evidence.verification?.profile !== this.verificationMode || resolved.did !== manifest.did ||
      resolved.serviceBase !== manifest.sourceServiceBase || resolved.identityDidKey !== manifest.sourceIdentityPublicKey ||
      plc.rotationKeys[0] !== manifest.ownerRecoveryPublicKey ||
      resolved.messagingDidKey !== snapshot.sourceMessagingPublicKey ||
      !await crypto.subtle.verify("Ed25519", await ed25519PublicKeyFromDidKey(snapshot.sourceMessagingPublicKey),
        Uint8Array.from(snapshot.signature), managedSnapshotSignatureInput(snapshotDigest))) {
      throw new Error("Current strict PLC state does not authenticate the managed snapshot");
    }
    const approval = await verifyManagedOwnerHandshake(approvalSigned,
      "hail.managed-transfer-approval", manifest.ownerRecoveryPublicKey);
    const seconds = this.now();
    if (approval.issued_at > seconds + 300 || approval.expires_at <= seconds) {
      throw new Error("Managed owner approval is stale");
    }
    const row = (await this.sql<DestinationRow[]>`SELECT received.nonce,received.transfer_id,
      received.grant_bytes,received.grant_signature,received.invitation_bytes,received.invitation_signature,
      received.request_bytes,received.request_signature,prepared.destination_service_base,
      prepared.rotation_public_key,prepared.identity_public_key,prepared.messaging_public_key,prepared.custody_profile,
      reservation.canonical_address,reservation.selection_bytes,reservation.selection_signature,
      reservation.receipt_bytes,reservation.receipt_signature,reservation.state AS reservation_state
      FROM received_transfer_invitations received JOIN prepared_migration_target_keys prepared
        ON prepared.transfer_id=received.transfer_id JOIN transfer_address_reservations reservation
        ON reservation.transfer_id=received.transfer_id WHERE received.transfer_id=${manifest.transferId}`)[0];
    if (!row || row.custody_profile !== "managed" || !row.identity_public_key || row.reservation_state !== "submitted") {
      throw new Error("Managed destination preparation and submitted reservation are required");
    }
    const prepared: PreparedTargetKeys = { did: manifest.did, transferId: manifest.transferId,
      destinationServiceBase: row.destination_service_base, rotationPublicKey: row.rotation_public_key,
      identityPublicKey: row.identity_public_key, messagingPublicKey: row.messaging_public_key,
      custodyProfile: "managed" };
    const grantSigned = { payloadBytes: new Uint8Array(row.grant_bytes), signature: new Uint8Array(row.grant_signature) };
    const acknowledgementSigned = { payloadBytes: new Uint8Array(row.invitation_bytes),
      signature: new Uint8Array(row.invitation_signature) };
    const offerSigned = { payloadBytes: new Uint8Array(row.request_bytes), signature: new Uint8Array(row.request_signature) };
    const selectionSigned = { payloadBytes: new Uint8Array(row.selection_bytes),
      signature: new Uint8Array(row.selection_signature) };
    const reservationSigned = { payloadBytes: new Uint8Array(row.receipt_bytes),
      signature: new Uint8Array(row.receipt_signature) };
    const grant = await verifyManagedOwnerHandshake(grantSigned, "hail.managed-transfer-grant", manifest.ownerRecoveryPublicKey);
    const acknowledgement = await verifyManagedProviderHandshake(acknowledgementSigned,
      "hail.managed-transfer-acknowledgement", resolved.messagingDidKey);
    const offer = await verifyManagedProviderHandshake(offerSigned,
      "hail.managed-transfer-offer", prepared.messagingPublicKey);
    const selection = await verifyManagedOwnerHandshake(selectionSigned,
      "hail.managed-transfer-address-selection", manifest.ownerRecoveryPublicKey);
    const reservation = await verifyManagedProviderHandshake(reservationSigned,
      "hail.managed-transfer-reservation", prepared.messagingPublicKey);
    const grantDigest = managedHandshakeDigest(grantSigned.payloadBytes);
    const acknowledgementDigest = managedHandshakeDigest(acknowledgementSigned.payloadBytes);
    const offerDigest = managedHandshakeDigest(offerSigned.payloadBytes);
    const selectionDigest = managedHandshakeDigest(selectionSigned.payloadBytes);
    if (grant.did !== manifest.did || grant.nonce !== row.nonce ||
      grant.source_service_base !== manifest.sourceServiceBase || grant.destination_service_base !== manifest.destinationServiceBase ||
      grant.owner_recovery_key !== manifest.ownerRecoveryPublicKey || grant.source_identity_key !== manifest.sourceIdentityPublicKey ||
      acknowledgement.did !== manifest.did || acknowledgement.nonce !== grant.nonce ||
      !same(acknowledgement.grant_digest, grantDigest) || offer.did !== manifest.did || offer.nonce !== grant.nonce ||
      offer.transfer_id !== manifest.transferId || !same(offer.grant_digest, grantDigest) ||
      !same(offer.acknowledgement_digest, acknowledgementDigest) ||
      offer.destination_rotation_key !== manifest.destinationRotationPublicKey ||
      offer.destination_identity_key !== manifest.destinationIdentityPublicKey ||
      offer.destination_messaging_key !== manifest.destinationMessagingPublicKey ||
      selection.did !== manifest.did || selection.nonce !== grant.nonce || selection.transfer_id !== manifest.transferId ||
      !same(selection.grant_digest, grantDigest) || !same(selection.offer_digest, offerDigest) ||
      selection.address !== row.canonical_address || reservation.did !== manifest.did ||
      reservation.transfer_id !== manifest.transferId || reservation.address !== selection.address ||
      !same(reservation.offer_digest, offerDigest) || !same(reservation.selection_digest, selectionDigest) ||
      approval.did !== manifest.did || approval.nonce !== grant.nonce || approval.transfer_id !== manifest.transferId ||
      approval.source_service_base !== manifest.sourceServiceBase ||
      approval.destination_service_base !== manifest.destinationServiceBase ||
      approval.destination_address !== selection.address || approval.owner_recovery_key !== manifest.ownerRecoveryPublicKey ||
      approval.source_identity_key !== manifest.sourceIdentityPublicKey ||
      approval.destination_rotation_key !== manifest.destinationRotationPublicKey ||
      approval.destination_identity_key !== manifest.destinationIdentityPublicKey ||
      approval.destination_messaging_key !== manifest.destinationMessagingPublicKey ||
      !same(approval.grant_digest, grantDigest) || !same(approval.offer_digest, offerDigest) ||
      !same(approval.selection_digest, selectionDigest) || approval.snapshot_version !== 4 ||
      !same(approval.snapshot_digest, snapshotDigest) ||
      !same(approval.history_checkpoint_digest, decodeBase64Url(manifest.historyCheckpointDigest)) ||
      approval.source_generation !== manifest.sourceGeneration) {
      throw new Error("Managed owner approval does not bind the exact snapshot and handshake");
    }
    const operationDigest = await this.validateOperation(operationBytes, manifest, approval.previous_operation_cid,
      approval.operation_cid, resolved.evidence.data as DocumentData, resolved.evidence.log);
    await this.target.assertOwnership(prepared);
    const destinationBinding = await this.target.createManagedDestinationBinding(prepared,
      approval.destination_address, approval.issued_at);
    const bindingDigest = sha256(destinationBinding);
    await this.sql.begin(async (tx) => {
      const locked = (await tx<DestinationRow[]>`SELECT received.nonce,received.transfer_id,
        received.grant_bytes,received.grant_signature,received.invitation_bytes,received.invitation_signature,
        received.request_bytes,received.request_signature,prepared.destination_service_base,
        prepared.rotation_public_key,prepared.identity_public_key,prepared.messaging_public_key,prepared.custody_profile,
        reservation.canonical_address,reservation.selection_bytes,reservation.selection_signature,
        reservation.receipt_bytes,reservation.receipt_signature,reservation.state AS reservation_state
        FROM received_transfer_invitations received JOIN prepared_migration_target_keys prepared
          ON prepared.transfer_id=received.transfer_id JOIN transfer_address_reservations reservation
          ON reservation.transfer_id=received.transfer_id WHERE received.transfer_id=${manifest.transferId}
        FOR UPDATE OF received,prepared,reservation`)[0];
      if (!locked || locked.custody_profile !== "managed" || locked.reservation_state !== "submitted" ||
        locked.identity_public_key !== manifest.destinationIdentityPublicKey ||
        locked.canonical_address !== approval.destination_address || !same(locked.selection_bytes, selectionSigned.payloadBytes) ||
        !same(locked.receipt_bytes, reservationSigned.payloadBytes)) {
        throw new Error("Managed destination preparation changed before staging");
      }
      const existing = (await tx<{ manifest_bytes: Uint8Array; manifest_digest: Uint8Array;
        user_consent_payload: Uint8Array | null; user_consent_signature: Uint8Array | null;
        signed_plc_operation_bytes: Uint8Array | null; destination_binding_cose: Uint8Array | null;
        state: string; custody_profile: string }[]>`SELECT manifest_bytes,manifest_digest,user_consent_payload,
          user_consent_signature,signed_plc_operation_bytes,destination_binding_cose,state,custody_profile
        FROM pending_migration_imports WHERE transfer_id=${manifest.transferId}`)[0];
      if (existing) {
        if (existing.state !== "staged" || existing.custody_profile !== "managed" ||
          !same(existing.manifest_bytes, snapshot.bytes) || !same(existing.manifest_digest, snapshotDigest) ||
          !existing.user_consent_payload || !same(existing.user_consent_payload, approvalSigned.payloadBytes) ||
          !existing.user_consent_signature || !same(existing.user_consent_signature, approvalSigned.signature) ||
          !existing.signed_plc_operation_bytes || !same(existing.signed_plc_operation_bytes, operationBytes) ||
          !existing.destination_binding_cose || !same(existing.destination_binding_cose, destinationBinding)) {
          throw new Error("Managed migration staging conflicts with retained exact artifacts");
        }
        return;
      }
      await tx`INSERT INTO pending_migration_imports(transfer_id,did,source_service_base,destination_service_base,
        manifest_bytes,manifest_digest,source_messaging_public_key,signature,state,verified_plc_document,
        verified_plc_data,verified_plc_operation_log,user_consent_payload,user_consent_signature,
        user_identity_public_key,signed_plc_operation_bytes,signed_plc_operation_digest,destination_address,
        destination_binding_cose,destination_binding_digest,custody_profile,owner_recovery_public_key,
        source_identity_public_key,destination_identity_public_key)
        VALUES (${manifest.transferId},${manifest.did},${manifest.sourceServiceBase},${manifest.destinationServiceBase},
          ${snapshot.bytes},${snapshotDigest},${snapshot.sourceMessagingPublicKey},${snapshot.signature},'staged',
          ${JSON.stringify(resolved.evidence.document)}::jsonb,${JSON.stringify(resolved.evidence.data)}::jsonb,
          ${JSON.stringify(resolved.evidence.log)}::jsonb,${approvalSigned.payloadBytes},${approvalSigned.signature},NULL,
          ${operationBytes},${operationDigest},${approval.destination_address},${destinationBinding},${bindingDigest},
          'managed',${manifest.ownerRecoveryPublicKey},${manifest.sourceIdentityPublicKey},${manifest.destinationIdentityPublicKey})`;
      await tx`UPDATE prepared_migration_target_keys SET state='staged'
        WHERE transfer_id=${manifest.transferId} AND state='prepared'`;
    });
    return manifest;
  }

  private async validateOperation(bytes: Uint8Array, manifest: ReturnType<typeof validateManagedTransferManifest>,
    previousCid: string, approvedCid: string, current: DocumentData, rawLog: readonly unknown[]): Promise<Uint8Array> {
    if (!bytes.length || bytes.length > 16_000) throw new Error("Managed cutover operation exceeds its limit");
    const operation = def.operation.parse(parseJsonWithoutDuplicateKeys(new TextDecoder("utf-8", { fatal: true }).decode(bytes)));
    const log = rawLog.map((value) => def.compatibleOpOrTombstone.parse(value));
    const last = log.at(-1);
    const actualPrevious = last ? (await cidForCbor(last)).toString() : null;
    const sourceRotation = manifest.tables.account_keys.find((key) => key.role === "plc-rotation")?.public_key;
    if (!last || actualPrevious !== previousCid || operation.prev !== previousCid ||
      current.rotationKeys[0] !== manifest.ownerRecoveryPublicKey || typeof sourceRotation !== "string" ||
      !current.rotationKeys.includes(sourceRotation) || current.rotationKeys.includes(manifest.destinationRotationPublicKey)) {
      throw new Error("Managed cutover predecessor or rotation authority is invalid");
    }
    const expectedRotations = [...current.rotationKeys.filter((key) => key !== sourceRotation),
      manifest.destinationRotationPublicKey];
    const expectedMethods = { ...current.verificationMethods,
      "hail-identity": manifest.destinationIdentityPublicKey,
      "hail-messaging": manifest.destinationMessagingPublicKey };
    const expectedServices = { ...current.services,
      hail: { type: "HailMessaging", endpoint: manifest.destinationServiceBase } };
    if (!isDeepStrictEqual(operation.rotationKeys, expectedRotations) ||
      !isDeepStrictEqual(operation.verificationMethods, expectedMethods) ||
      !isDeepStrictEqual(operation.services, expectedServices) ||
      !isDeepStrictEqual(operation.alsoKnownAs, current.alsoKnownAs)) {
      throw new Error("Managed cutover operation changes unapproved PLC state");
    }
    await assureValidSig([manifest.ownerRecoveryPublicKey], operation);
    const result = await validateOperationLog(manifest.did, [...log, operation]);
    if (!result || !isDeepStrictEqual(result.rotationKeys, expectedRotations) ||
      !isDeepStrictEqual(result.verificationMethods, expectedMethods) ||
      !isDeepStrictEqual(result.services, expectedServices) || !isDeepStrictEqual(result.alsoKnownAs, current.alsoKnownAs)) {
      throw new Error("Managed cutover operation does not validate to the exact destination state");
    }
    const cbor = new Uint8Array(dagCbor.encode(operation));
    if (cbor.length > 7_500 || (await cidForCbor(operation)).toString() !== approvedCid) {
      throw new Error("Managed owner approval names another cutover operation");
    }
    return sha256(cbor);
  }
}
