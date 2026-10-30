import {randomBytes,randomUUID} from "node:crypto";
import {SQL} from "bun";
import {describe,expect,it} from "vitest";
import {ProviderDatabase} from "../src/db/database.js";
import {AccountApiRepository,tokenHash} from "../src/accounts/repository.js";
import {encodeBase64Url} from "@hailproto/codec";
import {PasskeyAuth} from "../src/accounts/passkeys.js";

const integration=process.env.DATABASE_URL?describe:describe.skip;
integration("current-schema passkey sessions",()=>{
  it("preserves address-independent access and enforces expiry, generation and revocation",async()=>{
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
      await db.migrate();
      expect(await accounts.authenticate(undefined,token)).toBeNull();
      expect(await db.sql`SELECT credential_id FROM account_passkeys WHERE account_id=${account} AND revoked_at IS NOT NULL`).toHaveLength(2);
      expect((await db.sql`SELECT consumed_at FROM account_passkey_enrollment_capabilities WHERE id=${capability}`)[0]!.consumed_at).not.toBeNull();

    }finally{await db.close();await admin.unsafe(`DROP SCHEMA "${schema}" CASCADE`);await admin.close();}
  });
});
