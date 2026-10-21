import { randomUUID } from "node:crypto";
import { inspectSignedPayload, type HailCancellationReason, type HailEnvelope, type HailFailureReason, type HailHoldReason } from "@hailproto/codec";
import type { SQL } from "bun";
import { bodyDigest, validateBodyBytes } from "../bodies/service.js";

export interface DeliveryClaim {
  senderDid: string;
  messageId: string;
  leaseToken: string;
  attemptCount: number;
  envelope: HailEnvelope;
}

interface ClaimRow {
  sender_did: string;
  message_id: string;
  envelope_cose: Uint8Array;
  attempt_count: number;
  lease_token: string;
}

export function deliveryDeadline(envelope: HailEnvelope): number {
  return Math.min(envelope.expires_at + 300, envelope.body.available_until, envelope.body.access.expires_at);
}

export class DeliveryRepository {
  constructor(private readonly sql: SQL) {}

  async claimDue(leaseSeconds = 60): Promise<DeliveryClaim | null> {
    const leaseToken = randomUUID();
    return this.sql.begin(async (tx) => {
      const rows = await tx<ClaimRow[]>`
        SELECT work.sender_did, work.message_id, work.attempt_count, received.envelope_cose
        FROM delivery_work work JOIN received_envelopes received
          ON received.sender_did = work.sender_did AND received.message_id = work.message_id
        WHERE work.state IN ('accepted', 'on-hold') AND work.next_attempt_at <= now()
          AND (work.lease_expires_at IS NULL OR work.lease_expires_at <= now())
          AND NOT EXISTS (SELECT 1 FROM provider_migration_fences fence
            WHERE fence.did = received.recipient_did)
        ORDER BY work.next_attempt_at, work.message_id
        FOR UPDATE OF work SKIP LOCKED LIMIT 1
      `;
      const row = rows[0];
      if (!row) return null;
      const envelope = inspectSignedPayload("hail.envelope", row.envelope_cose).payload;
      if (envelope.from !== row.sender_did || envelope.message_id !== row.message_id) {
        throw new Error("Persisted envelope does not match delivery work");
      }
      await tx`
        UPDATE delivery_work SET lease_token = ${leaseToken},
          lease_expires_at = now() + (${leaseSeconds} * interval '1 second'),
          attempt_count = attempt_count + 1
        WHERE sender_did = ${row.sender_did} AND message_id = ${row.message_id}
      `;
      return { senderDid: row.sender_did, messageId: row.message_id, leaseToken,
        attemptCount: row.attempt_count + 1, envelope };
    });
  }

  async deliver(claim: DeliveryClaim, bytes: Uint8Array): Promise<"delivered" | "expired" | "lost-lease"> {
    const envelope = claim.envelope;
    if (bytes.length !== envelope.body.size ||
      !Buffer.from(bodyDigest(bytes)).equals(Buffer.from(envelope.body.digest.value))) {
      throw new Error("Body does not match the accepted envelope");
    }
    validateBodyBytes(bytes);
    return this.sql.begin(async (tx) => {
      const current = await this.lockClaim(tx, claim);
      if (!current) return "lost-lease" as const;
      const now = await this.databaseSeconds(tx);
      if (now > deliveryDeadline(envelope)) {
        await this.finish(tx, claim, "failed", "delivery-expired");
        return "expired" as const;
      }
      await tx`
        INSERT INTO verified_body_provenance
          (recipient_did, sender_did, digest, media_type, profile, body_bytes)
        VALUES (${envelope.to}, ${envelope.from}, ${envelope.body.digest.value},
          ${envelope.body.media_type}, ${envelope.body.profile}, ${bytes})
        ON CONFLICT (recipient_did, sender_did, digest, media_type, profile)
        DO NOTHING
      `;
      const existing = await tx<{ body_bytes: Uint8Array }[]>`
        SELECT body_bytes FROM verified_body_provenance
        WHERE recipient_did = ${envelope.to} AND sender_did = ${envelope.from}
          AND digest = ${envelope.body.digest.value} AND media_type = ${envelope.body.media_type}
          AND profile = ${envelope.body.profile}
      `;
      if (!existing[0] || !Buffer.from(existing[0].body_bytes).equals(Buffer.from(bytes))) {
        throw new Error("Verified-body provenance conflicts with exact bytes");
      }
      if (await this.databaseSeconds(tx) > deliveryDeadline(envelope)) {
        await this.finish(tx, claim, "failed", "delivery-expired");
        return "expired" as const;
      }
      await tx`
        INSERT INTO delivered_messages (recipient_did, sender_did, message_id,
          envelope_digest, body_digest, media_type, profile)
        SELECT ${envelope.to}, ${envelope.from}, ${envelope.message_id}, received.envelope_digest,
          ${envelope.body.digest.value}, ${envelope.body.media_type}, ${envelope.body.profile}
        FROM received_envelopes received
        WHERE received.sender_did = ${envelope.from} AND received.message_id = ${envelope.message_id}
      `;
      await this.finish(tx, claim, "delivered", null);
      return "delivered" as const;
    });
  }

