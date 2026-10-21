import { createHash } from "node:crypto";
import { verifySignature } from "@atproto/crypto";
import { decodeDeterministic, encodeDeterministic, type HailValue } from "@hailproto/codec";
import { canonicalizeHailAddress } from "../identity/address.js";
import { ed25519PublicKeyFromDidKey } from "../identity/did-key.js";
import { canonicalizeHailServiceBase } from "../plc/resolver.js";

const DID = /^did:plc:[a-z2-7]{24}$/;
const UUID = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/;
const MAX_AGE = 3600;

export interface SignedManagedHandshake { payloadBytes: Uint8Array; signature: Uint8Array }

export interface ManagedTransferGrant {
  type: "hail.managed-transfer-grant"; version: 1; did: string; nonce: string;
  source_service_base: string; destination_service_base: string; destination_domain: string;
  owner_recovery_key: string; source_identity_key: string; issued_at: number; expires_at: number;
}

export interface ManagedTransferAcknowledgement {
  type: "hail.managed-transfer-acknowledgement"; version: 1; did: string; nonce: string;
  source_service_base: string; destination_service_base: string; grant_digest: Uint8Array;
  source_messaging_key: string; issued_at: number; expires_at: number;
}

export interface ManagedTransferOffer {
  type: "hail.managed-transfer-offer"; version: 1; did: string; nonce: string; transfer_id: string;
  source_service_base: string; destination_service_base: string; grant_digest: Uint8Array;
  acknowledgement_digest: Uint8Array;
  destination_rotation_key: string; destination_identity_key: string; destination_messaging_key: string;
  issued_at: number; expires_at: number;
}

export interface ManagedTransferAddressSelection {
  type: "hail.managed-transfer-address-selection"; version: 1; did: string; nonce: string; transfer_id: string;
  grant_digest: Uint8Array; offer_digest: Uint8Array; address: string; selection_nonce: string;
  issued_at: number; expires_at: number;
}

export interface ManagedTransferReservation {
  type: "hail.managed-transfer-reservation"; version: 1; did: string; nonce: string; transfer_id: string;
  offer_digest: Uint8Array; selection_digest: Uint8Array; address: string;
  destination_rotation_key: string; destination_identity_key: string; destination_messaging_key: string;
  issued_at: number; expires_at: number;
}

export interface ManagedTransferFenceRequest {
  type: "hail.managed-transfer-fence-request"; version: 1; did: string; nonce: string; transfer_id: string;
  source_service_base: string; destination_service_base: string; destination_address: string;
  owner_recovery_key: string; source_identity_key: string; destination_rotation_key: string;
  destination_identity_key: string; destination_messaging_key: string;
  grant_digest: Uint8Array; acknowledgement_digest: Uint8Array; offer_digest: Uint8Array;
  selection_digest: Uint8Array; reservation_digest: Uint8Array; issued_at: number; expires_at: number;
}

export interface ManagedTransferApproval {
  type: "hail.managed-transfer-approval"; version: 1; did: string; nonce: string; transfer_id: string;
  source_service_base: string; destination_service_base: string; destination_address: string;
  owner_recovery_key: string; source_identity_key: string; destination_rotation_key: string;
  destination_identity_key: string; destination_messaging_key: string;
  grant_digest: Uint8Array; offer_digest: Uint8Array; selection_digest: Uint8Array;
  snapshot_version: 4; snapshot_digest: Uint8Array; history_checkpoint_digest: Uint8Array;
  source_generation: number; previous_operation_cid: string; operation_cid: string;
  issued_at: number; expires_at: number;
}

type ManagedHandshake = ManagedTransferGrant | ManagedTransferAcknowledgement | ManagedTransferOffer |
  ManagedTransferAddressSelection | ManagedTransferReservation | ManagedTransferFenceRequest | ManagedTransferApproval;
export type ManagedHandshakeKind = ManagedHandshake["type"];

