import { describe, expect, it } from "vitest";
import { ProviderDatabase } from "../src/db/database.js";
import { TransferRateLimit } from "../src/migration/rate-limit.js";

const integration = process.env.DATABASE_URL ? describe : describe.skip;

integration("shared transfer throttling", () => {
  it("shares per-DID and global limits across independent service instances", async () => {
    const db = new ProviderDatabase(process.env.DATABASE_URL!);
    try {
      await db.migrate();
      await db.sql`DELETE FROM transfer_rate_limits WHERE bucket = 'global:request'`;
      await db.sql`DELETE FROM transfer_rate_limits WHERE bucket = ${`did:reservation:did:plc:${"k".repeat(24)}`}`;
      const first = new TransferRateLimit(db.sql);
      const second = new TransferRateLimit(db.sql);
      const did = `did:plc:${"k".repeat(24)}`;
      for (let i = 0; i < 12; i += 1) {
        expect(await (i % 2 ? first : second).admitAuthenticated("reservation", did)).toBe(true);
      }
      expect(await second.admitAuthenticated("reservation", did)).toBe(false);
      expect(await first.admitAuthenticated("reservation", "not-a-did")).toBe(false);
      // This bucket is shared by all DIDs and provider processes.
      for (let i = 0; i < 120; i += 1) {
        expect(await (i % 2 ? first : second).admit("request")).toBe(true);
      }
      expect(await second.admit("request")).toBe(false);
      await db.sql`UPDATE transfer_rate_limits SET window_started_at = clock_timestamp() - interval '2 minutes'
        WHERE bucket IN (${`did:reservation:${did}`}, 'global:request')`;
      expect(await first.admitAuthenticated("reservation", did)).toBe(true);
      expect(await second.admit("request")).toBe(true);
    } finally { await db.close(); }
  });
});
