import { createHash } from "node:crypto";
import { encodePayload, inspectSignedPayload, type HailEnvelope } from "@hailproto/codec";
import type { SQL } from "bun";
import type { PlcResolutionEvidence } from "../plc/resolver.js";
import { retainPublicEnvelopeAuthority } from "../plc/envelope-authority.js";

export interface PublishedBodyInfo { size: number; senderAccountId: string; }
export interface EnvelopeDecision {
  payload: HailEnvelope;
  representation: Uint8Array;
  payloadDigest: Uint8Array;
  envelopeDigest: Uint8Array;
  localAccountId: string;
  signingPublicKey: string;
  evidence: PlcResolutionEvidence;
  recipientEvidence?: PlcResolutionEvidence;
  recipientServiceBase?: string;
  now: number;
}

export type EnvelopeOutcome = "accepted" | "duplicate" | "conflict" | "unauthorized" | "message-expired";

export class EnvelopeRepository {
  constructor(private readonly sql: SQL) {}

  async sent(senderDid: string, messageId: string): Promise<Uint8Array | null> {
    const rows = await this.sql<{ envelope_cose: Uint8Array }[]>`
      SELECT envelope_cose FROM sent_envelopes WHERE sender_did = ${senderDid} AND message_id = ${messageId}
    `;
    return rows[0] ? new Uint8Array(rows[0].envelope_cose) : null;
  }

  async receivedReplyOpportunity(recipientDid: string, messageId: string): Promise<HailEnvelope | null> {
    const rows = await this.sql<{ envelope_cose: Uint8Array }[]>`
      SELECT envelope_cose FROM received_envelopes
      WHERE recipient_did = ${recipientDid} AND message_id = ${messageId} AND outcome = 'accepted'
    `;
    if (!rows[0]) return null;
    const payload = inspectSignedPayload("hail.envelope", rows[0].envelope_cose).payload;
    return payload.to === recipientDid && payload.message_id === messageId ? payload : null;
  }

  async publishedBody(senderDid: string, digest: Uint8Array): Promise<PublishedBodyInfo | null> {
    const rows = await this.sql<{ size: number; sender_account_id: string }[]>`
      SELECT octet_length(body.body_bytes) AS size, body.sender_account_id
      FROM detached_bodies body JOIN provider_accounts account ON account.id = body.sender_account_id
      WHERE body.digest = ${digest} AND account.did = ${senderDid}
        AND account.onboarding_state = 'active' AND account.activation_verification_mode = 'public'
    `;
    return rows[0] ? { size: rows[0].size, senderAccountId: rows[0].sender_account_id } : null;
  }

  async createSent(payload: HailEnvelope, representation: Uint8Array, accountId: string): Promise<void> {
    const grantId = payload.authorization.type === "grant" ? payload.authorization.grant_id : null;
    const replyTo = payload.authorization.type === "reply" ? payload.authorization.reply_to : null;
    const inspected = inspectSignedPayload("hail.envelope", representation);
    if (!Buffer.from(inspected.payloadBytes).equals(Buffer.from(encodePayload("hail.envelope", payload))) ||
      representation.length > 16_384) {
      throw new Error("Invalid signed envelope");
    }
    const tokenHash = createHash("sha256").update(payload.body.access.token).digest();
    const envelopeDigest = createHash("sha256").update(inspected.payloadBytes).digest();
    await this.sql.begin(async (tx) => {
      const accounts = await tx<{ id: string }[]>`
        SELECT id FROM provider_accounts WHERE id = ${accountId} AND did = ${payload.from}
          AND onboarding_state = 'active' AND activation_verification_mode = 'public' FOR UPDATE
      `;
      if (!accounts[0]) throw new Error("Sender is not publicly active");
      const bodies = await tx<{ size: number; available_until: string | bigint | number | null }[]>`
        SELECT octet_length(body_bytes) AS size, available_until FROM detached_bodies
        WHERE digest = ${payload.body.digest.value} AND sender_account_id = ${accountId} FOR UPDATE
      `;
      const body = bodies[0];
      if (!body || body.size !== payload.body.size) throw new Error("Signed body is not published");
      await tx`
        INSERT INTO sent_envelopes (sender_did, message_id, recipient_did, grant_id,
          reply_to_message_id, authorization_type, envelope_cose, envelope_digest, body_digest, sender_account_id)
        VALUES (${payload.from}, ${payload.message_id}, ${payload.to}, ${grantId}, ${replyTo},
          ${payload.authorization.type}, ${representation}, ${envelopeDigest}, ${payload.body.digest.value}, ${accountId})
      `;
      if (payload.reply.allowed) {
        await tx`
          INSERT INTO reply_capabilities (original_sender_did, original_message_id,
            permitted_recipient_did, reply_until)
          VALUES (${payload.from}, ${payload.message_id}, ${payload.to}, ${payload.reply.until})
        `;
      }
      await tx`
        INSERT INTO body_authorizations
          (token_hash, body_digest, sender_account_id, recipient_did, message_id, expires_at, available_until)
        VALUES (${tokenHash}, ${payload.body.digest.value}, ${accountId}, ${payload.to},
          ${payload.message_id}, ${payload.body.access.expires_at}, ${payload.body.available_until})
      `;
      if (body.available_until === null || Number(body.available_until) < payload.body.available_until) {
        await tx`UPDATE detached_bodies SET available_until = ${payload.body.available_until}
          WHERE digest = ${payload.body.digest.value} AND sender_account_id = ${accountId}`;
      }
    });
  }

