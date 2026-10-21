import type { SQL } from "bun";

const limits = {
  "access-prepare": 20,
  "access-complete": 60,
  grant: 120,
  invitation: 120,
  reservation: 120,
  request: 120,
} as const;

export class TransferRateLimit {
  constructor(private readonly sql: SQL) {}

  async admit(category: keyof typeof limits): Promise<boolean> {
    return this.take(`global:${category}`, limits[category]);
  }

  async admitAuthenticated(category: keyof typeof limits, did: string): Promise<boolean> {
    if (!/^did:plc:[a-z2-7]{24}$/.test(did)) return false;
    return this.take(`did:${category}:${did}`, 12);
  }

  private async take(bucket: string, ceiling: number): Promise<boolean> {
    const rows = await this.sql<{ attempts: number }[]>`
      INSERT INTO transfer_rate_limits (bucket) VALUES (${bucket})
      ON CONFLICT (bucket) DO UPDATE SET
        attempts = CASE
          WHEN transfer_rate_limits.window_started_at < clock_timestamp() - interval '1 minute'
          THEN 1 ELSE transfer_rate_limits.attempts + 1 END,
        window_started_at = CASE
          WHEN transfer_rate_limits.window_started_at < clock_timestamp() - interval '1 minute'
          THEN clock_timestamp() ELSE transfer_rate_limits.window_started_at END
      WHERE transfer_rate_limits.window_started_at < clock_timestamp() - interval '1 minute'
        OR transfer_rate_limits.attempts < ${ceiling}
      RETURNING attempts`;
    return rows.length === 1;
  }

  async prune(): Promise<void> {
    await this.sql`DELETE FROM transfer_rate_limits
      WHERE window_started_at < clock_timestamp() - interval '1 day'`;
  }
}
