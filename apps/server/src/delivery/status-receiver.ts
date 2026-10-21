import { createWebCryptoVerifier, encodePayload, inspectSignedPayload, verifySignedPayload, type HailDeliveryStatus } from "@hailproto/codec";
import type { SQL } from "bun";
import { ed25519PublicKeyFromDidKey } from "../identity/did-key.js";
import type { EnvelopeAccounts } from "../envelopes/receiver.js";
import type { HailDidResolver } from "../plc/resolver.js";

type StatusOutcome = "acknowledged" | "unknown" | "conflict" | "bad-request";

interface SentRow {
  recipient_did: string;
  envelope_digest: Uint8Array;
}

export class DeliveryStatusReceiver {
  constructor(
    private readonly sql: SQL,
    private readonly accounts: EnvelopeAccounts,
    private readonly resolver: HailDidResolver,
    private readonly serviceBase: string,
  ) {}

  async receive(pathDigest: string, cose: Uint8Array, signal?: AbortSignal): Promise<StatusOutcome> {
    try {
      signal?.throwIfAborted();
      const inspected = inspectSignedPayload("hail.delivery-status", cose);
      const payload = inspected.payload;
      // Claimed fields here are lookup hints only. Nothing is disclosed or changed before verification.
      const candidate = await this.sql<SentRow[]>`
        SELECT recipient_did, envelope_digest FROM sent_envelopes
        WHERE sender_did = ${payload.to} AND message_id = ${payload.message_id}
      `;
      signal?.throwIfAborted();
      if (!candidate[0]) return "unknown";
      const recipient = await this.resolver.resolve(payload.from);
      signal?.throwIfAborted();
      await verifySignedPayload("hail.delivery-status", cose,
        createWebCryptoVerifier(async (kid) => {
          if (kid !== `${payload.from}#hail-messaging`) throw new Error("Wrong status key role");
          return ed25519PublicKeyFromDidKey(recipient.messagingDidKey);
        }));
      signal?.throwIfAborted();
      const sender = await this.resolver.resolve(payload.to);
      signal?.throwIfAborted();
      const local = await this.accounts.getAccountByDid(payload.to);
      signal?.throwIfAborted();
      if (sender.serviceBase !== this.serviceBase || !local || local.state !== "active" ||
        local.activationVerificationMode !== "public") return "unknown";
      if (candidate[0].recipient_did !== payload.from ||
        !Buffer.from(candidate[0].envelope_digest).equals(Buffer.from(payload.envelope_digest.value))) return "unknown";
      if (pathDigest !== Buffer.from(payload.envelope_digest.value).toString("base64url")) return "bad-request";
      return this.apply(payload, inspected.payloadBytes, cose, recipient.messagingDidKey, recipient.evidence, signal);
    } catch { return "unknown"; }
  }

  private async apply(
    payload: HailDeliveryStatus, bytes: Uint8Array, cose: Uint8Array, publicKey: string,
    evidence: Awaited<ReturnType<HailDidResolver["resolve"]>>["evidence"],
    signal?: AbortSignal,
  ): Promise<StatusOutcome> {
    return this.sql.begin(async (tx): Promise<StatusOutcome> => {
      signal?.throwIfAborted();
      const sent = await tx<SentRow[]>`
        SELECT recipient_did, envelope_digest FROM sent_envelopes
        WHERE sender_did = ${payload.to} AND message_id = ${payload.message_id} FOR UPDATE
      `;
      signal?.throwIfAborted();
      if (!sent[0] || sent[0].recipient_did !== payload.from ||
        !Buffer.from(sent[0].envelope_digest).equals(Buffer.from(payload.envelope_digest.value))) return "unknown";
      const previous = await tx<{ current_revision: number; current_state: string; payload_bytes: Uint8Array }[]>`
        SELECT current_revision, current_state, payload_bytes FROM sent_delivery_status
        WHERE sender_did = ${payload.to} AND message_id = ${payload.message_id}
      `;
      const current = previous[0];
      if (current && payload.revision < current.current_revision) return "acknowledged";
      if (current && payload.revision === current.current_revision) {
        return Buffer.from(current.payload_bytes).equals(Buffer.from(bytes)) ? "acknowledged" : "conflict";
      }
      if (current && (["delivered", "failed", "cancelled"].includes(current.current_state) ||
        payload.state === "accepted" || payload.revision <= current.current_revision)) return "conflict";
      if (!current && payload.state !== "accepted" && !["delivered", "failed", "cancelled"].includes(payload.state)) {
        return "conflict";
      }
      if (!Buffer.from(encodePayload("hail.delivery-status", payload)).equals(Buffer.from(bytes))) return "bad-request";
      const gap = current ? payload.revision - current.current_revision - 1 : payload.revision - 1;
      signal?.throwIfAborted();
      await tx`
        INSERT INTO sent_delivery_status (sender_did, message_id, recipient_did, current_revision,
          current_state, payload_bytes, cose, signing_public_key, signing_plc_document,
          signing_plc_data, signing_plc_operation_log, revision_gap)
        VALUES (${payload.to}, ${payload.message_id}, ${payload.from}, ${payload.revision},
          ${payload.state}, ${bytes}, ${cose}, ${publicKey},
          ${JSON.stringify(evidence.document)}::jsonb, ${JSON.stringify(evidence.data)}::jsonb,
          ${JSON.stringify(evidence.log)}::jsonb, ${gap})
        ON CONFLICT (sender_did, message_id) DO UPDATE SET
          current_revision = EXCLUDED.current_revision, current_state = EXCLUDED.current_state,
          payload_bytes = EXCLUDED.payload_bytes, cose = EXCLUDED.cose,
          signing_public_key = EXCLUDED.signing_public_key,
          signing_plc_document = EXCLUDED.signing_plc_document,
          signing_plc_data = EXCLUDED.signing_plc_data,
          signing_plc_operation_log = EXCLUDED.signing_plc_operation_log,
          revision_gap = sent_delivery_status.revision_gap + EXCLUDED.revision_gap,
          received_at = now()
      `;
      return "acknowledged";
    });
  }
}