const fields: Record<ManagedHandshakeKind, string[]> = {
  "hail.managed-transfer-grant": ["type", "version", "did", "nonce", "source_service_base",
    "destination_service_base", "destination_domain", "owner_recovery_key", "source_identity_key", "issued_at", "expires_at"],
  "hail.managed-transfer-acknowledgement": ["type", "version", "did", "nonce", "source_service_base",
    "destination_service_base", "grant_digest", "source_messaging_key", "issued_at", "expires_at"],
  "hail.managed-transfer-offer": ["type", "version", "did", "nonce", "transfer_id", "source_service_base",
    "destination_service_base", "grant_digest", "acknowledgement_digest", "destination_rotation_key", "destination_identity_key",
    "destination_messaging_key", "issued_at", "expires_at"],
  "hail.managed-transfer-address-selection": ["type", "version", "did", "nonce", "transfer_id", "grant_digest",
    "offer_digest", "address", "selection_nonce", "issued_at", "expires_at"],
  "hail.managed-transfer-reservation": ["type", "version", "did", "nonce", "transfer_id", "offer_digest",
    "selection_digest", "address", "destination_rotation_key", "destination_identity_key",
    "destination_messaging_key", "issued_at", "expires_at"],
  "hail.managed-transfer-fence-request": ["type", "version", "did", "nonce", "transfer_id", "source_service_base",
    "destination_service_base", "destination_address", "owner_recovery_key", "source_identity_key",
    "destination_rotation_key", "destination_identity_key", "destination_messaging_key", "grant_digest",
    "acknowledgement_digest", "offer_digest", "selection_digest", "reservation_digest", "issued_at", "expires_at"],
  "hail.managed-transfer-approval": ["type", "version", "did", "nonce", "transfer_id", "source_service_base",
    "destination_service_base", "destination_address", "owner_recovery_key", "source_identity_key",
    "destination_rotation_key", "destination_identity_key", "destination_messaging_key", "grant_digest", "offer_digest",
    "selection_digest", "snapshot_version", "snapshot_digest", "history_checkpoint_digest", "source_generation",
    "previous_operation_cid", "operation_cid", "issued_at", "expires_at"],
};

function validBase(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try { return canonicalizeHailServiceBase(value) === value; } catch { return false; }
}
function digest(value: unknown): value is Uint8Array { return value instanceof Uint8Array && value.length === 32; }
function didKey(value: unknown): value is string { return typeof value === "string" && value.startsWith("did:key:z"); }
function serviceBaseForDomain(domain: string): string {
  if (typeof domain !== "string" || canonicalizeHailAddress(`a@${domain}`) !== `a@${domain}` ||
    domain.includes(":") || domain.includes("/")) throw new Error("Managed transfer destination domain is not canonical");
  return `https://${domain}/hail`;
}

function validate<K extends ManagedHandshakeKind>(value: unknown, kind: K): Extract<ManagedHandshake, {type: K}> {
  const expected = fields[kind];
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).length !== expected.length ||
    !expected.every((field) => Object.hasOwn(value, field))) throw new Error("Invalid managed transfer fields");
  const item = value as Record<string, unknown>;
  if (item.type !== kind || item.version !== 1 || typeof item.did !== "string" || !DID.test(item.did) ||
    typeof item.nonce !== "string" || !UUID.test(item.nonce) || !Number.isSafeInteger(item.issued_at) ||
    !Number.isSafeInteger(item.expires_at) || (item.expires_at as number) <= (item.issued_at as number) ||
    (item.expires_at as number) - (item.issued_at as number) > MAX_AGE) throw new Error("Invalid managed transfer identity or lifetime");
  if (kind !== "hail.managed-transfer-address-selection" && kind !== "hail.managed-transfer-reservation" &&
    (!validBase(item.source_service_base) || !validBase(item.destination_service_base) ||
      item.source_service_base === item.destination_service_base)) throw new Error("Invalid managed transfer providers");
  if (kind !== "hail.managed-transfer-grant" && kind !== "hail.managed-transfer-acknowledgement" &&
    (typeof item.transfer_id !== "string" || !UUID.test(item.transfer_id))) {
    throw new Error("Invalid managed transfer linkage");
  }
  if (["hail.managed-transfer-offer", "hail.managed-transfer-address-selection",
    "hail.managed-transfer-fence-request", "hail.managed-transfer-approval"].includes(kind) &&
    !digest(item.grant_digest)) throw new Error("Invalid managed transfer grant linkage");
  if (kind === "hail.managed-transfer-grant") {
    if (typeof item.destination_domain !== "string" ||
      serviceBaseForDomain(item.destination_domain) !== item.destination_service_base ||
      !didKey(item.owner_recovery_key) || !didKey(item.source_identity_key) ||
      item.owner_recovery_key === item.source_identity_key) throw new Error("Invalid managed transfer authority");
  }
  if (kind === "hail.managed-transfer-acknowledgement" &&
    (!digest(item.grant_digest) || !didKey(item.source_messaging_key))) {
    throw new Error("Invalid managed source acknowledgement");
  }
  if (kind === "hail.managed-transfer-offer") {
    const keys = [item.destination_rotation_key, item.destination_identity_key, item.destination_messaging_key];
    if (!digest(item.acknowledgement_digest) || !keys.every(didKey) || new Set(keys).size !== 3) {
      throw new Error("Managed destination roles must be distinct DID keys");
    }
  }
  if (kind === "hail.managed-transfer-address-selection") {
    if (!digest(item.offer_digest) || typeof item.selection_nonce !== "string" || !UUID.test(item.selection_nonce) ||
      typeof item.address !== "string" || canonicalizeHailAddress(item.address) !== item.address) {
      throw new Error("Invalid managed transfer address selection");
    }
  }
  if (kind === "hail.managed-transfer-reservation") {
    const keys = [item.destination_rotation_key, item.destination_identity_key, item.destination_messaging_key];
    if (!digest(item.offer_digest) || !digest(item.selection_digest) ||
      typeof item.address !== "string" || canonicalizeHailAddress(item.address) !== item.address ||
      !keys.every(didKey) || new Set(keys).size !== 3) {
      throw new Error("Invalid managed transfer reservation");
    }
  }
  if (kind === "hail.managed-transfer-fence-request") {
    const keys = [item.owner_recovery_key, item.source_identity_key, item.destination_rotation_key,
      item.destination_identity_key, item.destination_messaging_key];
    if (!keys.every(didKey) || new Set(keys).size !== keys.length || !digest(item.acknowledgement_digest) ||
      !digest(item.offer_digest) || !digest(item.selection_digest) || !digest(item.reservation_digest) ||
      typeof item.destination_address !== "string" ||
      canonicalizeHailAddress(item.destination_address) !== item.destination_address) {
      throw new Error("Invalid managed transfer fence request");
    }
  }
  if (kind === "hail.managed-transfer-approval") {
    const keys = [item.owner_recovery_key, item.source_identity_key, item.destination_rotation_key,
      item.destination_identity_key, item.destination_messaging_key];
    if (!keys.every(didKey) || new Set(keys).size !== keys.length || !digest(item.offer_digest) ||
      !digest(item.selection_digest) || item.snapshot_version !== 4 || !digest(item.snapshot_digest) ||
      !digest(item.history_checkpoint_digest) || !Number.isSafeInteger(item.source_generation) ||
      (item.source_generation as number) < 1 || typeof item.destination_address !== "string" ||
      canonicalizeHailAddress(item.destination_address) !== item.destination_address ||
      typeof item.previous_operation_cid !== "string" || !item.previous_operation_cid.length || item.previous_operation_cid.length > 128 ||
      typeof item.operation_cid !== "string" || !item.operation_cid.length || item.operation_cid.length > 128 ||
      item.previous_operation_cid === item.operation_cid) throw new Error("Invalid exact managed transfer approval");
  }
  return item as unknown as Extract<ManagedHandshake, {type: K}>;
}

