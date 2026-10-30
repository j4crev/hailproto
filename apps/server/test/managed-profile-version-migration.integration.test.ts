import {randomBytes,randomUUID} from "node:crypto";
import {SQL} from "bun";
import {expect,it} from "vitest";
import {ProviderDatabase} from "../src/db/database.js";
import {VerifiedPublicPlcResolver} from "../src/plc/public-resolver.js";
import {publicPlcFixture,publicPlcReaders} from "./public-plc-fixture.js";

it.skipIf(!process.env.DATABASE_URL)("current schema requires explicit supported managed/read-evidence versions",async()=>{
  const admin=new SQL(process.env.DATABASE_URL!),schema=`profile_v1_${randomUUID().replaceAll("-","")}`;
  await admin.unsafe(`CREATE SCHEMA "${schema}"`);const url=new URL(process.env.DATABASE_URL!);
  url.searchParams.set("options",`-csearch_path=${schema}`);const db=new ProviderDatabase(url.toString());
  try {
    await db.migrate();
    const account=randomUUID();await db.sql`INSERT INTO provider_accounts
      (id,tenant_id,canonical_address,did,onboarding_state,activated_at,activation_binding_digest,activation_verification_mode)
      VALUES(${account},${randomUUID()},'profile-v1@example.com',${`did:plc:${"a".repeat(24)}`},'active',now(),${randomBytes(32)},'public')`;
    await db.sql`INSERT INTO account_keys(account_id,role,algorithm,public_key,encrypted_private_key,encryption_nonce)
      VALUES(${account},'hail-identity','ed25519','did:key:zFixtureIdentity',${randomBytes(32)},${randomBytes(12)})`;
    await db.sql`INSERT INTO managed_custody_evidence
      (account_id,owner_recovery_public_key,provider_identity_public_key,verification_mode,managed_profile_version)
      VALUES(${account},'did:key:zFixtureOwner','did:key:zFixtureIdentity','poc-local','hail-managed-custody-v1')`;
    const fixture=await publicPlcFixture();
    await new VerifiedPublicPlcResolver(db.sql,publicPlcReaders([fixture]),["provider"],["https://local.example.com"]).resolve(fixture.did);
    await db.migrate();
    expect(await db.sql`SELECT account_id FROM managed_custody_evidence
      WHERE managed_profile_version='hail-managed-custody-v1'`).toHaveLength(1);
    expect(await db.sql`SELECT evidence_digest FROM public_plc_resolution_evidence
      WHERE record_version=1 AND read_evidence_policy_version='hail.plc-read-evidence-v1'`).toHaveLength(1);
    await expect(db.sql`UPDATE managed_custody_evidence SET managed_profile_version='future-profile'`).rejects.toThrow();
    await expect(db.sql`UPDATE public_plc_resolution_evidence SET read_evidence_policy_version='future-policy'`).rejects.toThrow();

  }finally{await db.close();await admin.unsafe(`DROP SCHEMA "${schema}" CASCADE`);await admin.close();}
},30_000);
