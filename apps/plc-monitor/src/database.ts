import { createHash } from "node:crypto";
import { SQL } from "bun";

export class MonitorDatabase {
  readonly sql: SQL;

  constructor(url: string) { this.sql = new SQL(url, { max: 10 }); }

  async migrate(): Promise<void> {
    await this.sql`CREATE TABLE IF NOT EXISTS schema_migrations (
      version integer PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())`;
    await this.sql.begin(async (tx) => {
      await tx`SELECT pg_advisory_xact_lock(686169154)`;
      for (const [version, filename] of [[1, "0001_monitor.sql"], [2, "0002_user_approved_expectations.sql"],
        [3, "0003_backfill_readiness.sql"], [4, "0004_onboarding_notification.sql"],
        [5, "0005_per_did_audit_polling.sql"]] as const) {
        const contents = await Bun.file(new URL(`../migrations/${filename}`, import.meta.url)).text();
        const checksum = createHash("sha256").update(contents).digest("hex");
        const rows = await tx<{ checksum: string }[]>`SELECT checksum FROM schema_migrations WHERE version = ${version}`;
        if (rows[0]) {
          if (rows[0].checksum !== checksum) throw new Error(`Applied monitor migration ${version} checksum changed`);
          continue;
        }
        await tx.unsafe(contents);
        await tx`INSERT INTO schema_migrations(version, checksum) VALUES (${version}, ${checksum})`;
      }
    });
  }

  close(): Promise<void> { return this.sql.close(); }
}
