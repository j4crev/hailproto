import {beforeEach,expect,it,vi} from "vitest";
import {AccountApiError} from "../../../../packages/hail-client-support/src/account-api.js";
const {request}=vi.hoisted(()=>({request:vi.fn()}));
vi.mock("$lib/server/canary.js",()=>({canaryAccount:async()=>({account:{provider:"https://example.com"},client:{request}})}));
import {load} from "../routes/admin/+page.server.js";
beforeEach(()=>request.mockReset());
const event=(query="")=>({cookies:{},url:new URL(`https://example.com/admin${query}`)}) as Parameters<typeof load>[0];
it("loads the selected activity range and preserves invitations",async()=>{
  const invitations=[{id:"invitation"}],stats={range:"week",activity:[]};
  request.mockResolvedValueOnce({invitations}).mockResolvedValueOnce(stats).mockResolvedValueOnce({mode:"invite"});
  expect(await load(event("?range=week"))).toMatchObject({invitations,stats,range:"week",signupMode:"invite"});
  expect(request).toHaveBeenCalledWith("/stats?range=week",undefined,"/api/v1/operator");
});
it("defaults invalid ranges and keeps invitation tools available on temporary stats failure",async()=>{
  request.mockResolvedValueOnce({invitations:[]}).mockRejectedValueOnce(new AccountApiError(503)).mockResolvedValueOnce({mode:"public"});
  expect(await load(event("?range=invalid"))).toMatchObject({invitations:[],stats:null,range:"day",signupMode:"public"});
});
it("does not hide operator authorization failures",async()=>{
  request.mockResolvedValueOnce({invitations:[]}).mockRejectedValueOnce(new AccountApiError(403));
  await expect(load(event())).rejects.toMatchObject({status:403});
});
