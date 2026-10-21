import {createHash,randomBytes,randomUUID} from "node:crypto";
import {SQL} from "bun";
import {expect,it} from "vitest";
import {ProviderDatabase} from "../src/db/database.js";

it.skipIf(!process.env.DATABASE_URL)("migration 50 backfills and enforces frozen managed/read-evidence versions",async()=>{
  const admin=new SQL(process.env.DATABASE_URL!),schema=`profile_v1_${randomUUID().replaceAll("-","")}`;
  await admin.unsafe(`CREATE SCHEMA "${schema}"`);const url=new URL(process.env.DATABASE_URL!);
  url.searchParams.set("options",`-csearch_path=${schema}`);const db=new ProviderDatabase(url.toString());
  try {
    await db.sql`CREATE TABLE schema_migrations(version integer PRIMARY KEY,name text NOT NULL,checksum text NOT NULL,
      applied_at timestamptz NOT NULL DEFAULT now())`;
    const directory=new URL("../migrations/",import.meta.url);
    for(const name of Array.from(new Bun.Glob("0*.sql").scanSync(directory.pathname)).sort()) {
      const version=Number(name.slice(0,4));if(version>49)continue;
      const source=await Bun.file(new URL(name,directory)).text();await db.sql.unsafe(source);
      await db.sql`INSERT INTO schema_migrations(version,name,checksum) VALUES
        (${version},${name},${createHash("sha256").update(source).digest("hex")})`;
    }
    const account=randomUUID();await db.sql`INSERT INTO provider_accounts
      (id,tenant_id,canonical_address,did,onboarding_state,activated_at,activation_binding_digest,activation_verification_mode)
      VALUES(${account},${randomUUID()},'profile-v1@example.com',${`did:plc:${"a".repeat(24)}`},'active',now(),${randomBytes(32)},'public')`;
    await db.sql`INSERT INTO account_keys(account_id,role,algorithm,public_key,encrypted_private_key,encryption_nonce)
      VALUES(${account},'hail-identity','ed25519','did:key:zFixtureIdentity',${randomBytes(32)},${randomBytes(12)})`;
    await db.sql`INSERT INTO managed_custody_evidence
      (account_id,owner_recovery_public_key,provider_identity_public_key,verification_mode)
      VALUES(${account},'did:key:zFixtureOwner','did:key:zFixtureIdentity','poc-local')`;
    await db.sql`INSERT INTO public_plc_resolution_evidence(evidence_digest,did,operation_cid,verified_at,bundle_bytes)
      VALUES(${randomBytes(32)},${`did:plc:${"a".repeat(24)}`},'bafyreifixture',now(),${new Uint8Array([1])})`;
    await db.migrate();
    expect((await db.sql<{version:number}[]>`SELECT max(version)::integer AS version FROM schema_migrations`)[0]?.version).toBe(51);
    expect(await db.sql`SELECT account_id FROM managed_custody_evidence
      WHERE managed_profile_version='hail-managed-custody-v1'`).toHaveLength(1);
    expect(await db.sql`SELECT evidence_digest FROM public_plc_resolution_evidence
      WHERE record_version=1 AND read_evidence_policy_version='hail.plc-read-evidence-v1'`).toHaveLength(1);
    await expect(db.sql`UPDATE managed_custody_evidence SET managed_profile_version='future-profile'`).rejects.toThrow();
    await expect(db.sql`UPDATE public_plc_resolution_evidence SET read_evidence_policy_version='future-policy'`).rejects.toThrow();
    const connection=await db.sql.reserve();try {
      await connection.unsafe(await Bun.file(new URL("../migrations/rollback/0051_did_monitor_coverage.sql",import.meta.url)).text());
      await expect(connection.unsafe(await Bun.file(new URL("../migrations/rollback/0050_managed_profile_version.sql",import.meta.url)).text()))
        .rejects.toThrow("cannot remove frozen profile versions");
    }finally{await connection.unsafe("ROLLBACK");connection.release();}
  }finally{await db.close();await admin.unsafe(`DROP SCHEMA "${schema}" CASCADE`);await admin.close();}
},30_000);
