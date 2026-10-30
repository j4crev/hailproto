import {createHash,randomBytes,randomUUID} from "node:crypto";
import {SQL} from "bun";
import {afterAll,beforeAll,describe,expect,it} from "vitest";
import {ProviderDatabase} from "../src/db/database.js";
import {AccountApiRepository,tokenHash} from "../src/accounts/repository.js";
import {encodeBase64Url} from "@hailproto/codec";

const integration=process.env.DATABASE_URL?describe:describe.skip;
integration("current-schema serving metadata and immutable retirement history",()=>{
  let admin:SQL,db:ProviderDatabase,schema:string;
  beforeAll(async()=>{
    admin=new SQL(process.env.DATABASE_URL!);schema=`history_${randomUUID().replaceAll("-","")}`;
    await admin.unsafe(`CREATE SCHEMA "${schema}"`);
    const url=new URL(process.env.DATABASE_URL!);url.searchParams.set("options",`-csearch_path=${schema}`);
    db=new ProviderDatabase(url.toString());
    await db.migrate();
  });
  afterAll(async()=>{if(db)await db.close();if(admin){if(schema)await admin.unsafe(`DROP SCHEMA "${schema}" CASCADE`);await admin.close();}});
  const retired=async()=>{
    // Synthetic current-schema rows exercise archival byte preservation; full transfers verify signed artifacts.
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
  it("archives exact retired state, rejects mutation and preserves it across restart",async()=>{
    const original=await retired();
    const history=await db.sql<{fence_record:Record<string,unknown>;export_record:Record<string,unknown>;authorization_record:Record<string,unknown>}[]>`
      SELECT fence_record,export_record,authorization_record FROM provider_retired_transfer_history WHERE transfer_id=${original.transfer}`;
    expect(history).toHaveLength(1);expect(history[0]!.fence_record.state).toBe("retired");
    expect(history[0]!.export_record.manifest_bytes).toBe(`\\x${Buffer.from(original.manifest).toString("hex")}`);
    expect(history[0]!.export_record.signature).toBe(`\\x${Buffer.from(original.signature).toString("hex")}`);
    expect(history[0]!.authorization_record.consumed_transfer_id).toBe(original.transfer);
    await db.sql`SELECT hail_archive_retired_transfer(f) FROM provider_migration_fences f WHERE did=${original.did}`;
    expect(await db.sql`SELECT transfer_id FROM provider_retired_transfer_history WHERE did=${original.did}`).toHaveLength(1);
    await expect(db.sql`UPDATE provider_retired_transfer_history SET did=${original.did} WHERE transfer_id=${original.transfer}`).rejects.toThrow("immutable");
    await expect(db.sql`DELETE FROM provider_retired_transfer_history WHERE transfer_id=${original.transfer}`).rejects.toThrow("immutable");
    await expect(db.sql`TRUNCATE provider_retired_transfer_history`).rejects.toThrow("immutable");
    await expect(db.sql`UPDATE provider_migration_fences SET state='exported',retirement_receipt_bytes=NULL,retired_at=NULL WHERE did=${original.did}`).rejects.toThrow("cannot resume");
    await expect(db.sql`UPDATE provider_migration_fences SET destination_service_base='https://other.example.com/hail' WHERE did=${original.did}`).rejects.toThrow("immutable history");
    await expect(db.sql`UPDATE account_serving_generations SET generation=2 WHERE account_id=${original.id}`).rejects.toThrow();
    const future=await retired();
    expect(await db.sql`SELECT transfer_id FROM provider_retired_transfer_history WHERE transfer_id=${future.transfer}`).toHaveLength(1);
    expect(Number((await db.sql`SELECT generation FROM account_serving_generations WHERE account_id=${future.id}`)[0]!.generation)).toBe(1);
    const accounts=new AccountApiRepository(db.sql),session=await accounts.authenticate(`Bearer ${original.credential.token}`);
    expect(session?.serving_generation).toBe(1);
    const before=await db.sql`SELECT to_jsonb(t) AS row FROM provider_retired_transfer_history t ORDER BY transfer_id`;
    await db.migrate();await db.migrate();
    expect(await db.sql`SELECT to_jsonb(t) AS row FROM provider_retired_transfer_history t ORDER BY transfer_id`).toEqual(before);
    expect(await accounts.authenticate(`Bearer ${original.credential.token}`)).toEqual(session);
  });
});
