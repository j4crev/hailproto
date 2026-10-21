import { createHash, randomBytes } from "node:crypto";
import { decodeDeterministic, encodeDeterministic, type HailValue } from "@hailproto/codec";
import type { SQL } from "bun";
import { ed25519PublicKeyFromDidKey } from "../identity/did-key.js";
import { canonicalizeHailAddress } from "../identity/address.js";
import { canonicalizeHailServiceBase, type HailDidResolver } from "../plc/resolver.js";

const DID = /^did:plc:[a-z2-7]{24}$/;
const UUID = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/;
const MAX_AGE = 3600;
export interface SignedHandshake { payloadBytes: Uint8Array; signature: Uint8Array }
export interface TransferGrant {
  type: "hail.transfer-grant"; version: 1; did: string; nonce: string;
  source_service_base: string; destination_service_base: string; destination_domain: string;
  issued_at: number; expires_at: number;
}
export interface TransferInvitation {
  type: "hail.transfer-invitation"; version: 1; did: string; nonce: string;
  source_service_base: string; destination_service_base: string;
  grant_digest: Uint8Array; challenge: Uint8Array; expires_at: number;
}
export interface TransferOffer {
  type: "hail.transfer-offer"; version: 1; did: string; nonce: string;
  transfer_id: string; source_service_base: string; destination_service_base: string;
  grant_digest: Uint8Array; invitation_digest: Uint8Array;
  invitation_challenge: Uint8Array;
  destination_rotation_key: string; destination_messaging_key: string;
  issued_at: number; expires_at: number;
}
export interface TransferAddressSelection {
  type: "hail.transfer-address-selection"; version: 1; did: string; nonce: string;
  transfer_id: string; grant_digest: Uint8Array; offer_digest: Uint8Array;
  address: string; selection_nonce: string; issued_at: number; expires_at: number;
}
export interface TransferReservation {
  type: "hail.transfer-reservation"; version: 1; did: string; nonce: string;
  transfer_id: string; offer_digest: Uint8Array; selection_digest: Uint8Array;
  address: string; issued_at: number; expires_at: number;
}
export interface TransferRequest extends Omit<TransferOffer, "type"> {
  type: "hail.transfer-request"; offer_digest: Uint8Array;
  destination_address: string; selection_digest: Uint8Array; reservation_digest: Uint8Array;
}
export interface TransferCancellation {
  type: "hail.transfer-cancellation"; version: 1; did: string; nonce: string;
  grant_digest: Uint8Array; issued_at: number; expires_at: number;
}
export interface TransferCancellationReceipt {
  type: "hail.transfer-cancellation-receipt"; version: 1; did: string; nonce: string;
  grant_digest: Uint8Array; invitation_digest: Uint8Array;
  destination_domain: string; source_service_base: string;
  issued_at: number; expires_at: number;
}
type Handshake = TransferGrant | TransferInvitation | TransferOffer | TransferAddressSelection |
  TransferReservation | TransferRequest | TransferCancellation | TransferCancellationReceipt;
type Kind = Handshake["type"];

export function serviceBaseForProviderDomain(domain: string): string {
  if (typeof domain !== "string" || canonicalizeHailAddress(`a@${domain}`) !== `a@${domain}` ||
    domain.includes(":") || domain.includes("/")) throw new Error("Provider domain is not canonical");
  return `https://${domain}/hail`;
}

