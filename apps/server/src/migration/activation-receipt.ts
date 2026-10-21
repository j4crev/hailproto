import { decodeDeterministic, encodeDeterministic, type HailValue } from "@hailproto/codec";
import { ed25519PublicKeyFromDidKey } from "../identity/did-key.js";

const CONTEXT = new TextEncoder().encode("hail.portable-migration-activated.v1\0");

export interface MigrationActivationReceipt {
  type: "hail.portable-migration-activated";
  version: 1;
  did: string;
  transfer_id: string;
  snapshot_digest: Uint8Array;
  destination_service_base: string;
  destination_messaging_key: string;
  destination_address: string;
  address_binding_digest: Uint8Array;
  activated_at: number;
}

export interface SignedActivationReceipt {
  payloadBytes: Uint8Array;
  signature: Uint8Array;
}

function assertReceipt(value: unknown): asserts value is MigrationActivationReceipt {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid activation receipt");
  const row = value as Record<string, unknown>;
  const fields = ["type", "version", "did", "transfer_id", "snapshot_digest",
    "destination_service_base", "destination_messaging_key", "destination_address",
    "address_binding_digest", "activated_at"];
  if (Object.keys(row).length !== fields.length || fields.some((name) => !Object.hasOwn(row, name)) ||
    row.type !== "hail.portable-migration-activated" || row.version !== 1 ||
    typeof row.did !== "string" || !/^did:plc:[a-z2-7]{24}$/.test(row.did) ||
    typeof row.transfer_id !== "string" || !/^[0-9a-f-]{36}$/.test(row.transfer_id) ||
    !(row.snapshot_digest instanceof Uint8Array) || row.snapshot_digest.length !== 32 ||
    typeof row.destination_service_base !== "string" || typeof row.destination_messaging_key !== "string" ||
    typeof row.destination_address !== "string" ||
    !(row.address_binding_digest instanceof Uint8Array) || row.address_binding_digest.length !== 32 ||
    typeof row.activated_at !== "number" || !Number.isSafeInteger(row.activated_at)) {
    throw new Error("Invalid activation receipt fields");
  }
}

function signatureInput(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  const result = new Uint8Array(CONTEXT.length + bytes.length);
  result.set(CONTEXT);
  result.set(bytes, CONTEXT.length);
  return result;
}

export async function signActivationReceipt(payload: MigrationActivationReceipt,
  destinationMessagingPrivateKey: CryptoKey): Promise<SignedActivationReceipt> {
  assertReceipt(payload);
  const payloadBytes = encodeDeterministic(payload as unknown as HailValue);
  return { payloadBytes, signature: new Uint8Array(await crypto.subtle.sign("Ed25519",
    destinationMessagingPrivateKey, signatureInput(payloadBytes))) };
}

export async function verifyActivationReceipt(signed: SignedActivationReceipt,
  currentMessagingDidKey: string, now: number): Promise<MigrationActivationReceipt> {
  if (signed.payloadBytes.length < 1 || signed.payloadBytes.length > 16_384 || signed.signature.length !== 64) {
    throw new Error("Activation receipt representation exceeds its limit");
  }
  const payload: unknown = decodeDeterministic(signed.payloadBytes);
  assertReceipt(payload);
  if (payload.destination_messaging_key !== currentMessagingDidKey || payload.activated_at > now + 300 ||
    !Buffer.from(encodeDeterministic(payload as unknown as HailValue)).equals(Buffer.from(signed.payloadBytes))) {
    throw new Error("Activation receipt does not match current destination authority");
  }
  if (!await crypto.subtle.verify("Ed25519", await ed25519PublicKeyFromDidKey(currentMessagingDidKey),
    Uint8Array.from(signed.signature), signatureInput(signed.payloadBytes))) {
    throw new Error("Activation receipt signature is invalid");
  }
  return payload;
}
