import { randomBytes, randomUUID } from "node:crypto";
import { SQL } from "bun";
import { expect, it } from "vitest";
import { ProviderDatabase } from "../src/db/database.js";
import { AccountApiRepository } from "../src/accounts/repository.js";

it.skipIf(!process.env.DATABASE_URL)("current schema preserves access and immutable cutover evidence, refusing digest-only activation", async () => {
  const admin = new SQL(process.env.DATABASE_URL!), schema = `evidence_${randomUUID().replaceAll("-", "")}`;
  await admin.unsafe(`CREATE SCHEMA "${schema}"`);
  const url = new URL(process.env.DATABASE_URL!); url.searchParams.set("options", `-csearch_path=${schema}`);
  const db = new ProviderDatabase(url.toString());
  try {
    await db.migrate();
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
    const fingerprint = async () => Promise.all([
      db.sql`SELECT to_jsonb(t) AS row FROM provider_accounts t ORDER BY id`,
      db.sql`SELECT to_jsonb(t) AS row FROM pending_migration_imports t ORDER BY transfer_id`,
      db.sql`SELECT to_jsonb(t) AS row FROM portable_cutover_observations t ORDER BY transfer_id`,
    ]);
    const before = await fingerprint(), session = await accounts.authenticate(`Bearer ${credential.token}`);
    await db.migrate(); await db.migrate();
    expect(await db.sql`SELECT id FROM account_signup_ceremonies`).toHaveLength(0);
    expect(await db.sql`SELECT id FROM account_grant_approvals`).toHaveLength(0);
    expect(await db.sql`SELECT id FROM account_publications`).toHaveLength(0);
    expect(await db.sql`SELECT message_id FROM publication_targets`).toHaveLength(0);
    expect(await db.sql`SELECT id FROM connection_invitations`).toHaveLength(0);
    expect(await db.sql`SELECT id FROM connection_approvals`).toHaveLength(0);
    expect(await db.sql`SELECT id FROM account_connections`).toHaveLength(0);
    expect(await fingerprint()).toEqual(before); expect(await accounts.authenticate(`Bearer ${credential.token}`)).toEqual(session);
    expect(await db.sql`SELECT evidence_digest FROM public_cutover_evidence`).toHaveLength(0);
    await expect(db.sql`UPDATE pending_migration_imports SET state='active',activated_at=now() WHERE transfer_id=${transfer}`).rejects.toThrow("retained evidence bundle");
    expect(await fingerprint()).toEqual(before);
    // Retention is guarded even before activation: an unconsumed verification
    // bundle can be the only record of the observation/signature/accepted state.
    await db.sql`INSERT INTO public_cutover_evidence(transfer_id,evidence_digest,did,operation_cid,manifest_digest,signed_operation_bytes,
      monitor_attestation_digest,verified_at,bundle_bytes,record_version,read_evidence_policy_version)
      VALUES(${transfer},${digest},${did},'bafkreifixture',${digest},${bytes},${digest},now(),${bytes},1,'hail.plc-read-evidence-v1')`;
    await expect(db.sql`UPDATE public_cutover_evidence SET bundle_bytes=${bytes}`).rejects.toThrow("immutable");
    await expect(db.sql`DELETE FROM public_cutover_evidence`).rejects.toThrow("immutable");
    await expect(db.sql`TRUNCATE public_cutover_evidence CASCADE`).rejects.toThrow("immutable");
    expect(await fingerprint()).toEqual(before);
    await db.sql`INSERT INTO public_cutover_evidence_selection(transfer_id,evidence_digest) VALUES(${transfer},${digest})`;
    await db.sql`DELETE FROM portable_cutover_observations WHERE transfer_id=${transfer}`;
    await db.sql`DELETE FROM pending_migration_imports WHERE transfer_id=${transfer}`;
    expect((await db.sql<{bundle_bytes:Uint8Array}[]>`SELECT bundle_bytes FROM public_cutover_evidence WHERE transfer_id=${transfer}`)[0]!.bundle_bytes).toEqual(bytes);
    expect(await db.sql`SELECT evidence_digest FROM public_cutover_evidence_selection WHERE transfer_id=${transfer}`).toHaveLength(1);
  } finally { await db.close(); await admin.unsafe(`DROP SCHEMA "${schema}" CASCADE`); await admin.close(); }
}, 30_000);