export function managedHandshakeDigest(bytes: Uint8Array): Uint8Array {
  return new Uint8Array(createHash("sha256").update(bytes).digest());
}

export function managedHandshakeSignatureInput(kind: ManagedHandshakeKind, bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  const tag = new TextEncoder().encode(`${kind}.v1\0`);
  const result = new Uint8Array(tag.length + bytes.length); result.set(tag); result.set(bytes, tag.length); return result;
}

export function encodeManagedHandshake<T extends ManagedHandshake>(value: T): Uint8Array {
  validate(value, value.type);
  return encodeDeterministic(value as unknown as HailValue);
}

function decode<K extends ManagedHandshakeKind>(signed: SignedManagedHandshake, kind: K): Extract<ManagedHandshake, {type: K}> {
  if (!signed.payloadBytes.length || signed.payloadBytes.length > 8192 || signed.signature.length !== 64) {
    throw new Error("Managed transfer signature representation exceeds limit");
  }
  const value = validate(decodeDeterministic(signed.payloadBytes), kind);
  if (!Buffer.from(encodeDeterministic(value as unknown as HailValue)).equals(Buffer.from(signed.payloadBytes))) {
    throw new Error("Managed transfer payload is not deterministic");
  }
  return value;
}

export async function verifyManagedOwnerHandshake<K extends "hail.managed-transfer-grant" |
  "hail.managed-transfer-address-selection" | "hail.managed-transfer-approval">(
  signed: SignedManagedHandshake, kind: K, ownerRecoveryKey: string,
): Promise<Extract<ManagedHandshake, {type: K}>> {
  const value = decode(signed, kind);
  if (("owner_recovery_key" in value && value.owner_recovery_key !== ownerRecoveryKey) ||
    !await verifySignature(ownerRecoveryKey, managedHandshakeSignatureInput(kind, signed.payloadBytes), signed.signature,
      { jwtAlg: "ES256" })) throw new Error("Managed transfer owner signature is invalid");
  return value;
}

export async function signManagedProviderHandshake<T extends ManagedTransferAcknowledgement | ManagedTransferOffer |
  ManagedTransferReservation | ManagedTransferFenceRequest>(value: T, privateKey: CryptoKey): Promise<SignedManagedHandshake> {
  const payloadBytes = encodeManagedHandshake(value);
  return { payloadBytes, signature: new Uint8Array(await crypto.subtle.sign("Ed25519", privateKey,
    managedHandshakeSignatureInput(value.type, payloadBytes))) };
}

