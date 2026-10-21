import { decodeDeterministic, encodeDeterministic, type HailValue } from "@hailproto/codec";
import { ed25519PublicKeyFromDidKey } from "../identity/did-key.js";
import { canonicalizeHailAddress } from "../identity/address.js";
import { canonicalizeHailServiceBase } from "../plc/resolver.js";

const CONTEXT = new TextEncoder().encode("hail.portable-migration-consent.v1\0");
const DID = /^did:plc:[a-z2-7]{24}$/;
const UUID = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/;

export interface PortableMigrationConsent {
  type: "hail.portable-migration-consent";
  version: 1;
  did: string;
  transfer_id: string;
  snapshot_digest: Uint8Array;
  plc_operation_sha256: Uint8Array;
  source_service_base: string;
  destination_service_base: string;
  destination_address: string;
  destination_rotation_key: string;
  destination_messaging_key: string;
  user_recovery_key: string;
  user_identity_key: string;
  created_at: number;
  expires_at: number;
}

export interface SignedPortableConsent {
  payloadBytes: Uint8Array;
  signature: Uint8Array;
}

function assertConsent(value: unknown): asserts value is PortableMigrationConsent {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid portable migration consent");
  const row = value as Record<string, unknown>;
  const fields = ["type", "version", "did", "transfer_id", "snapshot_digest", "plc_operation_sha256", "source_service_base",
    "destination_service_base", "destination_address", "destination_rotation_key", "destination_messaging_key",
    "user_recovery_key", "user_identity_key", "created_at", "expires_at"];
  if (Object.keys(row).length !== fields.length || fields.some((field) => !Object.hasOwn(row, field)) ||
    row.type !== "hail.portable-migration-consent" || row.version !== 1 ||
    typeof row.did !== "string" || !DID.test(row.did) || typeof row.transfer_id !== "string" ||
    !UUID.test(row.transfer_id) || !(row.snapshot_digest instanceof Uint8Array) ||
    row.snapshot_digest.length !== 32 || !(row.plc_operation_sha256 instanceof Uint8Array) ||
    row.plc_operation_sha256.length !== 32 || typeof row.source_service_base !== "string" ||
    typeof row.destination_service_base !== "string" ||
    typeof row.destination_address !== "string" ||
    canonicalizeHailAddress(row.destination_address) !== row.destination_address ||
    canonicalizeHailServiceBase(row.source_service_base) !== row.source_service_base ||
    canonicalizeHailServiceBase(row.destination_service_base) !== row.destination_service_base ||
    row.source_service_base === row.destination_service_base ||
    typeof row.destination_rotation_key !== "string" || !row.destination_rotation_key.startsWith("did:key:z") ||
    typeof row.destination_messaging_key !== "string" ||
    row.destination_messaging_key === row.user_identity_key ||
    typeof row.user_recovery_key !== "string" || !row.user_recovery_key.startsWith("did:key:z") ||
    typeof row.user_identity_key !== "string" ||
    typeof row.created_at !== "number" || !Number.isSafeInteger(row.created_at) ||
    typeof row.expires_at !== "number" || !Number.isSafeInteger(row.expires_at) ||
    row.expires_at <= row.created_at || row.expires_at - row.created_at > 604_800) {
    throw new Error("Invalid portable migration consent fields");
  }
}

function signatureInput(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  const message = new Uint8Array(CONTEXT.length + bytes.length);
  message.set(CONTEXT);
  message.set(bytes, CONTEXT.length);
  return message;
}

// Called by a user-controlled signer, not by the provider. No private key is
// accepted by a migration HTTP endpoint or persisted in provider account state.
export async function signPortableMigrationConsent(
  consent: PortableMigrationConsent, identityPrivateKey: CryptoKey,
): Promise<SignedPortableConsent> {
  assertConsent(consent);
  const payloadBytes = encodeDeterministic(consent as unknown as HailValue);
  const signature = new Uint8Array(await crypto.subtle.sign("Ed25519", identityPrivateKey, signatureInput(payloadBytes)));
  return { payloadBytes, signature };
}

export async function verifyPortableMigrationConsent(
  signed: SignedPortableConsent, identityPublicKey: string, nowSeconds: number,
): Promise<PortableMigrationConsent> {
  if (signed.payloadBytes.length < 1 || signed.payloadBytes.length > 16_384 || signed.signature.length !== 64) {
    throw new Error("Portable migration consent exceeds its representation limit");
  }
  const value: unknown = decodeDeterministic(signed.payloadBytes);
  assertConsent(value);
  if (!Buffer.from(encodeDeterministic(value as unknown as HailValue)).equals(Buffer.from(signed.payloadBytes)) ||
    value.user_identity_key !== identityPublicKey || value.created_at > nowSeconds + 300 ||
    nowSeconds > value.expires_at) throw new Error("Portable migration consent is stale or mismatched");
  await ed25519PublicKeyFromDidKey(value.destination_messaging_key);
  const key = await ed25519PublicKeyFromDidKey(identityPublicKey);
  if (!await crypto.subtle.verify("Ed25519", key, Uint8Array.from(signed.signature), signatureInput(signed.payloadBytes))) {
    throw new Error("Portable migration consent signature is invalid");
  }
  return value;
}
