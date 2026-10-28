import { randomUUID } from "node:crypto";
import { SQL } from "bun";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ProviderDatabase } from "../src/db/database.js";
import { bodyDigest, bodyFromText } from "../src/bodies/service.js";
import { receivedContentUsage } from "../src/bodies/usage.js";

const integration = process.env.DATABASE_URL ? describe : describe.skip;
integration("shared received content storage", () => {
  let admin: SQL, db: ProviderDatabase, schema: string;
  const alice = "did:plc:" + "a".repeat(24), bob = "did:plc:" + "b".repeat(24);
  const sender = "did:plc:" + "s".repeat(24), otherSender = "did:plc:" + "t".repeat(24);
  const bytes = bodyFromText("A shared immutable body"), digest = bodyDigest(bytes);
  const forward = () => Bun.file(new URL("../migrations/0079_shared_received_bodies.sql", import.meta.url)).text();
  const rollback = () => Bun.file(new URL("../migrations/rollback/0079_shared_received_bodies.sql", import.meta.url)).text();
  const insert = (recipient: string, from = sender, content = bytes) => db.sql`
    INSERT INTO verified_body_provenance (recipient_did,sender_did,digest,media_type,profile,body_bytes)
    VALUES (${recipient},${from},${bodyDigest(content)},'application/hail-body+cbor','spt-1',${content})
    ON CONFLICT (recipient_did,sender_did,digest,media_type,profile) DO NOTHING`;
  beforeAll(async () => {
    admin = new SQL(process.env.DATABASE_URL!);
    schema = `shared_bodies_${randomUUID().replaceAll("-", "")}`;
    await admin.unsafe(`CREATE SCHEMA "${schema}"`);
    const url = new URL(process.env.DATABASE_URL!); url.searchParams.set("options", `-csearch_path=${schema}`);
    db = new ProviderDatabase(url.toString()); await db.migrate();
  });
  afterAll(async () => {
    if (db) await db.close();
    if (admin) { if (schema) await admin.unsafe(`DROP SCHEMA "${schema}" CASCADE`); await admin.close(); }
  });

  it("backfills exact bytes, preserves portable rows, and reverses without losing references", async () => {
    await db.sql.begin(async tx => { await tx.unsafe((await rollback()).replace(/^BEGIN;$/m, "").replace(/^COMMIT;$/m, "")); });
    await insert(alice); await insert(bob);
    const before = await db.sql`SELECT to_jsonb(p) AS row FROM verified_body_provenance p ORDER BY recipient_did`;
    await db.sql.begin(async tx => { await tx.unsafe(await forward()); });
    expect(await db.sql`SELECT to_jsonb(p) AS row FROM verified_body_contents p ORDER BY recipient_did`).toEqual(before);
    expect((await db.sql`SELECT count(*)::int AS n FROM shared_content_blobs`)[0]!.n).toBe(1);
    expect((await db.sql`SELECT count(*)::int AS n FROM verified_body_provenance WHERE body_bytes IS NOT NULL`)[0]!.n).toBe(0);
    await db.sql.begin(async tx => { await tx.unsafe((await rollback()).replace(/^BEGIN;$/m, "").replace(/^COMMIT;$/m, "")); });
    expect(await db.sql`SELECT to_jsonb(p) AS row FROM verified_body_provenance p ORDER BY recipient_did`).toEqual(before);
    await db.migrate(); // Reapplying through the normal runner is safe after rollback.
  });

  it("deduplicates across tenants while accounting once within each recipient", async () => {
    await insert(alice, otherSender); await insert(alice); await insert(bob);
    expect(await receivedContentUsage(db.sql, alice)).toEqual({ bytes: bytes.length, blobs: 1 });
    expect(await receivedContentUsage(db.sql, bob)).toEqual({ bytes: bytes.length, blobs: 1 });
    expect(await receivedContentUsage(db.sql, "did:plc:" + "c".repeat(24))).toEqual({ bytes: 0, blobs: 0 });
    expect((await db.sql`SELECT count(*)::int AS n FROM shared_content_blobs`)[0]!.n).toBe(1);
  });

  it("accepts existing portable JSON rows and rejects digest-only or corrupted writes", async () => {
    const [portable] = await db.sql`SELECT to_jsonb(p) AS row FROM verified_body_contents p WHERE recipient_did=${bob}`;
    await db.sql`DELETE FROM verified_body_provenance WHERE recipient_did=${bob}`;
    await db.sql.unsafe('INSERT INTO verified_body_provenance SELECT * FROM jsonb_populate_record(NULL::verified_body_provenance, ($1::text)::jsonb)', [JSON.stringify(portable!.row)]);
    const [restored] = await db.sql`SELECT body_bytes FROM verified_body_contents WHERE recipient_did=${bob}`;
    expect(Buffer.from(restored!.body_bytes)).toEqual(Buffer.from(bytes));
    await expect(db.sql`INSERT INTO verified_body_provenance (recipient_did,sender_did,digest,media_type,profile)
      VALUES ('missing-bytes',${sender},${digest},'application/hail-body+cbor','spt-1')`).rejects.toThrow("independently verified bytes");
    await expect(db.sql`INSERT INTO verified_body_provenance (recipient_did,sender_did,digest,media_type,profile,body_bytes)
      VALUES ('wrong-bytes',${sender},${digest},'application/hail-body+cbor','spt-1',${bodyFromText("wrong")})`).rejects.toThrow("digest mismatch");
  });

  it("keeps content for remaining recipients and collects only the last released blob", async () => {
    await db.sql`DELETE FROM verified_body_provenance WHERE recipient_did=${alice}`;
    expect((await db.sql`SELECT hail_collect_received_blobs() AS n`)[0]!.n).toBe(0);
    expect(await receivedContentUsage(db.sql, bob)).toEqual({ bytes: bytes.length, blobs: 1 });
    await expect(db.sql`DELETE FROM shared_content_blobs WHERE digest=${digest}`).rejects.toThrow();
    await db.sql`DELETE FROM verified_body_provenance WHERE recipient_did=${bob}`;
    expect((await db.sql`SELECT hail_collect_received_blobs() AS n`)[0]!.n).toBe(1);
    expect((await db.sql`SELECT hail_collect_received_blobs() AS n`)[0]!.n).toBe(0);
  });

  it("serializes concurrent inserts and excludes an in-flight reference from collection", async () => {
    await Promise.all([insert(alice), insert(bob)]);
    await db.sql`DELETE FROM verified_body_provenance`;
    await db.sql.begin(async tx => {
      await tx`INSERT INTO verified_body_provenance (recipient_did,sender_did,digest,media_type,profile,body_bytes)
        VALUES (${alice},${sender},${digest},'application/hail-body+cbor','spt-1',${bytes})`;
      expect((await db.sql`SELECT hail_collect_received_blobs() AS n`)[0]!.n).toBe(0);
    });
    expect(await receivedContentUsage(db.sql, alice)).toEqual({ bytes: bytes.length, blobs: 1 });
    expect((await db.sql`SELECT count(*)::int AS n FROM shared_content_blobs`)[0]!.n).toBe(1);
  });

  it("rolls back partial imports without leaving a blob or a reference", async () => {
    const content = bodyFromText("Never committed");
    await expect(db.sql.begin(async tx => {
      await tx`INSERT INTO verified_body_provenance (recipient_did,sender_did,digest,media_type,profile,body_bytes)
        VALUES (${bob},${sender},${bodyDigest(content)},'application/hail-body+cbor','spt-1',${content})`;
      throw new Error("abort import");
    })).rejects.toThrow("abort import");
    expect((await db.sql`SELECT count(*)::int AS n FROM shared_content_blobs WHERE digest=${bodyDigest(content)}`)[0]!.n).toBe(0);
    expect(await receivedContentUsage(db.sql, bob)).toEqual({ bytes: 0, blobs: 0 });
  });

  it("rejects corrupt legacy bytes atomically and permits a corrected retry", async () => {
    await db.sql.begin(async tx => { await tx.unsafe((await rollback()).replace(/^BEGIN;$/m, "").replace(/^COMMIT;$/m, "")); });
    const corrupt = bodyFromText("Corrupted legacy bytes");
    await db.sql`UPDATE verified_body_provenance SET body_bytes=${corrupt} WHERE recipient_did=${alice}`;
    await expect(db.migrate()).rejects.toThrow();
    expect((await db.sql`SELECT version FROM schema_migrations WHERE version=79`).length).toBe(0);
    expect((await db.sql`SELECT to_regclass('shared_content_blobs') AS name`)[0]!.name).toBeNull();
    expect(Buffer.from((await db.sql`SELECT body_bytes FROM verified_body_provenance WHERE recipient_did=${alice}`)[0]!.body_bytes)).toEqual(Buffer.from(corrupt));
    await db.sql`UPDATE verified_body_provenance SET body_bytes=${bytes} WHERE recipient_did=${alice}`;
    await db.migrate();
  });

  it("preserves fenced account bytes through migration and rollback without weakening the fence", async () => {
    const accountId = randomUUID();
    await db.sql`INSERT INTO provider_accounts (id,tenant_id,canonical_address,did,onboarding_state,
      activated_at,activation_binding_digest,activation_verification_mode)
      VALUES (${accountId},${randomUUID()},${`shared-${accountId}@example.com`},${alice},'active',now(),${digest},'public')`;
    await db.sql`INSERT INTO provider_migration_fences (did,account_id,transfer_id,destination_service_base,state)
      VALUES (${alice},${accountId},${randomUUID()},'https://target.example/hail','fenced')`;
    await db.sql.begin(async tx => { await tx.unsafe((await rollback()).replace(/^BEGIN;$/m, "").replace(/^COMMIT;$/m, "")); });
    await db.migrate();
    expect(await receivedContentUsage(db.sql, alice)).toEqual({ bytes: bytes.length, blobs: 1 });
    await expect(insert(alice, otherSender)).rejects.toThrow("migration-fenced");
    await expect(db.sql`DELETE FROM verified_body_provenance WHERE recipient_did=${alice}`).rejects.toThrow("migration-fenced");
    expect((await db.sql`SELECT hail_collect_received_blobs() AS n`)[0]!.n).toBe(0);
  });
});
