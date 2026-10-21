import { createHash, randomBytes, randomUUID } from "node:crypto";
import { SQL } from "bun";
import { expect, it } from "vitest";
import { ProviderDatabase } from "../src/db/database.js";
import { AccountApiRepository } from "../src/accounts/repository.js";

it.skipIf(!process.env.DATABASE_URL)("migration 40 preserves legacy rows/auth and refuses evidence loss or digest-only public activation", async () => {
  const admin = new SQL(process.env.DATABASE_URL!), schema = `evidence_${randomUUID().replaceAll("-", "")}`;
  await admin.unsafe(`CREATE SCHEMA "${schema}"`);
  const url = new URL(process.env.DATABASE_URL!); url.searchParams.set("options", `-csearch_path=${schema}`);
  const db = new ProviderDatabase(url.toString());
  const rollback = async () => {
    const connection = await db.sql.reserve();
    try {
      if((await connection`SELECT version FROM schema_migrations WHERE version=51`).length)await connection.unsafe(await Bun.file(new URL("../migrations/rollback/0051_did_monitor_coverage.sql",import.meta.url)).text());
      if((await connection`SELECT version FROM schema_migrations WHERE version=50`).length)await connection.unsafe(await Bun.file(new URL("../migrations/rollback/0050_managed_profile_version.sql",import.meta.url)).text());
      if((await connection`SELECT version FROM schema_migrations WHERE version=49`).length)await connection.unsafe(await Bun.file(new URL("../migrations/rollback/0049_managed_migration_materialization.sql",import.meta.url)).text());
      if((await connection`SELECT version FROM schema_migrations WHERE version=48`).length)await connection.unsafe(await Bun.file(new URL("../migrations/rollback/0048_managed_migration_approval.sql",import.meta.url)).text());
      if((await connection`SELECT version FROM schema_migrations WHERE version=47`).length)await connection.unsafe(await Bun.file(new URL("../migrations/rollback/0047_managed_provider_migration.sql",import.meta.url)).text());
      if((await connection`SELECT version FROM schema_migrations WHERE version=46`).length)await connection.unsafe(await Bun.file(new URL("../migrations/rollback/0046_reverse_custody_transition.sql",import.meta.url)).text());
      if((await connection`SELECT version FROM schema_migrations WHERE version=45`).length)await connection.unsafe(await Bun.file(new URL("../migrations/rollback/0045_same_provider_custody_transition.sql",import.meta.url)).text());
      if((await connection`SELECT version FROM schema_migrations WHERE version=44`).length)await connection.unsafe(await Bun.file(new URL("../migrations/rollback/0044_public_onboarding.sql",import.meta.url)).text());
      if((await connection`SELECT version FROM schema_migrations WHERE version=43`).length)await connection.unsafe(await Bun.file(new URL("../migrations/rollback/0043_public_signing_authority.sql",import.meta.url)).text());
      if((await connection`SELECT version FROM schema_migrations WHERE version=42`).length)await connection.unsafe(await Bun.file(new URL("../migrations/rollback/0042_public_grant_authority.sql",import.meta.url)).text());
      if((await connection`SELECT version FROM schema_migrations WHERE version=41`).length)await connection.unsafe(await Bun.file(new URL("../migrations/rollback/0041_public_plc_authority.sql",import.meta.url)).text());
      await connection.unsafe(await Bun.file(new URL("../migrations/rollback/0040_public_cutover_evidence.sql", import.meta.url)).text());
    }
    catch (error) { await connection.unsafe("ROLLBACK"); throw error; }
    finally { connection.release(); }
  };
  try {
    await db.sql`CREATE TABLE schema_migrations(version integer PRIMARY KEY,name text NOT NULL,checksum text NOT NULL,applied_at timestamptz NOT NULL DEFAULT now())`;
    const directory = new URL("../migrations/", import.meta.url);
    for (const name of Array.from(new Bun.Glob("0*.sql").scanSync(directory.pathname)).sort()) {
      const version = Number(name.slice(0, 4)); if (version > 39) continue;
      const source = await Bun.file(new URL(name, directory)).text(); await db.sql.unsafe(source);
      await db.sql`INSERT INTO schema_migrations(version,name,checksum) VALUES(${version},${name},${createHash("sha256").update(source).digest("hex")})`;
    }
    const id = randomUUID(), did = `did:plc:${"a".repeat(24)}`, transfer = randomUUID(), bytes = randomBytes(256), digest = randomBytes(32);
    const address = `evidence-${id}@source.example.com`;
    await db.sql`INSERT INTO provider_accounts(id,tenant_id,canonical_address,did,onboarding_state,activated_at,activation_binding_digest,activation_verification_mode)
      VALUES(${id},${randomUUID()},${address},${did},'active',now(),${randomBytes(32)},'public')`;
    const accounts = new AccountApiRepository(db.sql), credential = await accounts.issue(address);
    await db.sql`INSERT INTO pending_migration_imports(transfer_id,did,source_service_base,destination_service_base,manifest_bytes,
      manifest_digest,source_messaging_public_key,signature,state,verified_plc_document,verified_plc_data,verified_plc_operation_log,signed_plc_operation_bytes)
      VALUES(${transfer},${did},'https://source.example.com/hail','https://target.example.com/hail',${bytes},${digest},'fixture-key',${randomBytes(64)},
        'staged','{}','{}','[]',${bytes})`;
    await db.sql`INSERT INTO portable_cutover_observations(transfer_id,did,operation_cid,first_seen_at,last_seen_at,mirror_origins,monitor_attestation_digest,state,assessment_profile)
      VALUES(${transfer},${did},'bafkreifixture',now(),now(),'["https://reader.example.com"]',${digest},'eligible','public')`;
    const fingerprint = async () => {
      const added: Record<string, string[]> = {
        prepared_migration_target_keys: ["custody_profile", "identity_public_key", "identity_private_ciphertext", "identity_nonce"],
        provider_transfer_authorizations: ["custody_profile", "owner_recovery_public_key"],
        provider_migration_fences: ["source_custody_profile", "owner_recovery_public_key", "source_identity_public_key", "destination_identity_public_key"],
        provider_migration_exports: ["custody_profile"],
        pending_migration_imports: ["custody_profile", "owner_recovery_public_key", "source_identity_public_key", "destination_identity_public_key"],
      };
      const tables = await db.sql<{table_name:string}[]>`SELECT table_name FROM information_schema.tables
        WHERE table_schema=${schema} AND table_type='BASE TABLE' AND table_name NOT IN ('schema_migrations','public_cutover_evidence','public_cutover_evidence_selection',
          'public_plc_resolution_evidence','public_envelope_authority_evidence','public_grant_authority_evidence','public_signing_authority_evidence',
          'public_onboarding_preparations','public_onboarding_evidence','custody_transition_preparations','custody_transition_grant_successors') ORDER BY table_name`;
      return Promise.all(tables.map(async ({table_name}) => {
        const keys = added[table_name] ?? [];
        const row = keys.length
          ? `to_jsonb(t) - ARRAY[${keys.map((key) => `'${key}'`).join(",")}]::text[]`
          : "to_jsonb(t)";
        return JSON.stringify(await db.sql.unsafe(
          `SELECT count(*)::integer AS count, md5(COALESCE(jsonb_agg(${row} ORDER BY (${row})::text)::text,'[]')) AS digest FROM "${table_name}" t`));
      }));
    };
    const before = await fingerprint(), session = await accounts.authenticate(`Bearer ${credential.token}`);
    await db.migrate(); await db.migrate();
    expect(await fingerprint()).toEqual(before); expect(await accounts.authenticate(`Bearer ${credential.token}`)).toEqual(session);
    expect(await db.sql`SELECT evidence_digest FROM public_cutover_evidence`).toHaveLength(0);
    await expect(db.sql`UPDATE pending_migration_imports SET state='active',activated_at=now() WHERE transfer_id=${transfer}`).rejects.toThrow("retained evidence bundle");
    expect(await fingerprint()).toEqual(before);
    await rollback(); expect(await fingerprint()).toEqual(before);
    // A migration-39 writer retains its old behavior on a truly rolled-back schema.
    await db.sql`UPDATE pending_migration_imports SET state='active',activated_at=now() WHERE transfer_id=${transfer}`;
    const oldActive = await fingerprint();
    await db.migrate(); expect(await fingerprint()).toEqual(oldActive);
    expect(await db.sql`SELECT evidence_digest FROM public_cutover_evidence`).toHaveLength(0);
    expect(await accounts.authenticate(`Bearer ${credential.token}`)).toEqual(session);
    // Retention is guarded even before activation: an unconsumed verification
    // bundle can be the only record of the observation/signature/accepted state.
    await db.sql`INSERT INTO public_cutover_evidence(transfer_id,evidence_digest,did,operation_cid,manifest_digest,signed_operation_bytes,
      monitor_attestation_digest,verified_at,bundle_bytes,record_version,read_evidence_policy_version)
      VALUES(${transfer},${digest},${did},'bafkreifixture',${digest},${bytes},${digest},now(),${bytes},1,'hail.plc-read-evidence-v1')`;
    await expect(rollback()).rejects.toThrow("cannot remove frozen profile versions");
    await expect(db.sql`UPDATE public_cutover_evidence SET bundle_bytes=${bytes}`).rejects.toThrow("immutable");
    await expect(db.sql`DELETE FROM public_cutover_evidence`).rejects.toThrow("immutable");
    await expect(db.sql`TRUNCATE public_cutover_evidence CASCADE`).rejects.toThrow("immutable");
    expect(await fingerprint()).toEqual(oldActive);
    await db.sql`INSERT INTO public_cutover_evidence_selection(transfer_id,evidence_digest) VALUES(${transfer},${digest})`;
    await db.sql`DELETE FROM portable_cutover_observations WHERE transfer_id=${transfer}`;
    await db.sql`DELETE FROM pending_migration_imports WHERE transfer_id=${transfer}`;
    expect((await db.sql<{bundle_bytes:Uint8Array}[]>`SELECT bundle_bytes FROM public_cutover_evidence WHERE transfer_id=${transfer}`)[0]!.bundle_bytes).toEqual(bytes);
    expect(await db.sql`SELECT evidence_digest FROM public_cutover_evidence_selection WHERE transfer_id=${transfer}`).toHaveLength(1);
  } finally { await db.close(); await admin.unsafe(`DROP SCHEMA "${schema}" CASCADE`); await admin.close(); }
}, 30_000);