export function handshakeDigest(bytes: Uint8Array): Uint8Array {
  return new Uint8Array(createHash("sha256").update(bytes).digest());
}
function signatureInput(kind: Kind, bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  const context = new TextEncoder().encode(`${kind}.v1\0`);
  const result = new Uint8Array(context.length + bytes.length);
  result.set(context); result.set(bytes, context.length);
  return result;
}
function validBase(input: unknown): input is string {
  if (typeof input !== "string") return false;
  try { return canonicalizeHailServiceBase(input) === input; } catch { return false; }
}
function fields(value: unknown, names: string[]): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value) &&
    Object.keys(value).length === names.length && names.every((name) => Object.hasOwn(value, name));
}
function digest(value: unknown): value is Uint8Array {
  return value instanceof Uint8Array && value.length === 32;
}
function validate(value: unknown, kind: "hail.transfer-grant"): TransferGrant;
function validate(value: unknown, kind: "hail.transfer-invitation"): TransferInvitation;
function validate(value: unknown, kind: "hail.transfer-offer"): TransferOffer;
function validate(value: unknown, kind: "hail.transfer-address-selection"): TransferAddressSelection;
function validate(value: unknown, kind: "hail.transfer-reservation"): TransferReservation;
function validate(value: unknown, kind: "hail.transfer-request"): TransferRequest;
function validate(value: unknown, kind: "hail.transfer-cancellation"): TransferCancellation;
function validate(value: unknown, kind: "hail.transfer-cancellation-receipt"): TransferCancellationReceipt;
function validate(value: unknown, kind: Kind): Handshake {
  const common = ["type", "version", "did", "nonce", "source_service_base", "destination_service_base", "expires_at"];
  const extra = kind === "hail.transfer-grant" ? ["issued_at", "destination_domain"] :
    kind === "hail.transfer-invitation" ? ["grant_digest", "challenge"] :
    kind === "hail.transfer-cancellation" ? ["grant_digest", "issued_at"] :
    kind === "hail.transfer-cancellation-receipt" ?
      ["grant_digest", "invitation_digest", "destination_domain", "source_service_base", "issued_at"] :
    kind === "hail.transfer-address-selection" ? ["transfer_id", "grant_digest", "offer_digest", "address", "selection_nonce", "issued_at"] :
    kind === "hail.transfer-reservation" ? ["transfer_id", "offer_digest", "selection_digest", "address", "issued_at"] :
      ["transfer_id", "grant_digest", "invitation_digest", "invitation_challenge",
        "destination_rotation_key", "destination_messaging_key", "issued_at",
        ...(kind === "hail.transfer-request" ? ["offer_digest", "destination_address", "selection_digest", "reservation_digest"] : [])];
  const fieldsForKind = kind === "hail.transfer-address-selection" || kind === "hail.transfer-reservation" ||
    kind === "hail.transfer-cancellation" || kind === "hail.transfer-cancellation-receipt"
    ? ["type", "version", "did", "nonce", "expires_at", ...extra]
    : [...common, ...extra];
  if (!fields(value, fieldsForKind) || value.type !== kind || value.version !== 1 ||
    typeof value.did !== "string" || !DID.test(value.did) ||
    typeof value.nonce !== "string" || !UUID.test(value.nonce) ||
    (kind !== "hail.transfer-reservation" && kind !== "hail.transfer-address-selection" &&
      kind !== "hail.transfer-cancellation" && kind !== "hail.transfer-cancellation-receipt" &&
      (!validBase(value.source_service_base) || !validBase(value.destination_service_base) ||
       value.source_service_base === value.destination_service_base)) ||
    !Number.isSafeInteger(value.expires_at)) throw new Error("Invalid transfer handshake fields");
  if (kind !== "hail.transfer-invitation") {
    if (!Number.isSafeInteger(value.issued_at) || (value.expires_at as number) <= (value.issued_at as number) ||
      (value.expires_at as number) - (value.issued_at as number) >
        (kind === "hail.transfer-cancellation-receipt" ? 7 * 86400 : MAX_AGE)) {
      throw new Error("Transfer authorization must be short-lived");
    }
  }
  if (kind === "hail.transfer-grant" &&
    (typeof value.destination_domain !== "string" ||
      serviceBaseForProviderDomain(value.destination_domain) !== value.destination_service_base)) {
    throw new Error("Transfer grant does not match the destination provider domain");
  }
  if (kind !== "hail.transfer-grant" && kind !== "hail.transfer-reservation" &&
    !digest(value.grant_digest)) throw new Error("Missing grant digest");
  if (kind === "hail.transfer-invitation" && !digest(value.challenge)) throw new Error("Missing invitation challenge");
  if ((kind === "hail.transfer-offer" || kind === "hail.transfer-request") &&
    (typeof value.transfer_id !== "string" || !UUID.test(value.transfer_id) ||
      !digest(value.invitation_digest) || !digest(value.invitation_challenge) ||
      typeof value.destination_rotation_key !== "string" || !value.destination_rotation_key.startsWith("did:key:z") ||
      typeof value.destination_messaging_key !== "string" || !value.destination_messaging_key.startsWith("did:key:z") ||
      value.destination_rotation_key === value.destination_messaging_key)) {
    throw new Error("Invalid destination transfer request");
  }
  if (kind === "hail.transfer-address-selection" || kind === "hail.transfer-reservation") {
    if (typeof value.transfer_id !== "string" || !UUID.test(value.transfer_id) ||
      !digest(value.offer_digest) ||
      (kind === "hail.transfer-address-selection" && (!digest(value.grant_digest) ||
        typeof value.selection_nonce !== "string" || !UUID.test(value.selection_nonce))) ||
      (kind === "hail.transfer-reservation" && !digest(value.selection_digest)) ||
      typeof value.address !== "string" || canonicalizeHailAddress(value.address) !== value.address) {
      throw new Error("Invalid transfer address selection or reservation");
    }
  }
  if (kind === "hail.transfer-request" &&
    (!digest(value.offer_digest) || !digest(value.selection_digest) || !digest(value.reservation_digest) ||
      typeof value.destination_address !== "string" ||
      canonicalizeHailAddress(value.destination_address) !== value.destination_address)) {
    throw new Error("Final transfer request lacks the user-selected address");
  }
  if (kind === "hail.transfer-cancellation-receipt" &&
    (!digest(value.invitation_digest) || typeof value.destination_domain !== "string" ||
      !validBase(value.source_service_base) ||
      serviceBaseForProviderDomain(value.destination_domain) === value.source_service_base)) {
    throw new Error("Invalid source cancellation receipt");
  }
  return value as unknown as Handshake;
}
export async function signHandshake<T extends Handshake>(value: T, key: CryptoKey): Promise<SignedHandshake> {
  validate(value, value.type as "hail.transfer-grant");
  const payloadBytes = encodeDeterministic(value as unknown as HailValue);
  return { payloadBytes, signature: new Uint8Array(await crypto.subtle.sign("Ed25519", key,
    signatureInput(value.type, payloadBytes))) };
}
export async function verifyHandshake<K extends Kind>(signed: SignedHandshake, kind: K, publicKey: string):
  Promise<Extract<Handshake, { type: K }>> {
  if (signed.payloadBytes.length > 4096 || !signed.payloadBytes.length || signed.signature.length !== 64) {
    throw new Error("Transfer signature representation exceeds limit");
  }
  const value = validate(decodeDeterministic(signed.payloadBytes), kind as "hail.transfer-grant");
  if (value.type !== kind || !Buffer.from(encodeDeterministic(value as unknown as HailValue)).equals(Buffer.from(signed.payloadBytes)) ||
    !await crypto.subtle.verify("Ed25519", await ed25519PublicKeyFromDidKey(publicKey),
      Uint8Array.from(signed.signature), signatureInput(kind, signed.payloadBytes))) {
    throw new Error("Transfer handshake signature is invalid");
  }
  return value as Extract<Handshake, { type: K }>;
}
export function sameDigest(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && Buffer.from(a).equals(Buffer.from(b));
}

