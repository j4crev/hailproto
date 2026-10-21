import { randomUUID } from "node:crypto";
import { encodeBase64Url, inspectSignedPayload } from "@hailproto/codec";
import type { SQL } from "bun";
import { COSE_SIGN1_MEDIA_TYPE } from "../discovery/routes.js";
import type { DiscoveryFetch, NetworkTargetValidator } from "../discovery/verifier.js";
import type { HailDidResolver } from "../plc/resolver.js";
import type { DeliveryStatusSigner } from "./status.js";

interface Claim { senderDid: string; messageId: string; token: string; attempt: number; retryUntil: Date; }

export class TerminalStatusPublisher {
  constructor(
    private readonly sql: SQL,
    private readonly signer: Pick<DeliveryStatusSigner, "signCurrent">,
    private readonly resolver: HailDidResolver,
    private readonly fetchRequest: DiscoveryFetch,
    private readonly validateTarget: NetworkTargetValidator,
    private readonly now: () => Date = () => new Date(),
    private readonly random: () => number = Math.random,
  ) {}

  async publishOne(): Promise<"idle" | "acknowledged" | "retry" | "blocked"> {
    const claim = await this.claim();
    if (!claim) return "idle";
    let responseStatus: number | null = null;
    let retryAfter: Date | null = null;
    try {
      const cose = await this.signer.signCurrent(claim.senderDid, claim.messageId);
      if (!cose) throw new Error("Terminal delivery status is unavailable");
      const status = inspectSignedPayload("hail.delivery-status", cose).payload;
      if (!["delivered", "failed", "cancelled"].includes(status.state)) {
        throw new Error("Terminal publication has a nonterminal snapshot");
      }
      const sender = await this.resolver.resolve(claim.senderDid);
      const url = new URL(`${sender.serviceBase}/deliveries/${encodeBase64Url(status.envelope_digest.value)}`);
      await this.validateTarget(url);
      const response = await this.fetchRequest(new Request(url, {
        method: "PUT", redirect: "manual", signal: AbortSignal.timeout(15_000),
        headers: { "Content-Type": COSE_SIGN1_MEDIA_TYPE, "Accept-Encoding": "identity", "Cache-Control": "no-store" },
        body: Uint8Array.from(cose).buffer,
      }));
      responseStatus = response.status;
      if (response.status === 204 && !response.body && !response.headers.get("content-encoding")) {
        await this.finish(claim, "acknowledged", responseStatus, null, null);
        return "acknowledged";
      }
      await response.body?.cancel();
      if ([400, 409, 405, 413, 415].includes(response.status)) {
        await this.finish(claim, "blocked", responseStatus, null, `Status was rejected with HTTP ${response.status}`);
        return "blocked";
      }
      if ([429, 503].includes(response.status)) {
        retryAfter = parseRetryAfter(response.headers.get("retry-after"), this.now());
      }
    } catch {
      // Signature, PLC, transport and ambiguous response errors remain retryable.
    }
    if (this.now() >= claim.retryUntil) {
      await this.finish(claim, "blocked", responseStatus, null, "Minimum terminal status retry deadline passed");
      return "blocked";
    }
    const next = new Date(Math.min(claim.retryUntil.getTime(), this.nextAttempt(claim.attempt, retryAfter).getTime()));
    await this.finish(claim, "retry", responseStatus, next, "Status delivery is not yet acknowledged");
    return "retry";
  }

  private async claim(): Promise<Claim | null> {
    const token = randomUUID();
    return this.sql.begin(async (tx) => {
      const rows = await tx<{ sender_did: string; message_id: string; attempt_count: number;
        envelope_cose: Uint8Array; transitioned_at: Date }[]>`
        SELECT publication.sender_did, publication.message_id, publication.attempt_count,
          received.envelope_cose, work.transitioned_at
        FROM terminal_status_publications publication
        JOIN received_envelopes received ON received.sender_did = publication.sender_did
          AND received.message_id = publication.message_id
        JOIN delivery_work work ON work.sender_did = publication.sender_did
          AND work.message_id = publication.message_id
        WHERE publication.state IN ('pending', 'retry') AND publication.next_attempt_at <= now()
          AND (publication.lease_expires_at IS NULL OR publication.lease_expires_at <= now())
          AND NOT EXISTS (SELECT 1 FROM provider_migration_fences fence
            WHERE fence.did = received.recipient_did)
        ORDER BY publication.next_attempt_at, publication.message_id
        FOR UPDATE OF publication SKIP LOCKED LIMIT 1
      `;
      if (!rows[0]) return null;
      const row = rows[0];
      const envelope = inspectSignedPayload("hail.envelope", row.envelope_cose).payload;
      const replay = Math.max(envelope.expires_at, envelope.body.available_until) + 300;
      const retryUntil = new Date(Math.max(replay * 1000, row.transitioned_at.getTime() + 2_592_000_000));
      await tx`UPDATE terminal_status_publications SET lease_token = ${token},
        lease_expires_at = now() + interval '60 seconds', attempt_count = attempt_count + 1,
        updated_at = now() WHERE sender_did = ${row.sender_did} AND message_id = ${row.message_id}`;
      return { senderDid: row.sender_did, messageId: row.message_id, token, attempt: row.attempt_count + 1, retryUntil };
    });
  }

  private async finish(claim: Claim, state: "retry" | "blocked" | "acknowledged",
    status: number | null, next: Date | null, error: string | null): Promise<void> {
    await this.sql`
      UPDATE terminal_status_publications SET state = ${state}, last_http_status = ${status},
        last_error = ${error}, next_attempt_at = COALESCE(${next}, next_attempt_at),
        acknowledged_at = CASE WHEN ${state} = 'acknowledged' THEN now() ELSE acknowledged_at END,
        lease_token = NULL, lease_expires_at = NULL, updated_at = now()
      WHERE sender_did = ${claim.senderDid} AND message_id = ${claim.messageId}
        AND lease_token = ${claim.token} AND state IN ('pending', 'retry')
    `;
  }

  private nextAttempt(attempt: number, remote: Date | null): Date {
    const nominal = [30, 120, 600, 3_600, 21_600][Math.min(attempt - 1, 4)] ?? 86_400;
    const seconds = attempt > 5 ? 86_400 : nominal;
    const low = Math.ceil(0.8 * seconds);
    const high = Math.floor(1.2 * seconds);
    const local = this.now().getTime() + (low + Math.floor(this.random() * (high - low + 1))) * 1000;
    return new Date(Math.max(local, remote?.getTime() ?? 0));
  }
}

function parseRetryAfter(value: string | null, now: Date): Date | null {
  if (!value) return null;
  const max = now.getTime() + 86_400_000;
  if (/^\d+$/.test(value)) return new Date(Math.min(max, now.getTime() + Number(value) * 1000));
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && parsed > now.getTime() ? new Date(Math.min(parsed, max)) : null;
}
