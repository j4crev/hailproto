import { decodeBase64Url, encodeBase64Url } from "@hailproto/codec";
import { parseJsonWithoutDuplicateKeys } from "../discovery/strict-json.js";
import type { SignedHandshake } from "./handshake.js";

export const TRANSFER_MEDIA_TYPE = "application/hail-transfer+json";
export const MAX_TRANSFER_WIRE_BYTES = 16_384;

export function encodeSignedRecord(signed: SignedHandshake): { payload: string; signature: string } {
  return { payload: encodeBase64Url(signed.payloadBytes), signature: encodeBase64Url(signed.signature) };
}
export function decodeSignedRecord(value: unknown): SignedHandshake {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
    Object.keys(value).length !== 2 || !("payload" in value) || !("signature" in value) ||
    typeof value.payload !== "string" || typeof value.signature !== "string") {
    throw new Error("Invalid signed transfer record");
  }
  const payloadBytes = decodeBase64Url(value.payload);
  const signature = decodeBase64Url(value.signature);
  if (payloadBytes.length < 1 || payloadBytes.length > 4096 || signature.length !== 64) {
    throw new Error("Signed transfer record exceeds its limit");
  }
  return { payloadBytes, signature };
}
export function invitationWire(grant: SignedHandshake, invitation: SignedHandshake): Uint8Array {
  return new TextEncoder().encode(JSON.stringify({ grant: encodeSignedRecord(grant),
    invitation: encodeSignedRecord(invitation) }));
}
export function parseInvitationWire(bytes: Uint8Array): { grant: SignedHandshake; invitation: SignedHandshake } {
  const row: unknown = parseWire(bytes);
  if (!row || typeof row !== "object" || Array.isArray(row) || Object.keys(row).length !== 2 ||
    !("grant" in row) || !("invitation" in row)) throw new Error("Invalid transfer invitation envelope");
  return { grant: decodeSignedRecord(row.grant), invitation: decodeSignedRecord(row.invitation) };
}
export function managedInvitationWire(grant: SignedHandshake, acknowledgement: SignedHandshake): Uint8Array {
  return new TextEncoder().encode(JSON.stringify({grant:encodeSignedRecord(grant),
    acknowledgement:encodeSignedRecord(acknowledgement)}));
}
export function parseManagedInvitationWire(bytes:Uint8Array):{grant:SignedHandshake;acknowledgement:SignedHandshake} {
  const row:unknown=parseWire(bytes);
  if(!row||typeof row!=="object"||Array.isArray(row)||Object.keys(row).length!==2||
    !("grant" in row)||!("acknowledgement" in row))throw new Error("Invalid managed transfer invitation envelope");
  return {grant:decodeSignedRecord(row.grant),acknowledgement:decodeSignedRecord(row.acknowledgement)};
}
export function requestWire(request: SignedHandshake): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(encodeSignedRecord(request)));
}
export function parseRequestWire(bytes: Uint8Array): SignedHandshake {
  return decodeSignedRecord(parseWire(bytes));
}
export function finalRequestWire(selection: SignedHandshake, reservation: SignedHandshake,
  request: SignedHandshake): Uint8Array {
  return new TextEncoder().encode(JSON.stringify({ selection: encodeSignedRecord(selection),
    reservation: encodeSignedRecord(reservation), request: encodeSignedRecord(request) }));
}
export function parseFinalRequestWire(bytes: Uint8Array): { selection: SignedHandshake;
  reservation: SignedHandshake; request: SignedHandshake } {
  const row: unknown = parseWire(bytes);
  if (!row || typeof row !== "object" || Array.isArray(row) || Object.keys(row).length !== 3 ||
    !("selection" in row) || !("reservation" in row) || !("request" in row)) {
    throw new Error("Invalid final transfer envelope");
  }
  return { selection: decodeSignedRecord(row.selection),
    reservation: decodeSignedRecord(row.reservation), request: decodeSignedRecord(row.request) };
}
export function cancellationWire(cancellation: SignedHandshake, receipt: SignedHandshake): Uint8Array {
  return new TextEncoder().encode(JSON.stringify({ cancellation: encodeSignedRecord(cancellation),
    receipt: encodeSignedRecord(receipt) }));
}
export function parseCancellationWire(bytes: Uint8Array): { cancellation: SignedHandshake;
  receipt: SignedHandshake } {
  const row: unknown = parseWire(bytes);
  if (!row || typeof row !== "object" || Array.isArray(row) || Object.keys(row).length !== 2 ||
    !("cancellation" in row) || !("receipt" in row)) {
    throw new Error("Invalid transfer cancellation envelope");
  }
  return { cancellation: decodeSignedRecord(row.cancellation), receipt: decodeSignedRecord(row.receipt) };
}
function parseWire(bytes: Uint8Array): unknown {
  if (!bytes.length || bytes.length > MAX_TRANSFER_WIRE_BYTES) throw new Error("Transfer wire payload exceeds limit");
  return parseJsonWithoutDuplicateKeys(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
}
export async function boundedTransferBody(body: ReadableStream<Uint8Array> | null,
  declared: string | null,maxBytes=MAX_TRANSFER_WIRE_BYTES): Promise<Uint8Array> {
  if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > maxBytes)) {
    throw new Error("Transfer HTTP body exceeds limit");
  }
  if (!body) throw new Error("Transfer HTTP body is missing");
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      total += value.length;
      if (total > maxBytes) throw new Error("Transfer HTTP body exceeds limit");
      chunks.push(value);
    }
  } catch (error) { await reader.cancel().catch(() => {}); throw error; }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  return bytes;
}
