import { createHash, randomBytes } from "node:crypto";
import { decodePayload, encodePayload, type HailSpt2Body, type HailSpt3Body, type HailSptBody } from "@hailproto/codec";

export const BODY_MEDIA_TYPE = "application/hail-body+cbor";
export const BODY_MAX_BYTES = 262_144;
const DID = /^did:plc:[a-z2-7]{24}$/;
const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export function bodyDigest(bytes: Uint8Array): Uint8Array {
  return createHash("sha256").update(bytes).digest();
}

export function bodyFromText(text: string): Uint8Array {
  const document: HailSptBody = {
    version: 1,
    profile: "spt-1",
    blocks: [{ _type: "block", style: "normal", children: [{ _type: "span", text, marks: [] }], markDefs: [] }],
  };
  const bytes=encodePayload("hail.body.spt-1",document);
  validateBodyBytes(bytes);
  return bytes;
}

export function bodyFromDocument(document: HailSpt2Body | HailSpt3Body): Uint8Array {
  const bytes = document.profile === "spt-2" ? encodePayload("hail.body.spt-2", document) : encodePayload("hail.body.spt-3", document);
  validateBodyBytes(bytes);
  return bytes;
}

export type BodyProfile = "spt-1" | "spt-2" | "spt-3";
export function validateBodyBytes(bytes: Uint8Array, expected?: BodyProfile): BodyProfile {
  if (bytes.length < 1 || bytes.length > BODY_MAX_BYTES) throw new Error("Body exceeds the 256 KiB limit");
  let profile:BodyProfile,encoded:Uint8Array;
  try { const document=decodePayload("hail.body.spt-1",bytes);profile="spt-1";encoded=encodePayload("hail.body.spt-1",document); }
  catch {
    try { const document=decodePayload("hail.body.spt-2",bytes);profile="spt-2";encoded=encodePayload("hail.body.spt-2",document); }
    catch { const document=decodePayload("hail.body.spt-3",bytes);profile="spt-3";encoded=encodePayload("hail.body.spt-3",document); }
  }
  if(expected&&profile!==expected)throw new Error("Body profile does not match its envelope");
  if (!Buffer.from(encoded).equals(Buffer.from(bytes))) {
    throw new Error("Body bytes are not deterministic CBOR");
  }
  return profile;
}

export interface StoredBody {
  bytes: Uint8Array;
  digest: Uint8Array;
}

export interface BodyStore {
  publish(senderDid: string, bytes: Uint8Array): Promise<StoredBody>;
  authorize(input: BodyAuthorizationInput): Promise<void>;
  retrieve(digest: Uint8Array, tokenHash: Uint8Array, now: number): Promise<StoredBody | "missing-body" | null>;
}

export interface BodyAuthorizationInput {
  senderDid: string;
  recipientDid: string;
  messageId: string;
  digest: Uint8Array;
  token: Uint8Array;
  availableUntil: number;
  expiresAt: number;
}

export function checkAuthorization(input: BodyAuthorizationInput, now = Math.floor(Date.now() / 1000)): void {
  if (!DID.test(input.senderDid) || !DID.test(input.recipientDid) || input.senderDid === input.recipientDid || !UUID_V7.test(input.messageId)) {
    throw new Error("Invalid body authorization parties or message ID");
  }
  if (input.digest.length !== 32 || input.token.length !== 32 ||
    !Number.isSafeInteger(input.availableUntil) || !Number.isSafeInteger(input.expiresAt) ||
    input.availableUntil < now + 30 * 86400 || input.expiresAt < input.availableUntil) {
    throw new Error("Invalid body authorization digest, token, or availability window");
  }
}

export function newBodyToken(): Uint8Array {
  return randomBytes(32);
}