  async candidate(authorization: HailEnvelope["authorization"], from: string, to: string): Promise<boolean> {
    if (authorization.type === "reply") {
      const rows = await this.sql<{ original_message_id: string }[]>`
        SELECT original_message_id FROM reply_capabilities
        WHERE original_sender_did = ${to} AND original_message_id = ${authorization.reply_to}
          AND permitted_recipient_did = ${from}
      `;
      return rows.length > 0;
    }
    const rows = await this.sql<{ grant_id: string }[]>`
      SELECT grant_id FROM grant_lineages WHERE grant_id = ${authorization.grant_id} AND grantor_did = ${to}
        AND grantee_did = ${from} AND local_role = 'grantor'
    `;
    return rows.length > 0;
  }

  async accept(input: EnvelopeDecision, signal?: AbortSignal): Promise<EnvelopeOutcome> {
    const { payload, localAccountId, payloadDigest } = input;
    if (payload.authorization.type === "reply") {
      const replyTo = payload.authorization.reply_to;
      return this.sql.begin(async (tx): Promise<EnvelopeOutcome> => {
        signal?.throwIfAborted();
        const claims = await tx<{ sender_account_id: string; reply_until: number | string | bigint;
          state: string; envelope_cose: Uint8Array }[]>`
          SELECT sent.sender_account_id, capability.reply_until, capability.state, sent.envelope_cose
          FROM reply_capabilities capability JOIN sent_envelopes sent
            ON sent.sender_did = capability.original_sender_did
            AND sent.message_id = capability.original_message_id
          WHERE capability.original_sender_did = ${payload.to}
            AND capability.original_message_id = ${replyTo}
            AND capability.permitted_recipient_did = ${payload.from}
          FOR UPDATE OF capability
        `;
        const claim = claims[0];
        signal?.throwIfAborted();
        if (!claim || claim.sender_account_id !== localAccountId) return "unauthorized";
        const original = inspectSignedPayload("hail.envelope", claim.envelope_cose).payload;
        if (!original.reply.allowed || original.reply.until !== Number(claim.reply_until) ||
          original.from !== payload.to || original.to !== payload.from) return "unauthorized";
        const previous = await this.previousOutcome(tx, payload, payloadDigest);
        if (previous) return previous;
        const clock = await tx<{ instant: string | number }[]>`SELECT extract(epoch from clock_timestamp()) AS instant`;
        signal?.throwIfAborted();
        const now = Number(clock[0]!.instant);
        const deadline = Math.min(payload.expires_at + 300, payload.body.available_until, payload.body.access.expires_at);
        const outcome = now > deadline ? "message-expired"
          : claim.state === "available" && now <= original.reply.until + 300 ? "accepted" : "unauthorized";
        const inserted = await this.insertReceived(tx, input, null, replyTo, outcome, now);
        if (inserted && outcome === "accepted") {
          await tx`
            UPDATE reply_capabilities SET state = 'claimed', claimed_sender_did = ${payload.from},
              claimed_message_id = ${payload.message_id}, updated_at = clock_timestamp()
            WHERE original_sender_did = ${payload.to} AND original_message_id = ${replyTo}
          `;
        }
        return inserted ? outcome : this.previousOutcome(tx, payload, payloadDigest).then((winner) => winner ?? "conflict");
      });
    }
    const grantId = payload.authorization.grant_id;
    // Lock the grant pointer before inspecting its status or reserving the replay key.
    // Revocation and acceptance serialize on the same lineage row.
    return this.sql.begin(async (tx): Promise<EnvelopeOutcome> => {
      signal?.throwIfAborted();
      const lineages = await tx<{
        local_account_id: string; current_status: string; expires_at: string | number | bigint | null;
        scope_payload: unknown;
      }[]>`
        SELECT lineage.local_account_id, lineage.current_status, revision.expires_at, revision.scope_payload
        FROM grant_lineages lineage JOIN grant_revisions revision
          ON revision.grant_id = lineage.grant_id AND revision.revision = lineage.current_revision
        WHERE lineage.grant_id = ${grantId}
          AND lineage.grantor_did = ${payload.to} AND lineage.grantee_did = ${payload.from}
          AND lineage.local_role = 'grantor'
        FOR UPDATE OF lineage
      `;
      const lineage = lineages[0];
      signal?.throwIfAborted();
      if (!lineage || lineage.local_account_id !== localAccountId) return "unauthorized";
      const previous = await this.previousOutcome(tx, payload, payloadDigest);
      if (previous) return previous;
      const clock = await tx<{ instant: string | number }[]>`SELECT extract(epoch from clock_timestamp()) AS instant`;
      signal?.throwIfAborted();
      const now = Number(clock[0]!.instant);
      const scope = typeof lineage.scope_payload === "string" ? JSON.parse(lineage.scope_payload) : lineage.scope_payload;
      const selector = Array.isArray(scope) ? scope[0] : null;
      const permitted = lineage.current_status === "active" &&
        (lineage.expires_at === null || Number(lineage.expires_at) >= now) &&
        ((selector?.type === "categories" && typeof payload.category === "string" && selector.values?.includes(payload.category)) ||
         (selector?.type === "uncategorized" && payload.category === undefined));
      const deadline = Math.min(payload.expires_at + 300, payload.body.available_until, payload.body.access.expires_at);
      const outcome = now > deadline ? "message-expired" : permitted ? "accepted" : "unauthorized";
      const inserted = await this.insertReceived(tx, input, grantId, null, outcome, now);
      return inserted ? outcome : this.previousOutcome(tx, payload, payloadDigest).then((winner) => winner ?? "conflict");
    });
  }

