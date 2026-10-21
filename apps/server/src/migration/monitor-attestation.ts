import { decodeDeterministic, encodeDeterministic, type HailValue } from "@hailproto/codec";
import { ed25519PublicKeyFromDidKey } from "../identity/did-key.js";
import { isIP } from "node:net";

const CONTEXT = new TextEncoder().encode("hail.independent-plc-monitor.v1\0");
const REVIEWED_CONTEXT = new TextEncoder().encode("hail.independent-plc-monitor.v2\0");
const DID_CONTEXT = new TextEncoder().encode("hail.independent-plc-monitor.v3\0");
const ONBOARDING_CONTEXT = new TextEncoder().encode("hail.independent-plc-onboarding-monitor.v1\0");
const DID_ONBOARDING_CONTEXT = new TextEncoder().encode("hail.independent-plc-onboarding-monitor.v2\0");

export interface PlcMonitorAttestation {
  type: "hail.plc-monitor-attestation";
  version: 1 | 2 | 3;
  did: string;
  transfer_id: string;
  operation_cid: string;
  monitor_origin: string;
  coverage_since: number;
  observed_at: number;
  bootstrap_cid?: string;
  bootstrap_state_digest?: string;
  export_sequence?: number;
}

export interface SignedMonitorAttestation {
  payloadBytes: Uint8Array;
  signature: Uint8Array;
}

export interface PlcOnboardingMonitorAttestation {
  type: "hail.plc-onboarding-monitor-attestation";
  version: 1 | 2;
  did: string;
  operation_cid: string;
  monitor_origin: string;
  coverage_since: number;
  observed_at: number;
  bootstrap_state_digest: string;
  export_sequence?: number;
}

function checked(value: unknown): asserts value is PlcMonitorAttestation {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid PLC monitor attestation");
  const row = value as Record<string, unknown>;
  const fields = ["type", "version", "did", "transfer_id", "operation_cid", "monitor_origin", "coverage_since", "observed_at"];
  if (row.version === 2) fields.push("bootstrap_cid", "bootstrap_state_digest", "export_sequence");
  if (row.version === 3) fields.push("bootstrap_cid", "bootstrap_state_digest");
  if (Object.keys(row).length !== fields.length || fields.some((field) => !Object.hasOwn(row, field)) ||
    row.type !== "hail.plc-monitor-attestation" || ![1, 2, 3].includes(row.version as number) ||
    typeof row.did !== "string" || !/^did:plc:[a-z2-7]{24}$/.test(row.did) ||
    typeof row.transfer_id !== "string" || !/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/.test(row.transfer_id) ||
    typeof row.operation_cid !== "string" || !/^b[a-z2-7]+$/.test(row.operation_cid) ||
    typeof row.monitor_origin !== "string" || typeof row.coverage_since !== "number" ||
    !Number.isSafeInteger(row.coverage_since) || typeof row.observed_at !== "number" ||
    !Number.isSafeInteger(row.observed_at) || row.coverage_since < 0 || row.observed_at < 0 || row.coverage_since > row.observed_at) {
    throw new Error("Invalid PLC monitor attestation fields");
  }
  if ((row.version === 2||row.version===3) && (typeof row.bootstrap_cid !== "string" || !/^b[a-z2-7]+$/.test(row.bootstrap_cid) ||
    typeof row.bootstrap_state_digest !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(row.bootstrap_state_digest) ||
    (row.version===2&&(!Number.isSafeInteger(row.export_sequence) || Number(row.export_sequence) < 1)))) {
    throw new Error("Invalid reviewed monitor bootstrap fields");
  }
  const url = new URL(row.monitor_origin);
  if (url.protocol !== "https:" || row.monitor_origin !== url.origin || url.username || url.password ||
    isIP(url.hostname) !== 0 || url.hostname.length > 253 ||
    url.hostname.split(".").some(label => label.length > 63 || !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label))) {
    throw new Error("Monitor origin must be canonical HTTPS");
  }
}

function signatureInput(bytes: Uint8Array, version: number): Uint8Array<ArrayBuffer> {
  const context = version===3?DID_CONTEXT:version === 2 ? REVIEWED_CONTEXT : CONTEXT;
  const result = new Uint8Array(context.length + bytes.length);
  result.set(context);
  result.set(bytes, context.length);
  return result;
}

