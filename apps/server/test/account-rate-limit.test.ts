import {Hono} from "hono";
import {expect,it,vi} from "vitest";
import {registerAccountApiRoutes} from "../src/accounts/routes.js";
import type {AccountApiRepository} from "../src/accounts/repository.js";

it("keeps anonymous traffic out of an authenticated account budget",async()=>{
  const accountId="00000000-0000-4000-8000-000000000001",session={account_id:accountId,canonical_address:"user@example.com",
    did:`did:plc:${"a".repeat(24)}`,scopes:["account:read"],credential_id:"credential",credential_expires_at:new Date(Date.now()+60_000),
    migration_state:null,serving_generation:1,passkey_credential_id:null,passkey_verified_at:null},accounts={
      authenticate:vi.fn(async(header?:string)=>header?session:null),describe:vi.fn(async()=>({type:"hailp.account"}))};
  const app=new Hono();registerAccountApiRoutes(app,accounts as unknown as AccountApiRepository,{} as never,{} as never,"https://example.com");
  const headers={"X-Hail-Trusted-Client-IP":"192.0.2.1"};
  for(let request=0;request<120;request++)expect((await app.request("/api/v1/account",{headers})).status).toBe(401);
  expect((await app.request("/api/v1/account",{headers})).status).toBe(429);
  expect((await app.request("/api/v1/account",{headers:{...headers,Authorization:"Bearer hailp_"+"A".repeat(43)}})).status).toBe(200);
});
