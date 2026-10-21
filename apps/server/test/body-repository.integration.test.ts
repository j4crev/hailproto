import { createHash, randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BodyRepository } from "../src/bodies/repository.js";
import { bodyFromText, bodyDigest } from "../src/bodies/service.js";
import { uuidV7 } from "../src/identity/uuid-v7.js";
import type { ProviderDatabase } from "../src/db/database.js";

const integration = process.env.DATABASE_URL ? describe : describe.skip;
integration("detached body PostgreSQL storage", () => {
  const id = randomUUID();
  const tenant = randomUUID();
  const alphabet = "abcdefghijklmnopqrstuvwxyz234567";
  const did = `did:plc:${Array.from(randomBytes(24), (n) => alphabet[n % 32]).join("")}`;
  const recipientDid = `did:plc:${"a".repeat(24)}`;
  let db: ProviderDatabase;
  let store: BodyRepository;

  beforeAll(async () => {
    const { ProviderDatabase } = await import("../src/db/database.js");
    db = new ProviderDatabase(process.env.DATABASE_URL!);
    await db.migrate();
    store = new BodyRepository(db.sql);
    await db.sql`
      INSERT INTO provider_accounts (id, tenant_id, canonical_address, did, onboarding_state,
        activated_at, activation_binding_digest, activation_verification_mode)
      VALUES (${id}, ${tenant}, ${`body-${id}@example.com`}, ${did}, 'active', now(),
        ${new Uint8Array(32).fill(3)}, 'public')
    `;
  });
  afterAll(async () => {
    if (!db) return;
    await db.sql`DELETE FROM body_authorizations WHERE sender_account_id = ${id}`;
    await db.sql`DELETE FROM detached_bodies WHERE sender_account_id = ${id}`;
    await db.sql`DELETE FROM provider_accounts WHERE id = ${id}`;
    await db.close();
  });

  it("retains exact bytes and hashed recipient-scoped token across re-instantiation", async () => {
    const bytes = bodyFromText("Integration hello");
    const body = await store.publish(did, bytes);
    expect(await store.publish(did, bytes)).toEqual(body);
    const token = randomBytes(32);
    const hash = createHash("sha256").update(token).digest();
    const now = Math.floor(Date.now() / 1000);
    const availableUntil = now + 31 * 86400;
    await store.authorize({ senderDid: did, recipientDid, messageId: uuidV7(),
      digest: body.digest, token, availableUntil, expiresAt: availableUntil });
    const rows = await db.sql<{ token_hash: Uint8Array }[]>`
      SELECT token_hash FROM body_authorizations WHERE sender_account_id = ${id}
    `;
    expect(rows).toHaveLength(1);
    expect(Buffer.from(rows[0]!.token_hash)).toEqual(hash);
    expect(Buffer.from(rows[0]!.token_hash)).not.toEqual(token);
    const resumed = new BodyRepository(db.sql);
    expect(await resumed.retrieve(body.digest, hash, now)).toEqual({ bytes: new Uint8Array(bytes), digest: new Uint8Array(bodyDigest(bytes)) });
    expect(await resumed.retrieve(body.digest, hash, availableUntil + 1)).toBeNull();
    expect(await resumed.retrieve(bodyDigest(bodyFromText("other")), hash, now)).toBeNull();
    expect(await resumed.retrieve(body.digest, randomBytes(32), now)).toBeNull();
    const retention = await db.sql<{ available_until: string | number | bigint }[]>`
      SELECT available_until FROM detached_bodies WHERE sender_account_id = ${id}
    `;
    expect(Number(retention[0]?.available_until)).toBe(availableUntil);
  });
});