export class TransferInvitationService {
  constructor(private readonly sql: SQL, private readonly resolver: HailDidResolver,
    private readonly sourceBase: string, private readonly now = () => Math.floor(Date.now() / 1000)) {}

  // The source signs an acknowledgement, not a replacement for the user's grant.
  async issue(grantSigned: SignedHandshake, sourceMessagingPrivateKey: CryptoKey): Promise<SignedHandshake> {
    const raw: unknown = decodeDeterministic(grantSigned.payloadBytes);
    const grant = validate(raw, "hail.transfer-grant");
    const state = await this.resolver.resolve(grant.did);
    if (state.did !== grant.did || state.serviceBase !== this.sourceBase ||
      grant.source_service_base !== this.sourceBase ||
      grant.issued_at > this.now() + 300 || grant.expires_at <= this.now()) {
      throw new Error("Transfer grant source or lifetime is invalid");
    }
    await verifyHandshake(grantSigned, "hail.transfer-grant", state.identityDidKey);
    const invitation: TransferInvitation = { type: "hail.transfer-invitation", version: 1,
      did: grant.did, nonce: grant.nonce, source_service_base: grant.source_service_base,
      destination_service_base: grant.destination_service_base,
      grant_digest: handshakeDigest(grantSigned.payloadBytes),
      challenge: new Uint8Array(randomBytes(32)), expires_at: grant.expires_at };
    const signed = await signHandshake(invitation, sourceMessagingPrivateKey);
    await verifyHandshake(signed, "hail.transfer-invitation", state.messagingDidKey);
    return this.sql.begin(async (tx) => {
      const account = await tx<{ id: string }[]>`
        SELECT id FROM provider_accounts WHERE did = ${grant.did} AND onboarding_state = 'active'
          AND activation_verification_mode = 'public' FOR UPDATE`;
      if (!account[0]) throw new Error("Source has no active public account for transfer");
      const custody = await tx<{ user_identity_public_key: string }[]>`
        SELECT user_identity_public_key FROM portable_custody_evidence WHERE account_id = ${account[0].id}`;
      const heldKey = await tx`SELECT 1 FROM account_keys WHERE account_id = ${account[0].id} AND role = 'hail-identity'`;
      if (custody[0]?.user_identity_public_key !== state.identityDidKey || heldKey.length) {
        throw new Error("Transfer requires user-controlled identity custody");
      }
      const recorded = await tx<{ did: string }[]>`INSERT INTO provider_transfer_authorizations
        (did, nonce, destination_service_base, expires_at, grant_bytes, grant_signature,
         invitation_bytes, invitation_signature)
        VALUES (${grant.did}, ${grant.nonce}, ${grant.destination_service_base},
          ${new Date(grant.expires_at * 1000)}, ${grantSigned.payloadBytes}, ${grantSigned.signature},
          ${signed.payloadBytes}, ${signed.signature})
        ON CONFLICT (did) DO UPDATE SET nonce = EXCLUDED.nonce,
          destination_service_base = EXCLUDED.destination_service_base,
          expires_at = EXCLUDED.expires_at, grant_bytes = EXCLUDED.grant_bytes,
          grant_signature = EXCLUDED.grant_signature, invitation_bytes = EXCLUDED.invitation_bytes,
          invitation_signature = EXCLUDED.invitation_signature, custody_profile = 'portable',
          owner_recovery_public_key = NULL, created_at = clock_timestamp(),
          origin_request_bytes = NULL, origin_request_signature = NULL, origin_confirmed_at = NULL,
          invitation_attempts = 0, next_invitation_attempt_at = clock_timestamp(),
          invitation_lease_token = NULL, invitation_lease_expires_at = NULL,
          cancelled_at = NULL, cancellation_bytes = NULL, cancellation_signature = NULL,
          cancellation_receipt_bytes = NULL, cancellation_receipt_signature = NULL
        WHERE provider_transfer_authorizations.consumed_transfer_id IS NULL
          AND ((provider_transfer_authorizations.expires_at <= clock_timestamp()
              AND provider_transfer_authorizations.origin_confirmed_at IS NULL)
            OR provider_transfer_authorizations.cancelled_at IS NOT NULL)
          AND (provider_transfer_authorizations.grant_bytes <> EXCLUDED.grant_bytes
            OR provider_transfer_authorizations.grant_signature <> EXCLUDED.grant_signature)
        RETURNING did`;
      if (!recorded[0]) {
        const existing = await tx<{ grant_bytes: Uint8Array; grant_signature: Uint8Array;
          invitation_bytes: Uint8Array; invitation_signature: Uint8Array;
          expires_at: Date; cancelled_at: Date | null }[]>`
          SELECT grant_bytes, grant_signature, invitation_bytes, invitation_signature,
            expires_at, cancelled_at
          FROM provider_transfer_authorizations WHERE did = ${grant.did} FOR UPDATE`;
        const row = existing[0];
        if (!row || row.cancelled_at || row.expires_at.getTime() <= Date.now() ||
          !sameDigest(row.grant_bytes, grantSigned.payloadBytes) ||
          !sameDigest(row.grant_signature, grantSigned.signature)) {
          throw new Error("A different or unresolved transfer grant already exists for this DID");
        }
        const prior: SignedHandshake = { payloadBytes: new Uint8Array(row.invitation_bytes),
          signature: new Uint8Array(row.invitation_signature) };
        const parsed = await verifyHandshake(prior, "hail.transfer-invitation", state.messagingDidKey);
        if (parsed.did !== grant.did || parsed.nonce !== grant.nonce ||
          !sameDigest(parsed.grant_digest, handshakeDigest(grantSigned.payloadBytes))) {
          throw new Error("Stored transfer invitation conflicts with user grant");
        }
        return prior;
      }
      return signed;
    });
  }
}
