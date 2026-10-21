import { decodeDeterministic } from "@hailproto/codec";
import type { SQL } from "bun";
import type { KeyEncryptor } from "../identity/key-encryption.js";
import { importEd25519PrivateKey } from "../identity/keys.js";
import type { OnboardingRepository } from "../onboarding/repository.js";
import type { HailDidResolver } from "../plc/resolver.js";
import { handshakeDigest, sameDigest, signHandshake, verifyHandshake, type SignedHandshake,
  type TransferCancellationReceipt } from "./handshake.js";

export class TransferCancellationService {
  constructor(private readonly sql: SQL, private readonly resolver: HailDidResolver,
    private readonly sourceBase: string,
    private readonly accounts: Pick<OnboardingRepository, "getKey">,
    private readonly encryptor: KeyEncryptor) {}

  async cancel(signed: SignedHandshake): Promise<SignedHandshake> {
    if (signed.payloadBytes.length > 4096) throw new Error("Transfer cancellation exceeds limit");
    const raw: unknown = decodeDeterministic(signed.payloadBytes);
    if (!raw || typeof raw !== "object" || !("did" in raw) ||
      typeof raw.did !== "string" || !/^did:plc:[a-z2-7]{24}$/.test(raw.did)) {
      throw new Error("Invalid transfer cancellation DID");
    }
    const state = await this.resolver.resolve(raw.did);
    if (state.did !== raw.did || state.serviceBase !== this.sourceBase) {
      throw new Error("Only the current source can cancel a pending transfer");
    }
    const cancellation = await verifyHandshake(signed, "hail.transfer-cancellation", state.identityDidKey);
    const now = Math.floor(Date.now() / 1000);
    if (cancellation.issued_at > now + 300 || cancellation.expires_at <= now) {
      throw new Error("Transfer cancellation is stale");
    }
    const accounts = await this.sql<{ id: string }[]>`
      SELECT id FROM provider_accounts WHERE did = ${cancellation.did} AND onboarding_state = 'active'`;
    if (!accounts[0]) throw new Error("Source account is no longer active");
    const key = await this.accounts.getKey(accounts[0].id, "hail-messaging");
    if (key.publicKey !== state.messagingDidKey || key.algorithm !== "ed25519") {
      throw new Error("Source cancellation signer is no longer current");
    }
    const secret = await this.encryptor.decrypt(accounts[0].id, key.role, key.algorithm, key.publicKey, key);
    try {
      const privateKey = await importEd25519PrivateKey(secret);
      return await this.sql.begin(async (tx) => {
        await tx`SELECT id FROM provider_accounts WHERE did = ${cancellation.did} FOR UPDATE`;
        const rows = await tx<{ nonce: string; grant_bytes: Uint8Array; grant_signature: Uint8Array;
          invitation_bytes: Uint8Array; cancelled_at: Date | null;
          cancellation_bytes: Uint8Array | null; cancellation_signature: Uint8Array | null;
          cancellation_receipt_bytes: Uint8Array | null;
          cancellation_receipt_signature: Uint8Array | null; consumed_transfer_id: string | null }[]>`
          SELECT nonce, grant_bytes, grant_signature, invitation_bytes,
            cancelled_at, cancellation_bytes, cancellation_signature,
            cancellation_receipt_bytes, cancellation_receipt_signature, consumed_transfer_id
          FROM provider_transfer_authorizations WHERE did = ${cancellation.did} FOR UPDATE`;
        const stored = rows[0];
        if (!stored || stored.nonce !== cancellation.nonce ||
          !sameDigest(handshakeDigest(stored.grant_bytes), cancellation.grant_digest)) {
          throw new Error("Cancellation does not match a user-authorized grant");
        }
        await verifyHandshake({ payloadBytes: stored.grant_bytes,
          signature: stored.grant_signature }, "hail.transfer-grant", state.identityDidKey);
        if (stored.cancelled_at) {
          if (!stored.cancellation_bytes || !stored.cancellation_signature ||
            !stored.cancellation_receipt_bytes || !stored.cancellation_receipt_signature ||
            !sameDigest(stored.cancellation_bytes, signed.payloadBytes) ||
            !sameDigest(stored.cancellation_signature, signed.signature)) {
            throw new Error("Another cancellation was already recorded");
          }
          return { payloadBytes: new Uint8Array(stored.cancellation_receipt_bytes),
            signature: new Uint8Array(stored.cancellation_receipt_signature) };
        }
        const fence = await tx`SELECT 1 FROM provider_migration_fences WHERE did = ${cancellation.did}`;
        if (stored.consumed_transfer_id || fence.length) {
          throw new Error("Cancellation requires authenticated rollback after the source fence");
        }
        const grant = await verifyHandshake({ payloadBytes: stored.grant_bytes,
          signature: stored.grant_signature }, "hail.transfer-grant", state.identityDidKey);
        const receipt: TransferCancellationReceipt = {
          type: "hail.transfer-cancellation-receipt", version: 1,
          did: cancellation.did, nonce: cancellation.nonce,
          grant_digest: cancellation.grant_digest,
          invitation_digest: handshakeDigest(stored.invitation_bytes),
          destination_domain: grant.destination_domain,
          source_service_base: this.sourceBase,
          issued_at: now, expires_at: now + 7 * 86400,
        };
        const signedReceipt = await signHandshake(receipt, privateKey);
        await tx`UPDATE provider_transfer_authorizations SET cancelled_at = clock_timestamp(),
          cancellation_bytes = ${signed.payloadBytes}, cancellation_signature = ${signed.signature},
          cancellation_receipt_bytes = ${signedReceipt.payloadBytes},
          cancellation_receipt_signature = ${signedReceipt.signature}
          WHERE did = ${cancellation.did} AND cancelled_at IS NULL`;
        return signedReceipt;
      });
    } finally { secret.fill(0); }
  }
}
