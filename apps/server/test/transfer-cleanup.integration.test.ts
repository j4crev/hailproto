import { randomBytes, randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { encodeBase64Url } from "@hailproto/codec";
import { ProviderDatabase } from "../src/db/database.js";
import { KeyEncryptor } from "../src/identity/key-encryption.js";
import { TransferCleanup } from "../src/migration/cleanup.js";
import { PreparedMigrationTarget } from "../src/migration/target-keys.js";

const integration = process.env.TRANSFER_TARGET_DATABASE_URL ? describe : describe.skip;

integration("transfer expiry cleanup", () => {
  it("releases an expired never-submitted name but retains a possibly fenced submitted transfer", async () => {
    const db = new ProviderDatabase(process.env.TRANSFER_TARGET_DATABASE_URL!);
    try {
      await db.migrate();
      const target = new PreparedMigrationTarget(db.sql,
        new KeyEncryptor(encodeBase64Url(randomBytes(32))), "https://target.example.com/hail");
      const setup = async (did: string, submitted: boolean) => {
        const prepared = await target.prepare(did);
        const address = `expired-${randomUUID()}@target.example.com`;
        const accountId = randomUUID();
        await db.sql`INSERT INTO provider_accounts (id, tenant_id, canonical_address, onboarding_state)
          VALUES (${accountId}, ${randomUUID()}, ${address}, 'reserved')`;
        await db.sql`INSERT INTO received_transfer_invitations
          (did, nonce, grant_digest, invitation_digest, transfer_id,
           request_bytes, request_signature, expires_at,
           final_request_bytes, final_request_signature, final_submitted_at)
          VALUES (${did}, ${randomUUID()}, ${randomBytes(32)}, ${randomBytes(32)},
            ${prepared.transferId}, ${new Uint8Array([1])}, ${new Uint8Array([2])},
            clock_timestamp() - interval '1 minute',
            ${submitted ? new Uint8Array([3]) : null}, ${submitted ? new Uint8Array([4]) : null},
            ${submitted ? new Date() : null})`;
        await db.sql`INSERT INTO transfer_address_reservations
          (transfer_id, did, canonical_address, reserved_account_id,
           selection_bytes, selection_signature, receipt_bytes, receipt_signature,
           expires_at, state)
          VALUES (${prepared.transferId}, ${did}, ${address}, ${accountId},
            ${new Uint8Array([5])}, ${new Uint8Array([6])},
            ${new Uint8Array([7])}, ${new Uint8Array([8])},
            clock_timestamp() - interval '1 minute', ${submitted ? "submitted" : "selected"})`;
        return { transferId: prepared.transferId, address };
      };
      const alphabet = "abcdefghijklmnopqrstuvwxyz234567";
      const newDid = () => `did:plc:${Array.from(randomBytes(24), (value) => alphabet[value % 32]).join("")}`;
      const releasable = await setup(newDid(), false);
      const ambiguous = await setup(newDid(), true);
      expect(await new TransferCleanup(db.sql).runOnce()).toBe("target");
      expect(await db.sql`SELECT transfer_id FROM received_transfer_invitations
        WHERE transfer_id = ${releasable.transferId}`).toHaveLength(0);
      expect(await db.sql`SELECT id FROM provider_accounts
        WHERE canonical_address = ${releasable.address}`).toHaveLength(0);
      expect(await db.sql`SELECT transfer_id FROM received_transfer_invitations
        WHERE transfer_id = ${ambiguous.transferId}`).toHaveLength(1);
      expect(await db.sql`SELECT id FROM provider_accounts
        WHERE canonical_address = ${ambiguous.address}`).toHaveLength(1);
    } finally { await db.close(); }
  });
});
