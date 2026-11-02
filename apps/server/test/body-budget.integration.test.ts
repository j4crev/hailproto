import { randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import { ProviderDatabase } from "../src/db/database.js";
import { BodyRepository } from "../src/bodies/repository.js";
import { BODY_MAX_BYTES, bodyFromText, bodyDigest } from "../src/bodies/service.js";

it.skipIf(!process.env.DATABASE_URL)("expands every body store, preserves bytes through export/import, and refuses lossy rollback", async () => {
  const db = new ProviderDatabase(process.env.DATABASE_URL!);
  const rollback = await Bun.file(new URL("../migrations/rollback/0098_body_budget.sql", import.meta.url)).text();
  const did = `did:plc:${"a".repeat(24)}`, recipient = `did:plc:${"b".repeat(24)}`;
  try {
    await db.migrate();
    await db.sql.begin(async tx => { await tx.unsafe(rollback); });
    // Preserve an existing small received body through the expansion.
    const small = bodyFromText("Retained before expansion"), smallDigest = bodyDigest(small);
    await db.sql`INSERT INTO verified_body_provenance(recipient_did,sender_did,digest,media_type,profile,body_bytes)
      VALUES (${recipient},${did},${smallDigest},'application/hail-body+cbor','spt-1',${small})`;
    await db.migrate(); await db.migrate();
    expect(Buffer.from((await db.sql`SELECT body_bytes FROM verified_body_contents WHERE digest=${smallDigest}`)[0]!.body_bytes)).toEqual(Buffer.from(small));
    const framing = bodyFromText("x".repeat(300_000)).length - 300_000;
    const body = bodyFromText("x".repeat(BODY_MAX_BYTES - framing)), digest = bodyDigest(body);
    const account = randomUUID();
    await db.sql`INSERT INTO provider_accounts(id,tenant_id,canonical_address,did,onboarding_state,activated_at,activation_binding_digest,activation_verification_mode)
      VALUES (${account},${randomUUID()},'large@example.com',${did},'active',now(),${new Uint8Array(32).fill(3)},'public')`;
    expect((await new BodyRepository(db.sql).publish(did,body)).bytes).toEqual(body);
    await db.sql`INSERT INTO account_publications(account_id,id,sender_did,serving_generation,category,body_bytes,request_digest)
      VALUES (${account},${randomUUID()},${did},1,'updates',${body},${digest})`;
    await db.sql`INSERT INTO connection_message_batches(account_id,id,sender_did,serving_generation,body_bytes,manifest,request_digest)
      VALUES (${account},${randomUUID()},${did},1,${body},${new Uint8Array([0x80])},${digest})`;
    await db.sql`INSERT INTO verified_body_provenance(recipient_did,sender_did,digest,media_type,profile,body_bytes)
      VALUES (${recipient},${did},${digest},'application/hail-body+cbor','spt-1',${body})`;
    const portable = (await db.sql`SELECT to_jsonb(p) AS row FROM verified_body_contents p WHERE digest=${digest}`)[0]!.row;
    await db.sql`DELETE FROM verified_body_provenance WHERE digest=${digest}`;
    await db.sql.unsafe('INSERT INTO verified_body_provenance SELECT * FROM jsonb_populate_record(NULL::verified_body_provenance, ($1::text)::jsonb)', [JSON.stringify(portable)]);
    expect(Buffer.from((await db.sql`SELECT body_bytes FROM verified_body_contents WHERE digest=${digest}`)[0]!.body_bytes)).toEqual(Buffer.from(body));
    const oversized = new Uint8Array(BODY_MAX_BYTES + 1);
    await expect(db.sql`INSERT INTO verified_body_provenance(recipient_did,sender_did,digest,media_type,profile,body_bytes)
      VALUES (${recipient},${did},${bodyDigest(oversized)},'application/hail-body+cbor','spt-1',${oversized})`).rejects.toThrow("size or digest");
    await expect(db.sql.begin(async tx => { await tx.unsafe(rollback); })).rejects.toThrow("prevent rollback");
    expect((await db.sql`SELECT version FROM schema_migrations WHERE version=98`)).toHaveLength(1);
  } finally { await db.close(); }
}, 30_000);