  private async previousOutcome(tx: SQL, payload: HailEnvelope, digest: Uint8Array): Promise<"duplicate" | "conflict" | null> {
    const rows = await tx<{ payload_digest: Uint8Array }[]>`
      SELECT payload_digest FROM received_envelopes
      WHERE sender_did = ${payload.from} AND message_id = ${payload.message_id}
    `;
    return rows[0] ? Buffer.from(rows[0].payload_digest).equals(Buffer.from(digest)) ? "duplicate" : "conflict" : null;
  }

  private async insertReceived(tx: SQL, input: EnvelopeDecision, grantId: string | null,
    replyTo: string | null, outcome: "accepted" | "unauthorized" | "message-expired", now: number): Promise<boolean> {
    const { payload, representation, envelopeDigest, payloadDigest, localAccountId, signingPublicKey, evidence } = input;
    const inserted = await tx<{ payload_digest: Uint8Array }[]>`
        INSERT INTO received_envelopes
          (sender_did, message_id, recipient_did, grant_id, reply_to_message_id,
           authorization_type, local_account_id, envelope_cose,
           envelope_digest, payload_digest, signing_public_key, signing_plc_document,
           signing_plc_data, signing_plc_operation_log, outcome, accepted_at)
        VALUES (${payload.from}, ${payload.message_id}, ${payload.to}, ${grantId}, ${replyTo},
          ${payload.authorization.type},
          ${localAccountId}, ${representation}, ${envelopeDigest}, ${payloadDigest}, ${signingPublicKey},
          ${JSON.stringify(evidence.document)}::jsonb, ${JSON.stringify(evidence.data)}::jsonb,
          ${JSON.stringify(evidence.log)}::jsonb, ${outcome},
          ${outcome === "accepted" ? new Date(now * 1000) : null})
        ON CONFLICT (sender_did, message_id) DO NOTHING
        RETURNING payload_digest
      `;
    if (inserted.length && outcome === "accepted") {
      await retainPublicEnvelopeAuthority(tx,input,now);
      await tx`
        INSERT INTO delivery_work (sender_did, message_id, state)
        VALUES (${payload.from}, ${payload.message_id}, 'accepted')
      `;
    }
    return inserted.length > 0;
  }
}
