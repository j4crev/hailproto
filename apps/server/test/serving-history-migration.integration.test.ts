import {createHash,randomBytes,randomUUID} from "node:crypto";
import {SQL} from "bun";
import {afterAll,beforeAll,describe,expect,it} from "vitest";
import {ProviderDatabase} from "../src/db/database.js";
import {AccountApiRepository,tokenHash} from "../src/accounts/repository.js";
import {encodeBase64Url} from "@hailproto/codec";

const integration=process.env.DATABASE_URL?describe:describe.skip;
integration("migration 36 serving metadata and immutable retirement history",()=>{
  let admin:SQL,db:ProviderDatabase,schema:string;
  beforeAll(async()=>{
    admin=new SQL(process.env.DATABASE_URL!);schema=`history_${randomUUID().replaceAll("-","")}`;
    await admin.unsafe(`CREATE SCHEMA "${schema}"`);
    const url=new URL(process.env.DATABASE_URL!);url.searchParams.set("options",`-csearch_path=${schema}`);
    db=new ProviderDatabase(url.toString());
    await db.sql`CREATE TABLE schema_migrations (version integer PRIMARY KEY,name text NOT NULL,checksum text NOT NULL,applied_at timestamptz NOT NULL DEFAULT now())`;
    const files=Array.from(new Bun.Glob("0*.sql").scanSync(new URL("../migrations/",import.meta.url).pathname)).sort();
    for(const file of files){const version=Number(file.slice(0,4));if(version>35)continue;
      const source=await Bun.file(new URL(`../migrations/${file}`,import.meta.url)).text();await db.sql.unsafe(source);
      await db.sql`INSERT INTO schema_migrations (version,name,checksum) VALUES (${version},${file},${createHash("sha256").update(source).digest("hex")})`;
    }
  });
  afterAll(async()=>{if(db)await db.close();if(admin){if(schema)await admin.unsafe(`DROP SCHEMA "${schema}" CASCADE`);await admin.close();}});
  const fingerprints=async()=>{
    const tables=await db.sql<{table_name:string}[]>`SELECT table_name FROM information_schema.tables WHERE table_schema=${schema} AND table_type='BASE TABLE'
      AND table_name NOT IN ('schema_migrations','account_serving_generations','provider_retired_transfer_history','account_credential_generations',
         'account_challenge_generations','serving_worker_leases','provider_retired_import_history','provider_transfer_abandonments','provider_retired_observation_history',
         'public_cutover_evidence','public_cutover_evidence_selection','public_plc_resolution_evidence','public_envelope_authority_evidence','public_grant_authority_evidence','public_signing_authority_evidence',
         'public_onboarding_preparations','public_onboarding_evidence','custody_transition_preparations','custody_transition_grant_successors') ORDER BY table_name`;
    const added:Record<string,string[]>={prepared_migration_target_keys:["custody_profile","identity_public_key","identity_private_ciphertext","identity_nonce"],
      provider_transfer_authorizations:["custody_profile","owner_recovery_public_key"],provider_migration_fences:["source_custody_profile","owner_recovery_public_key","source_identity_public_key","destination_identity_public_key"],
      provider_migration_exports:["custody_profile"],pending_migration_imports:["custody_profile","owner_recovery_public_key","source_identity_public_key","destination_identity_public_key"]};
    const result:Record<string,unknown>={};for(const {table_name} of tables){const keys=added[table_name]??[],row=keys.length?`to_jsonb(t) - ARRAY[${keys.map(key=>`'${key}'`).join(",")}]::text[]`:"to_jsonb(t)";
      const rows=await db.sql.unsafe(`SELECT count(*)::integer AS count,md5(COALESCE(jsonb_agg(${row} ORDER BY ${row}::text)::text,'[]')) AS digest FROM "${table_name}" t`);
      result[table_name]=rows[0];
    }return result;
  };
  const retired=async()=>{
    // Synthetic legacy rows exercise byte preservation; the complete-transfer fixture verifies real signed artifacts.
    const id=randomUUID(),did=`did:plc:${Array.from(randomBytes(24),b=>"abcdefghijklmnopqrstuvwxyz234567"[b%32]).join("")}`,transfer=randomUUID();
    const address=`history-${id}@source.example.com`,manifest=randomBytes(512),digest=new Uint8Array(createHash("sha256").update(manifest).digest()),signature=randomBytes(64);
    await db.sql`INSERT INTO provider_accounts (id,tenant_id,canonical_address,did,onboarding_state,activated_at,activation_binding_digest,activation_verification_mode)
      VALUES (${id},${randomUUID()},${address},${did},'active',now(),${randomBytes(32)},'public')`;
    const credential={token:`hailp_${encodeBase64Url(randomBytes(32))}`};
    await db.sql`INSERT INTO account_api_credentials (id,account_id,token_hash,scopes,expires_at)
      VALUES (${randomUUID()},${id},${tokenHash(credential.token)},'["account:read"]',clock_timestamp()+interval '30 days')`;
    await db.sql`INSERT INTO account_access_challenges (id,token_hash,payload,expires_at)
      VALUES (${randomUUID()},${randomBytes(32)},'{}',clock_timestamp()+interval '4 minutes')`;
    await db.sql`INSERT INTO provider_transfer_authorizations
      (did,nonce,destination_service_base,expires_at,grant_bytes,grant_signature,invitation_bytes,invitation_signature,consumed_transfer_id)
      VALUES (${did},${randomUUID()},'https://target.example.com/hail',now()+interval '1 hour',${randomBytes(200)},${randomBytes(64)},${randomBytes(200)},${randomBytes(64)},${transfer})`;
    await db.sql`INSERT INTO provider_migration_fences (did,account_id,transfer_id,destination_service_base,state,snapshot_digest)
      VALUES (${did},${id},${transfer},'https://target.example.com/hail','exported',${digest})`;
    await db.sql`INSERT INTO provider_migration_exports
      (transfer_id,did,manifest_bytes,manifest_digest,source_messaging_public_key,signature,signing_plc_document,signing_plc_data,signing_plc_operation_log)
      VALUES (${transfer},${did},${manifest},${digest},'fixture-public-key',${signature},'{}','{}','[]')`;
    await db.sql`UPDATE provider_migration_fences SET state='retired',retirement_receipt_bytes=${randomBytes(128)},retired_at=clock_timestamp() WHERE did=${did}`;
    return {id,did,transfer,manifest,signature,credential};
  };
  const legacyAuthenticate=async(token:string)=>(await db.sql`
    SELECT a.id,c.id AS credential_id,c.expires_at,a.did,a.canonical_address,c.scopes,f.state AS migration_state
    FROM account_api_credentials c JOIN provider_accounts a ON a.id=c.account_id LEFT JOIN provider_migration_fences f ON f.account_id=a.id
    WHERE c.token_hash=${tokenHash(token)} AND c.revoked_at IS NULL AND c.expires_at>now() AND a.onboarding_state='active'`)[0]??null;
  const apply36=async()=>{
    const source=await Bun.file(new URL("../migrations/0036_serving_lifecycle_history.sql",import.meta.url)).text();
    await db.sql.begin(async tx=>{await tx.unsafe(source);await tx`INSERT INTO schema_migrations (version,name,checksum)
      VALUES (36,'serving-lifecycle-history',${createHash("sha256").update(source).digest("hex")})`;});
  };
  const rollback=async(file="0036_serving_lifecycle_history.sql")=>{
    const connection=await db.sql.reserve();try {
      await connection.unsafe(await Bun.file(new URL(`../migrations/rollback/${file}`,import.meta.url)).text());
    }catch(error){await connection.unsafe("ROLLBACK");throw error;}finally{connection.release();}
  };
  it("preserves legacy rows and bearer access, captures future retirements, and refuses lossy rollback",async()=>{
    const original=await retired(),before=await fingerprints();
    const session=await legacyAuthenticate(original.credential.token);expect(session?.migration_state).toBe("retired");
    await apply36();expect(await fingerprints()).toEqual(before);
    expect(await legacyAuthenticate(original.credential.token)).toEqual(session);
    const history=await db.sql<{fence_record:Record<string,unknown>;export_record:Record<string,unknown>;authorization_record:Record<string,unknown>}[]>`
      SELECT fence_record,export_record,authorization_record FROM provider_retired_transfer_history WHERE transfer_id=${original.transfer}`;
    expect(history).toHaveLength(1);expect(history[0]!.fence_record.state).toBe("retired");
    expect(history[0]!.export_record.manifest_bytes).toBe(`\\x${Buffer.from(original.manifest).toString("hex")}`);
    expect(history[0]!.export_record.signature).toBe(`\\x${Buffer.from(original.signature).toString("hex")}`);
    expect(history[0]!.authorization_record.consumed_transfer_id).toBe(original.transfer);
    await db.sql`SELECT hail_archive_retired_transfer(f) FROM provider_migration_fences f WHERE did=${original.did}`;
    expect((await db.sql`SELECT transfer_id FROM provider_retired_transfer_history WHERE did=${original.did}`).length).toBe(1);
    await expect(db.sql`UPDATE provider_retired_transfer_history SET did=${original.did} WHERE transfer_id=${original.transfer}`).rejects.toThrow("immutable");
    await expect(db.sql`DELETE FROM provider_retired_transfer_history WHERE transfer_id=${original.transfer}`).rejects.toThrow("immutable");
    await expect(db.sql`TRUNCATE provider_retired_transfer_history`).rejects.toThrow("immutable");
    await expect(db.sql`UPDATE provider_migration_fences SET state='exported',retirement_receipt_bytes=NULL,retired_at=NULL WHERE did=${original.did}`).rejects.toThrow("cannot resume");
    await expect(db.sql`UPDATE provider_migration_fences SET destination_service_base='https://other.example.com/hail' WHERE did=${original.did}`).rejects.toThrow("immutable history");
    await expect(db.sql`UPDATE account_serving_generations SET generation=2 WHERE account_id=${original.id}`).rejects.toThrow();
    const future=await retired();expect((await db.sql`SELECT transfer_id FROM provider_retired_transfer_history WHERE transfer_id=${future.transfer}`).length).toBe(1);
    const projection=await db.sql<{generation:bigint}[]>`SELECT generation FROM account_serving_generations WHERE account_id=${future.id}`;expect(Number(projection[0]!.generation)).toBe(1);
    // An unchanged legacy importer still uses jsonb_populate_record(NULL, ...).
    const importedId=randomUUID(),importedDid=`did:plc:${"a".repeat(24)}`;
    const account=(await db.sql<{value:Record<string,unknown>}[]>`SELECT to_jsonb(a) AS value FROM provider_accounts a WHERE id=${original.id}`)[0]!.value;
    expect(account).not.toHaveProperty("generation");
    await db.sql`INSERT INTO provider_accounts SELECT * FROM jsonb_populate_record(NULL::provider_accounts,
      (${JSON.stringify({...account,id:importedId,tenant_id:randomUUID(),did:importedDid,canonical_address:`imported-${importedId}@target.example.com`})}::text)::jsonb)`;
    expect((await db.sql`SELECT account_id FROM account_serving_generations WHERE account_id=${importedId}`).length).toBe(1);
    await db.sql`UPDATE provider_migration_exports SET signature=${randomBytes(64)} WHERE transfer_id=${original.transfer}`;
    await expect(rollback()).rejects.toThrow("rollback refused");
    expect((await db.sql`SELECT transfer_id FROM provider_retired_transfer_history`).length).toBe(2);
    await db.sql`UPDATE provider_migration_exports SET signature=${original.signature} WHERE transfer_id=${original.transfer}`;
    const beforeRollback=await fingerprints();await rollback();expect(await fingerprints()).toEqual(beforeRollback);
    expect(await legacyAuthenticate(original.credential.token)).toEqual(session);
    expect((await db.sql`SELECT version FROM schema_migrations WHERE version=36`).length).toBe(0);
    await db.migrate();expect((await db.sql`SELECT transfer_id FROM provider_retired_transfer_history`).length).toBe(2);
    expect(await fingerprints()).toEqual(beforeRollback);
    const current=await new AccountApiRepository(db.sql).authenticate(`Bearer ${original.credential.token}`);expect(current?.serving_generation).toBe(1);
    await rollback("0051_did_monitor_coverage.sql");
    await rollback("0050_managed_profile_version.sql");
    await rollback("0049_managed_migration_materialization.sql");
    await rollback("0048_managed_migration_approval.sql");
    await rollback("0047_managed_provider_migration.sql");
    await rollback("0046_reverse_custody_transition.sql");
    await rollback("0045_same_provider_custody_transition.sql");
    await rollback("0044_public_onboarding.sql");
    await rollback("0043_public_signing_authority.sql");
    await rollback("0042_public_grant_authority.sql");
    await rollback("0041_public_plc_authority.sql");
    await rollback("0040_public_cutover_evidence.sql");
    await rollback("0039_transfer_abandonment.sql");
    await rollback("0037_generation_admission.sql");expect(await fingerprints()).toEqual(beforeRollback);
    expect(await legacyAuthenticate(original.credential.token)).toEqual(session);
    await db.migrate();expect(await fingerprints()).toEqual(beforeRollback);
  });
});