  async fail(claim: DeliveryClaim, reason: HailFailureReason): Promise<void> {
    await this.sql.begin(async (tx) => {
      if (!await this.lockClaim(tx, claim)) return;
      const now = await this.databaseSeconds(tx);
      await this.finish(tx, claim, "failed", now > deliveryDeadline(claim.envelope) ? "delivery-expired" : reason);
    });
  }

  async cancel(claim: DeliveryClaim, reason: HailCancellationReason): Promise<void> {
    await this.sql.begin(async (tx) => {
      if (!await this.lockClaim(tx, claim)) return;
      await this.finish(tx, claim, "cancelled", reason);
    });
  }

  async hold(claim: DeliveryClaim, reason: HailHoldReason, retryAt: Date): Promise<void> {
    await this.sql.begin(async (tx) => {
      if (!await this.lockClaim(tx, claim)) return;
      const now = await this.databaseSeconds(tx);
      if (now > deliveryDeadline(claim.envelope)) {
        await this.finish(tx, claim, "failed", "delivery-expired");
      } else {
        await tx`
          UPDATE delivery_work SET state = 'on-hold', reason = ${reason},
            status_revision = status_revision + 1, next_attempt_at = ${retryAt},
            lease_token = NULL, lease_expires_at = NULL, transitioned_at = clock_timestamp()
          WHERE sender_did = ${claim.senderDid} AND message_id = ${claim.messageId}
        `;
      }
    });
  }

  private async lockClaim(tx: SQL, claim: DeliveryClaim): Promise<boolean> {
    const rows = await tx<{ state: string }[]>`
      SELECT state FROM delivery_work WHERE sender_did = ${claim.senderDid}
        AND message_id = ${claim.messageId} AND lease_token = ${claim.leaseToken}
        AND state IN ('accepted', 'on-hold') FOR UPDATE
    `;
    return rows.length > 0;
  }

  private async databaseSeconds(tx: SQL): Promise<number> {
    const rows = await tx<{ instant: string | number }[]>`SELECT extract(epoch from clock_timestamp()) AS instant`;
    return Number(rows[0]!.instant);
  }

  private async finish(tx: SQL, claim: DeliveryClaim, state: "delivered" | "failed" | "cancelled", reason: string | null): Promise<void> {
    if (claim.envelope.authorization.type === "reply") {
      const replyTo = claim.envelope.authorization.reply_to;
      const rows = await tx<{ state: string; claimed_sender_did: string | null;
        claimed_message_id: string | null }[]>`
        SELECT state, claimed_sender_did, claimed_message_id FROM reply_capabilities
        WHERE original_sender_did = ${claim.envelope.to} AND original_message_id = ${replyTo}
        FOR UPDATE
      `;
      const capability = rows[0];
      if (!capability || capability.state !== "claimed" ||
        capability.claimed_sender_did !== claim.senderDid || capability.claimed_message_id !== claim.messageId) {
        throw new Error("Delivery claim does not own the reply capability");
      }
      if (state === "delivered") {
        await tx`
          UPDATE reply_capabilities SET state = 'consumed', updated_at = clock_timestamp()
          WHERE original_sender_did = ${claim.envelope.to} AND original_message_id = ${replyTo}
        `;
      } else {
        await tx`
          UPDATE reply_capabilities SET state = 'available', claimed_sender_did = NULL,
            claimed_message_id = NULL, updated_at = clock_timestamp()
          WHERE original_sender_did = ${claim.envelope.to} AND original_message_id = ${replyTo}
        `;
      }
    }
    await tx`
      UPDATE delivery_work SET state = ${state}, reason = ${reason},
        status_revision = status_revision + 1, lease_token = NULL,
        lease_expires_at = NULL, transitioned_at = clock_timestamp()
      WHERE sender_did = ${claim.senderDid} AND message_id = ${claim.messageId}
    `;
    await tx`
      INSERT INTO terminal_status_publications (sender_did, message_id)
      VALUES (${claim.senderDid}, ${claim.messageId})
    `;
  }
}
