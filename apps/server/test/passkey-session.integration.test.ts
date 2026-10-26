import {randomBytes,randomUUID} from "node:crypto";
import {SQL} from "bun";
import {describe,expect,it} from "vitest";
import {ProviderDatabase} from "../src/db/database.js";
import {AccountApiRepository,tokenHash} from "../src/accounts/repository.js";
import {encodeBase64Url} from "@hailproto/codec";
import {PasskeyAuth} from "../src/accounts/passkeys.js";

const integration=process.env.DATABASE_URL?describe:describe.skip;
integration("passkey session migration",()=>{
  it("preserves address-independent access, enforces expiry/generation, and rolls back safely",async()=>{
    const admin=new SQL(process.env.DATABASE_URL!),schema=`passkey_${randomUUID().replaceAll("-","")}`;
    await admin.unsafe(`CREATE SCHEMA "${schema}"`);const url=new URL(process.env.DATABASE_URL!);url.searchParams.set("options",`-csearch_path=${schema}`);
    const db=new ProviderDatabase(url.toString());
    try{
      await db.migrate();const account=randomUUID(),credential=encodeBase64Url(randomBytes(32)),otherCredential=encodeBase64Url(randomBytes(32)),sessionId=randomUUID(),token=`hails_${encodeBase64Url(randomBytes(32))}`;
      await db.sql`INSERT INTO provider_accounts(id,tenant_id,canonical_address,did,onboarding_state,activated_at,activation_binding_digest,activation_verification_mode)
        VALUES(${account},${randomUUID()},'before@example.com',${`did:plc:${"a".repeat(24)}`},'active',now(),${randomBytes(32)},'public')`;
      await db.sql`INSERT INTO account_passkeys(credential_id,account_id,serving_generation,public_key,device_type,backed_up,label)
        VALUES(${credential},${account},1,${randomBytes(64)},'multiDevice',true,'Primary')`;
      await db.sql`INSERT INTO account_passkeys(credential_id,account_id,serving_generation,public_key,device_type,backed_up,label)
        VALUES(${otherCredential},${account},1,${randomBytes(64)},'singleDevice',false,'Backup')`;
      await db.sql`INSERT INTO account_passkey_sessions(id,token_hash,account_id,credential_id,serving_generation,scopes,expires_at)
        VALUES(${sessionId},${tokenHash(token)},${account},${credential},1,'["account:read","grants:read","messages:read","messages:write"]',now()+interval '12 hours')`;
      const accounts=new AccountApiRepository(db.sql),authenticated=(await accounts.authenticate(undefined,token))!;
      expect(authenticated.canonical_address).toBe("before@example.com");expect(authenticated.passkey_credential_id).toBe(credential);
      const passkeys=new PasskeyAuth(db.sql,"example.com","https://example.com");
      expect((await passkeys.list(authenticated)).passkeys).toHaveLength(2);
      expect((await passkeys.list(authenticated)).sessions).toEqual([expect.objectContaining({id:sessionId,current:true,label:"Primary"})]);
      const secondId=randomUUID(),secondToken=`hails_${encodeBase64Url(randomBytes(32))}`;
      await db.sql`INSERT INTO account_passkey_sessions(id,token_hash,account_id,credential_id,serving_generation,scopes,expires_at)
        VALUES(${secondId},${tokenHash(secondToken)},${account},${credential},1,
        '["account:read","grants:read","messages:read","messages:write"]',now()+interval '12 hours')`;
      expect((await passkeys.list(authenticated)).sessions).toHaveLength(2);
      await passkeys.revokeSessions(authenticated,[secondId]);
      expect(await accounts.authenticate(undefined,secondToken)).toBeNull();
      expect(await accounts.authenticate(undefined,token)).not.toBeNull();
      expect((await passkeys.list(authenticated)).sessions.map(item=>item.id)).toEqual([sessionId]);
      await db.sql`DELETE FROM account_passkey_sessions WHERE id=${secondId}`;
      await passkeys.rename(authenticated,otherCredential,"Hardware key");await passkeys.revoke(authenticated,otherCredential);
      expect((await passkeys.list(authenticated)).passkeys.map(key=>key.label)).toEqual(["Primary"]);
      await db.sql`UPDATE provider_accounts SET canonical_address='after@example.com' WHERE id=${account}`;
      expect((await accounts.authenticate(undefined,token))?.canonical_address).toBe("after@example.com");
      await db.sql`UPDATE account_passkey_sessions SET last_seen_at=now()-interval '31 minutes' WHERE id=${sessionId}`;
      expect(await accounts.authenticate(undefined,token)).toBeNull();
      await db.sql`UPDATE account_passkey_sessions SET last_seen_at=now() WHERE id=${sessionId}`;
      await db.sql.begin(async tx=>{await tx`SELECT set_config('hail.returning_account',${account},true)`;
        await tx`UPDATE account_serving_generations SET generation=2 WHERE account_id=${account}`;});
      expect(await accounts.authenticate(undefined,token)).toBeNull();
      const rollback=await db.sql.reserve();try{
        await expect(rollback.unsafe(await Bun.file(new URL("../migrations/rollback/0054_passkey_sessions.sql",import.meta.url)).text())).rejects.toThrow("active passkey access");
        await rollback.unsafe("ROLLBACK");
      }finally{rollback.release();}
      const browserRollback=await db.sql.reserve();try{
        for(const file of ["0072_retired_connection_peers.sql","0071_connection_transfer_orchestration.sql",
          "0070_unified_connections.sql","0069_connection_reconstruction.sql","0068_connection_handover_barriers.sql",
          "0067_connection_proof_authority.sql","0066_connection_handover_preparations.sql"]){
          await browserRollback.unsafe(await Bun.file(new URL(`../migrations/rollback/${file}`,import.meta.url)).text());
        }
        await browserRollback.unsafe(await Bun.file(new URL("../migrations/rollback/0065_connection_messages.sql",import.meta.url)).text());
        await browserRollback.unsafe(await Bun.file(new URL("../migrations/rollback/0064_connection_federation.sql",import.meta.url)).text());
        await browserRollback.unsafe(await Bun.file(new URL("../migrations/rollback/0063_connection_owner_signing.sql",import.meta.url)).text());
        await browserRollback.unsafe(await Bun.file(new URL("../migrations/rollback/0062_connection_preview.sql",import.meta.url)).text());
        await browserRollback.unsafe(await Bun.file(new URL("../migrations/rollback/0061_publications.sql",import.meta.url)).text());
        await browserRollback.unsafe(await Bun.file(new URL("../migrations/rollback/0060_provider_role_addresses.sql",import.meta.url)).text());
        await browserRollback.unsafe(await Bun.file(new URL("../migrations/rollback/0059_grant_approvals.sql",import.meta.url)).text());
        await browserRollback.unsafe(await Bun.file(new URL("../migrations/rollback/0058_signup_ceremonies.sql",import.meta.url)).text());
        await browserRollback.unsafe(await Bun.file(new URL("../migrations/rollback/0057_alpha_monitoring.sql",import.meta.url)).text());
        await browserRollback.unsafe(await Bun.file(new URL("../migrations/rollback/0056_browser_authorization.sql",import.meta.url)).text());
      }finally{browserRollback.release();}
      await db.sql`INSERT INTO account_passkey_sessions(id,token_hash,account_id,credential_id,serving_generation,scopes,expires_at)
        VALUES(${randomUUID()},${randomBytes(32)},${account},${credential},1,'["account:read","grants:read","messages:read","messages:write"]',now()+interval '12 hours')`;
      await passkeys.revokeSessions(authenticated);
      expect((await db.sql<{count:number}[]>`SELECT count(*)::integer AS count FROM account_passkey_sessions
        WHERE account_id=${account} AND revoked_at IS NOT NULL`)[0]?.count).toBe(2);
      await db.sql`UPDATE account_passkeys SET revoked_at=now() WHERE account_id=${account}`;
      const capability=randomUUID();await db.sql`INSERT INTO account_passkey_enrollment_capabilities
        (id,token_hash,account_id,serving_generation,expires_at) VALUES(${capability},${randomBytes(32)},${account},2,now()+interval '5 minutes')`;
      const guarded=await db.sql.reserve();try{
        await expect(guarded.unsafe(await Bun.file(new URL("../migrations/rollback/0055_passkey_recovery.sql",import.meta.url)).text())).rejects.toThrow("active passkey recovery");
        await guarded.unsafe("ROLLBACK");
      }finally{guarded.release();}
      await db.sql`UPDATE account_passkey_enrollment_capabilities SET consumed_at=now(),credential_id=${credential} WHERE id=${capability}`;
      const allowed=await db.sql.reserve();try{
        await allowed.unsafe(await Bun.file(new URL("../migrations/rollback/0055_passkey_recovery.sql",import.meta.url)).text());
        await allowed.unsafe(await Bun.file(new URL("../migrations/rollback/0054_passkey_sessions.sql",import.meta.url)).text());
      }finally{allowed.release();}
      expect((await db.sql`SELECT version FROM schema_migrations WHERE version IN (54,55)`).length).toBe(0);
      await db.migrate();expect((await db.sql`SELECT credential_id FROM account_passkeys`).length).toBe(0);
    }finally{await db.close();await admin.unsafe(`DROP SCHEMA "${schema}" CASCADE`);await admin.close();}
  });
});