function checkedOnboarding(value: unknown): asserts value is PlcOnboardingMonitorAttestation {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid onboarding monitor attestation");
  const row = value as Record<string, unknown>;
  const fields = ["type", "version", "did", "operation_cid", "monitor_origin", "coverage_since", "observed_at",
    "bootstrap_state_digest",...(row.version===1?["export_sequence"]:[])];
  if (Object.keys(row).length !== fields.length || fields.some(field => !Object.hasOwn(row, field)) ||
    row.type !== "hail.plc-onboarding-monitor-attestation" || ![1,2].includes(row.version as number) ||
    typeof row.did !== "string" || !/^did:plc:[a-z2-7]{24}$/.test(row.did) ||
    typeof row.operation_cid !== "string" || !/^b[a-z2-7]+$/.test(row.operation_cid) ||
    typeof row.monitor_origin !== "string" || typeof row.coverage_since !== "number" ||
    !Number.isSafeInteger(row.coverage_since) || row.coverage_since < 0 ||
    typeof row.observed_at !== "number" || !Number.isSafeInteger(row.observed_at) ||
    row.observed_at < row.coverage_since || typeof row.bootstrap_state_digest !== "string" ||
    !/^[A-Za-z0-9_-]{43}$/.test(row.bootstrap_state_digest) ||
    (row.version===1&&(!Number.isSafeInteger(row.export_sequence) || Number(row.export_sequence) < 1))) {
    throw new Error("Invalid onboarding monitor attestation fields");
  }
  const url = new URL(row.monitor_origin);
  if (url.protocol !== "https:" || row.monitor_origin !== url.origin || url.username || url.password ||
    isIP(url.hostname) !== 0 || url.hostname.length > 253 ||
    url.hostname.split(".").some(label => label.length > 63 || !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label))) {
    throw new Error("Monitor origin must be canonical HTTPS");
  }
}

// The independent monitor signs this outside the provider's administrative domain.
export async function signMonitorAttestation(payload: PlcMonitorAttestation, key: CryptoKey): Promise<SignedMonitorAttestation> {
  checked(payload);
  const payloadBytes = encodeDeterministic(payload as unknown as HailValue);
  return { payloadBytes, signature: new Uint8Array(await crypto.subtle.sign("Ed25519", key, signatureInput(payloadBytes, payload.version))) };
}

export async function verifyMonitorAttestation(signed: SignedMonitorAttestation,
  publicKey: string, now: number, maxAgeSeconds = 86_400): Promise<PlcMonitorAttestation> {
  if (!Number.isSafeInteger(now) || !Number.isSafeInteger(maxAgeSeconds) || maxAgeSeconds < 1 || maxAgeSeconds > 86_400) {
    throw new Error("Invalid monitor attestation freshness bounds");
  }
  if (signed.payloadBytes.length < 1 || signed.payloadBytes.length > 4096 || signed.signature.length !== 64) {
    throw new Error("Monitor attestation representation exceeds its limit");
  }
  const payload: unknown = decodeDeterministic(signed.payloadBytes);
  checked(payload);
  if (payload.observed_at > now + 300 || now - payload.observed_at > maxAgeSeconds ||
    !Buffer.from(encodeDeterministic(payload as unknown as HailValue)).equals(Buffer.from(signed.payloadBytes))) {
    throw new Error("Monitor attestation is stale or non-deterministic");
  }
  if (!await crypto.subtle.verify("Ed25519", await ed25519PublicKeyFromDidKey(publicKey),
    Uint8Array.from(signed.signature), signatureInput(signed.payloadBytes, payload.version))) {
    throw new Error("Monitor attestation signature is invalid");
  }
  return payload;
}

export async function signOnboardingMonitorAttestation(payload: PlcOnboardingMonitorAttestation,
  key: CryptoKey): Promise<SignedMonitorAttestation> {
  checkedOnboarding(payload);
  const payloadBytes = encodeDeterministic(payload as unknown as HailValue);
  const context=payload.version===2?DID_ONBOARDING_CONTEXT:ONBOARDING_CONTEXT;
  const input = new Uint8Array(context.length + payloadBytes.length);
  input.set(context); input.set(payloadBytes, context.length);
  return { payloadBytes, signature: new Uint8Array(await crypto.subtle.sign("Ed25519", key, input)) };
}

export async function verifyOnboardingMonitorAttestation(signed: SignedMonitorAttestation,
  publicKey: string, now: number, maxAgeSeconds = 300): Promise<PlcOnboardingMonitorAttestation> {
  if (!Number.isSafeInteger(now) || !Number.isSafeInteger(maxAgeSeconds) || maxAgeSeconds < 1 || maxAgeSeconds > 300 ||
    signed.payloadBytes.length < 1 || signed.payloadBytes.length > 4096 || signed.signature.length !== 64) {
    throw new Error("Invalid onboarding monitor attestation bounds");
  }
  const payload: unknown = decodeDeterministic(signed.payloadBytes);
  checkedOnboarding(payload);
  if (payload.observed_at > now + 300 || now - payload.observed_at > maxAgeSeconds ||
    !Buffer.from(encodeDeterministic(payload as unknown as HailValue)).equals(Buffer.from(signed.payloadBytes))) {
    throw new Error("Onboarding monitor attestation is stale or non-deterministic");
  }
  const context=payload.version===2?DID_ONBOARDING_CONTEXT:ONBOARDING_CONTEXT;
  const input = new Uint8Array(context.length + signed.payloadBytes.length);
  input.set(context); input.set(signed.payloadBytes, context.length);
  if (!await crypto.subtle.verify("Ed25519", await ed25519PublicKeyFromDidKey(publicKey),
    Uint8Array.from(signed.signature), input)) throw new Error("Onboarding monitor attestation signature is invalid");
  return payload;
}
