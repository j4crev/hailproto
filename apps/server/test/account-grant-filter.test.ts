import {expect,it,vi} from "vitest";
import {createApp} from "../src/app.js";
import type {AppConfig} from "../src/config.js";
import type {AccountApiRepository} from "../src/accounts/repository.js";
import type {GrantRepository} from "../src/grants/repository.js";
import type {GrantService} from "../src/grants/service.js";
it("validates sender filtering and retains account-scoped grant authorization",async()=>{
  const session={account_id:crypto.randomUUID(),scopes:["grants:read"],serving_generation:1};
  const listGrants=vi.fn(async()=>({grants:[],next:null}));
  const app=createApp({publicOrigin:"https://example.com",hailServiceBase:"https://example.com/hail",providerId:"test"} as AppConfig,
    {accountApi:{accounts:{authenticate:async()=>session,listGrants} as unknown as AccountApiRepository,grants:{} as GrantRepository,service:{} as GrantService},async checkReadiness(){return {ready:true};}});
  const sender=`did:plc:${"a".repeat(24)}`;
  const get=(query:string)=>app.request(`/api/v1/account/grants${query}`);
  expect((await get(`?sender=${sender}`)).status).toBe(200);
  expect(listGrants).toHaveBeenLastCalledWith(session,null,sender);
  expect((await get("")).status).toBe(200);expect(listGrants).toHaveBeenLastCalledWith(session,null,null);
  for(const query of ["?sender=bad",`?sender=${sender}&sender=${sender}`,"?after=bad",`?sender=${sender}&extra=1`])
    expect((await get(query)).status).toBe(400);
  session.scopes=[];expect((await get(`?sender=${sender}`)).status).toBe(403);
  expect(listGrants).toHaveBeenCalledTimes(2);
});
