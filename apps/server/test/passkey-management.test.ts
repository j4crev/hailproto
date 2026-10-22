import {describe,expect,it,vi} from "vitest";
import type {SQL} from "bun";
import {PasskeyAuth,PasskeyError} from "../src/accounts/passkeys.js";
import type {AccountApiSession} from "../src/accounts/repository.js";

const current="current",other="other",session:AccountApiSession={account_id:"00000000-0000-4000-8000-000000000001",
  credential_id:"00000000-0000-4000-8000-000000000002",credential_expires_at:new Date(Date.now()+60_000),
  did:`did:plc:${"a".repeat(24)}`,canonical_address:"canary@haili.app",scopes:["account:read"],migration_state:null,
  serving_generation:1,passkey_credential_id:current,passkey_verified_at:new Date()};

function service(keys:string[]){
  type Query=((strings:TemplateStringsArray,...values:unknown[])=>Promise<{credential_id:string}[]>)&
    {begin(callback:(tx:SQL)=>Promise<unknown>):Promise<unknown>};
  const statements:string[]=[],query=vi.fn(async(strings:TemplateStringsArray)=>{
    const text=strings.join("?");statements.push(text);
    return text.startsWith("SELECT credential_id")?keys.map(credential_id=>({credential_id})):[];
  }) as unknown as Query;
  query.begin=async callback=>callback(query as unknown as SQL);
  return {passkeys:new PasskeyAuth(query as unknown as SQL,"haili.app","https://haili.app"),statements};
}

describe("passkey management",()=>{
  it("requires recent verification and preserves the current and final passkeys",async()=>{
    const stale=service([current,other]).passkeys;
    await expect(stale.revoke({...session,passkey_verified_at:new Date(Date.now()-301_000)},other)).rejects.toMatchObject({status:403});
    await expect(service([current,other]).passkeys.revoke(session,current)).rejects.toMatchObject({status:409});
    await expect(service([current]).passkeys.revoke({...session,scopes:["credentials:write"],passkey_credential_id:null},current))
      .rejects.toBeInstanceOf(PasskeyError);
  });

  it("revokes another passkey and its sessions atomically",async()=>{
    const {passkeys,statements}=service([current,other]);
    await expect(passkeys.revoke(session,other)).resolves.toEqual({revoked:true});
    expect(statements.filter(statement=>statement.startsWith("UPDATE"))).toHaveLength(2);
  });

  it("requires recent verification before revoking every account session",async()=>{
    await expect(service([]).passkeys.revokeSessions({...session,passkey_verified_at:new Date(Date.now()-301_000)}))
      .rejects.toMatchObject({status:403});
    const {passkeys,statements}=service([]);await expect(passkeys.revokeSessions(session)).resolves.toEqual({revoked:true});
    expect(statements.some(statement=>statement.includes("UPDATE account_passkey_sessions"))).toBe(true);
  });
});