export async function verifyManagedProviderHandshake<K extends "hail.managed-transfer-acknowledgement" | "hail.managed-transfer-offer" |
  "hail.managed-transfer-reservation" | "hail.managed-transfer-fence-request">(
  signed: SignedManagedHandshake, kind: K, publicKey: string,
): Promise<Extract<ManagedHandshake, {type: K}>> {
  const value = decode(signed, kind);
  const claimed = kind === "hail.managed-transfer-acknowledgement"
    ? (value as ManagedTransferAcknowledgement).source_messaging_key
    : (value as ManagedTransferOffer | ManagedTransferReservation | ManagedTransferFenceRequest).destination_messaging_key;
  if (claimed !== publicKey || !await crypto.subtle.verify("Ed25519",
    await ed25519PublicKeyFromDidKey(publicKey), Uint8Array.from(signed.signature),
    managedHandshakeSignatureInput(kind, signed.payloadBytes))) throw new Error("Managed transfer provider signature is invalid");
  return value;
}

export async function verifyManagedHandshakeChain(
  signed: { grant: SignedManagedHandshake; acknowledgement: SignedManagedHandshake; offer: SignedManagedHandshake;
    selection: SignedManagedHandshake; approval: SignedManagedHandshake },
  ownerRecoveryKey: string, now = Math.floor(Date.now() / 1000),
): Promise<{grant: ManagedTransferGrant; acknowledgement: ManagedTransferAcknowledgement; offer: ManagedTransferOffer;
  selection: ManagedTransferAddressSelection; approval: ManagedTransferApproval}> {
  const grant = await verifyManagedOwnerHandshake(signed.grant, "hail.managed-transfer-grant", ownerRecoveryKey);
  const rawAcknowledgement = decode(signed.acknowledgement, "hail.managed-transfer-acknowledgement");
  const acknowledgement = await verifyManagedProviderHandshake(signed.acknowledgement,
    "hail.managed-transfer-acknowledgement", rawAcknowledgement.source_messaging_key);
  const rawOffer = decode(signed.offer, "hail.managed-transfer-offer");
  const offer = await verifyManagedProviderHandshake(signed.offer, "hail.managed-transfer-offer", rawOffer.destination_messaging_key);
  const selection = await verifyManagedOwnerHandshake(signed.selection,
    "hail.managed-transfer-address-selection", ownerRecoveryKey);
  const approval = await verifyManagedOwnerHandshake(signed.approval,
    "hail.managed-transfer-approval", ownerRecoveryKey);
  const fresh = [grant, acknowledgement, offer, selection, approval].every((value) =>
    value.issued_at <= now + 300 && value.expires_at > now);
  const grantDigest = managedHandshakeDigest(signed.grant.payloadBytes);
  const acknowledgementDigest = managedHandshakeDigest(signed.acknowledgement.payloadBytes);
  const offerDigest = managedHandshakeDigest(signed.offer.payloadBytes);
  const selectionDigest = managedHandshakeDigest(signed.selection.payloadBytes);
  const same = (a: Uint8Array, b: Uint8Array) => Buffer.from(a).equals(Buffer.from(b));
  if (!fresh || acknowledgement.did !== grant.did || acknowledgement.nonce !== grant.nonce ||
    acknowledgement.source_service_base !== grant.source_service_base ||
    acknowledgement.destination_service_base !== grant.destination_service_base ||
    !same(acknowledgement.grant_digest, grantDigest) || offer.did !== grant.did || offer.nonce !== grant.nonce ||
    offer.source_service_base !== grant.source_service_base ||
    offer.destination_service_base !== grant.destination_service_base ||
    !same(offer.grant_digest, grantDigest) || !same(offer.acknowledgement_digest, acknowledgementDigest) ||
    selection.did !== grant.did || selection.nonce !== grant.nonce ||
    selection.transfer_id !== offer.transfer_id || !same(selection.grant_digest, grantDigest) ||
    !same(selection.offer_digest, offerDigest) || approval.did !== grant.did || approval.nonce !== grant.nonce ||
    approval.transfer_id !== offer.transfer_id || approval.source_service_base !== grant.source_service_base ||
    approval.destination_service_base !== grant.destination_service_base ||
    approval.destination_address !== selection.address || approval.owner_recovery_key !== grant.owner_recovery_key ||
    approval.source_identity_key !== grant.source_identity_key ||
    approval.destination_rotation_key !== offer.destination_rotation_key ||
    approval.destination_identity_key !== offer.destination_identity_key ||
    approval.destination_messaging_key !== offer.destination_messaging_key ||
    !same(approval.grant_digest, grantDigest) || !same(approval.offer_digest, offerDigest) ||
    !same(approval.selection_digest, selectionDigest)) {
    throw new Error("Managed transfer artifacts do not form one exact owner-approved chain");
  }
  return {grant, acknowledgement, offer, selection, approval};
}
