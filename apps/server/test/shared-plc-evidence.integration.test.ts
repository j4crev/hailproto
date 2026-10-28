import { randomUUID } from "node:crypto";
import { SQL } from "bun";
import { expect, it } from "vitest";
import { ProviderDatabase } from "../src/db/database.js";
import { VerifiedPublicPlcResolver } from "../src/plc/public-resolver.js";
import { compactPublicEvidence } from "../src/plc/compact-evidence.js";
import { evidenceHash } from "../src/plc/read-evidence.js";
import { requireFreshPublicAuthority } from "../src/plc/authority.js";
import { publicPlcFixture, publicPlcReaders } from "./public-plc-fixture.js";

it.skipIf(!process.env.DATABASE_URL)("shares fresh observations, preserves exact portable bytes and links, compacts and rolls back losslessly", async () => {
  const admin = new SQL(process.env.DATABASE_URL!), schema = `shared_plc_${randomUUID().replaceAll("-", "")}`;
  await admin.unsafe(`CREATE SCHEMA "${schema}"`);
  const url = new URL(process.env.DATABASE_URL!); url.searchParams.set("options", `-csearch_path=${schema}`);
  const db = new ProviderDatabase(url.toString());
  try {
    await db.migrate();
    const fixture = await publicPlcFixture(), readers = publicPlcReaders([fixture]);
    let clock = Date.now();
    const resolver = new VerifiedPublicPlcResolver(db.sql, readers, ["provider"], ["https://local.example.com"], () => new Date(clock++));
    let resolved = await resolver.resolve(fixture.did);
    for (let i = 0; i < 19; i++) resolved = await resolver.resolve(fixture.did);
    expect((await db.sql`SELECT count(*)::int AS n FROM public_plc_shared_evidence`)[0]!.n).toBe(1);
    expect((await db.sql`SELECT count(*)::int AS n FROM public_plc_resolution_evidence WHERE bundle_bytes IS NULL`)[0]!.n).toBe(20);
    const rows = await db.sql`SELECT * FROM public_plc_resolution_contents ORDER BY evidence_digest`;
    for (const row of rows) expect(evidenceHash(row.bundle_bytes)).toEqual(new Uint8Array(row.evidence_digest));
    const [size] = await db.sql`SELECT
      (SELECT sum(octet_length(bundle_bytes)) FROM public_plc_resolution_contents)::int AS original,
      ((SELECT sum(octet_length(bundle_prefix)+octet_length(bundle_suffix)+32) FROM public_plc_resolution_evidence)
       +(SELECT sum(octet_length(payload_bytes)) FROM public_plc_shared_evidence))::int AS shared`;
    expect(size!.shared).toBeLessThan(size!.original * 0.3);
    console.info("PLC fixture logical bytes", { original: size!.original, shared: size!.shared });
    const digest = await requireFreshPublicAuthority(db.sql, resolved.evidence,
      { did: fixture.did, role: "hail-messaging", key: fixture.messaging.didKey }, new Date(clock));
    await expect(requireFreshPublicAuthority(db.sql, resolved.evidence,
      { did: fixture.did }, new Date(clock + 31_000))).rejects.toThrow("stale");
    await db.sql`INSERT INTO public_signing_authority_evidence(action_type,local_account_id,authority_did,authority_role,
      representation_digest,evidence_digest,committed_at) VALUES('sender-profile',${randomUUID()},${fixture.did},
      'hail-messaging',${new Uint8Array(32)},${digest!},now())`;
    await expect(db.sql`DELETE FROM public_plc_resolution_evidence`).rejects.toThrow("immutable");
    await expect(db.sql`UPDATE public_plc_resolution_evidence SET verified_at=now()`).rejects.toThrow("immutable");
    await expect(db.sql`UPDATE public_plc_resolution_evidence SET bundle_suffix=${new Uint8Array([0])}`).rejects.toThrow("digest mismatch");
    await expect(db.sql`DELETE FROM public_plc_shared_evidence`).rejects.toThrow("immutable");
    await expect(db.sql`TRUNCATE public_plc_shared_evidence CASCADE`).rejects.toThrow("immutable");

    // Portable rows retain exactly the pre-80 columns and self-contained bytes.
    const portable = await db.sql`SELECT to_jsonb(t) AS row FROM public_plc_resolution_contents t ORDER BY evidence_digest`;
    expect(Object.keys(portable[0]!.row).sort()).toEqual([
      "bundle_bytes", "did", "evidence_digest", "operation_cid", "read_evidence_policy_version", "record_version", "verified_at",
    ]);
    // Existing legacy import writers and duplicate retries still work.
    await db.sql.unsafe(`INSERT INTO public_plc_resolution_evidence SELECT * FROM
      jsonb_populate_record(NULL::public_plc_resolution_evidence, ($1::text)::jsonb) ON CONFLICT DO NOTHING`, [JSON.stringify(portable[0]!.row)]);
    const rollback = await Bun.file(new URL("../migrations/rollback/0080_shared_plc_evidence.sql", import.meta.url)).text();
    await db.sql.begin(async tx => { await tx.unsafe(rollback.replace(/^BEGIN;$/m, "").replace(/^COMMIT;$/m, "")); });
    expect(await db.sql`SELECT to_jsonb(t) AS row FROM public_plc_resolution_evidence t ORDER BY evidence_digest`).toEqual(portable);
    expect((await db.sql`SELECT count(*)::int AS n FROM public_signing_authority_evidence`)[0]!.n).toBe(1);
    await db.migrate();
    const estimate = await compactPublicEvidence(db.sql);
    expect(estimate.observations).toBe(20);
    expect(estimate.uniqueWitnessPayloads).toBe(1);
    expect((await db.sql`SELECT count(*)::int AS n FROM public_plc_shared_evidence`)[0]!.n).toBe(0);
    const applied = await compactPublicEvidence(db.sql, true);
    expect(applied.observations).toBe(20);
    expect((await compactPublicEvidence(db.sql, true)).observations).toBe(0);
    expect(await db.sql`SELECT to_jsonb(t) AS row FROM public_plc_resolution_contents t ORDER BY evidence_digest`).toEqual(portable);
    // Different readers do not collapse just because they report the same head.
    await new VerifiedPublicPlcResolver(db.sql, [readers[1]], ["provider"], ["https://local.example.com"])
      .resolve(fixture.did);
    expect((await db.sql`SELECT count(*)::int AS n FROM public_plc_shared_evidence`)[0]!.n).toBe(2);
    // Racing new observations share their payload under the unique digest guard.
    await Promise.all([resolver.resolve(fixture.did), resolver.resolve(fixture.did)]);
    expect((await db.sql`SELECT count(*)::int AS n FROM public_plc_shared_evidence`)[0]!.n).toBe(2);
  } finally {
    await db.close(); await admin.unsafe(`DROP SCHEMA "${schema}" CASCADE`); await admin.close();
  }
}, 30_000);
