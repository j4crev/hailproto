import { decodeDeterministic } from "@hailproto/codec";
import type { SQL } from "bun";
import type { HailDidResolver } from "../plc/resolver.js";
import { handshakeDigest, sameDigest, verifyHandshake, type SignedHandshake } from "./handshake.js";

export class TransferCancellationReceiver {
  constructor(private readonly sql: SQL, private readonly resolver: HailDidResolver,
    private readonly destinationBase: string) {}

  async receive(signedCancel: SignedHandshake, signedReceipt: SignedHandshake): Promise<void> {
    if (signedCancel.payloadBytes.length > 4096 || signedReceipt.payloadBytes.length > 4096) {
      throw new Error("Cancellation evidence exceeds its limit");
    }
    const raw: unknown = decodeDeterministic(signedCancel.payloadBytes);
    if (!raw || typeof raw !== "object" || !("did" in raw) ||
      typeof raw.did !== "string" || !/^did:plc:[a-z2-7]{24}$/.test(raw.did)) {
      throw new Error("Invalid cancellation DID");
    }
    const state = await this.resolver.resolve(raw.did);
    const cancellation = await verifyHandshake(signedCancel, "hail.transfer-cancellation", state.identityDidKey);
    const receipt = await verifyHandshake(signedReceipt, "hail.transfer-cancellation-receipt",
      state.messagingDidKey);
    const now = Math.floor(Date.now() / 1000);
    if (state.did !== cancellation.did || receipt.did !== cancellation.did ||
      receipt.nonce !== cancellation.nonce ||
      receipt.source_service_base !== state.serviceBase ||
      receipt.destination_domain !== new URL(this.destinationBase).hostname ||
      receipt.issued_at > now + 300 || receipt.expires_at <= now ||
      !sameDigest(receipt.grant_digest, cancellation.grant_digest)) {
      throw new Error("Cancellation is not authenticated by the current source and user");
    }
    const receiptDigest = handshakeDigest(signedReceipt.payloadBytes);
    await this.sql.begin(async (tx) => {
      await tx`SELECT pg_advisory_xact_lock(684245102, hashtext(${cancellation.did}))`;
      const tombstones = await tx<{ grant_digest: Uint8Array; receipt_digest: Uint8Array }[]>`
        SELECT grant_digest, receipt_digest FROM cancelled_transfer_sessions
        WHERE did = ${cancellation.did} AND nonce = ${cancellation.nonce} FOR UPDATE`;
      if (tombstones[0]) {
        if (!sameDigest(tombstones[0].grant_digest, cancellation.grant_digest) ||
          !sameDigest(tombstones[0].receipt_digest, receiptDigest)) {
          throw new Error("Conflicting cancellation evidence");
        }
        return;
      }
      const rows = await tx<{ transfer_id: string; grant_digest: Uint8Array;
        invitation_digest: Uint8Array; grant_bytes: Uint8Array | null }[]>`
        SELECT transfer_id, grant_digest, invitation_digest, grant_bytes
        FROM received_transfer_invitations WHERE did = ${cancellation.did} FOR UPDATE`;
      const invited = rows[0];
      if (invited) {
        if (!sameDigest(invited.grant_digest, cancellation.grant_digest) ||
          !sameDigest(invited.invitation_digest, receipt.invitation_digest) || !invited.grant_bytes) {
          throw new Error("Cancellation does not match the pending invitation");
        }
        const imported = await tx`SELECT 1 FROM pending_migration_imports
          WHERE transfer_id = ${invited.transfer_id} AND state IN ('staged', 'active')`;
        const active = await tx`SELECT 1 FROM provider_accounts WHERE did = ${cancellation.did}`;
        const keys = await tx<{ state: string }[]>`
          SELECT state FROM prepared_migration_target_keys WHERE transfer_id = ${invited.transfer_id} FOR UPDATE`;
        if (imported.length || active.length || keys[0]?.state !== "prepared") {
          throw new Error("Target transfer has already advanced beyond reversible preparation");
        }
        const reservations = await tx<{ reserved_account_id: string | null }[]>`
          SELECT reserved_account_id FROM transfer_address_reservations
          WHERE transfer_id = ${invited.transfer_id} FOR UPDATE`;
        await tx`DELETE FROM transfer_address_reservations WHERE transfer_id = ${invited.transfer_id}`;
        if (reservations[0]?.reserved_account_id) {
          await tx`DELETE FROM provider_accounts WHERE id = ${reservations[0].reserved_account_id}
            AND did IS NULL AND onboarding_state = 'reserved'`;
        }
        await tx`DELETE FROM received_transfer_invitations WHERE transfer_id = ${invited.transfer_id}`;
        await tx`DELETE FROM prepared_migration_target_keys WHERE transfer_id = ${invited.transfer_id}
          AND state = 'prepared'`;
      }
      await tx`INSERT INTO cancelled_transfer_sessions (did, nonce, grant_digest, receipt_digest)
        VALUES (${cancellation.did}, ${cancellation.nonce}, ${cancellation.grant_digest}, ${receiptDigest})`;
    });
  }
}
