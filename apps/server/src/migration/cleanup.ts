import type { SQL } from "bun";
import type { TransferRateLimit } from "./rate-limit.js";

export class TransferCleanup {
  constructor(private readonly sql: SQL, private readonly rateLimit?: TransferRateLimit) {}

  async runOnce(): Promise<"target" | "source" | "idle"> {
    const cleaned = await this.sql.begin(async (tx) => {
      // After an attempted final push the source may have fenced despite an
      // ambiguous response. Expiration alone MUST NOT release that address.
      const rows = await tx<{ did: string; transfer_id: string }[]>`
        SELECT i.did, i.transfer_id FROM received_transfer_invitations i
        LEFT JOIN transfer_address_reservations r ON r.transfer_id = i.transfer_id
        JOIN prepared_migration_target_keys k ON k.transfer_id = i.transfer_id
        WHERE i.expires_at < clock_timestamp() AND i.final_request_bytes IS NULL
          AND k.state = 'prepared' AND (r.state IS NULL OR r.state = 'selected')
          AND NOT EXISTS (SELECT 1 FROM pending_migration_imports p
            WHERE p.transfer_id = i.transfer_id AND p.state IN ('staged', 'active'))
        ORDER BY i.expires_at FOR UPDATE OF i SKIP LOCKED LIMIT 1`;
      const row = rows[0];
      if (!row) return false;
      const reservations = await tx<{ reserved_account_id: string | null; state: string }[]>`
        SELECT reserved_account_id, state FROM transfer_address_reservations
        WHERE transfer_id = ${row.transfer_id} FOR UPDATE`;
      if (reservations[0] && reservations[0].state !== "selected") return false;
      await tx`DELETE FROM transfer_address_reservations WHERE transfer_id = ${row.transfer_id}
        AND state = 'selected'`;
      if (reservations[0]?.reserved_account_id) {
        await tx`DELETE FROM provider_accounts WHERE id = ${reservations[0].reserved_account_id}
          AND did IS NULL AND onboarding_state = 'reserved'`;
      }
      await tx`DELETE FROM received_transfer_invitations WHERE transfer_id = ${row.transfer_id}
        AND final_request_bytes IS NULL`;
      await tx`DELETE FROM prepared_migration_target_keys WHERE transfer_id = ${row.transfer_id}
        AND state = 'prepared'`;
      return true;
    });
    if (cleaned) return "target";
    const source = await this.sql<{ did: string }[]>`
      DELETE FROM provider_transfer_authorizations WHERE did IN (
        SELECT did FROM provider_transfer_authorizations
        WHERE expires_at < clock_timestamp() - interval '1 hour'
          AND consumed_transfer_id IS NULL AND origin_confirmed_at IS NULL
          AND cancelled_at IS NULL
        ORDER BY expires_at FOR UPDATE SKIP LOCKED LIMIT 1)
      RETURNING did`;
    if (source[0]) return "source";
    await this.sql`DELETE FROM cancelled_transfer_sessions
      WHERE recorded_at < clock_timestamp() - interval '8 days'`;
    await this.rateLimit?.prune();
    return "idle";
  }
}
