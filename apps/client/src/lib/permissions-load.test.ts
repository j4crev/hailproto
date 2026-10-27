import {beforeEach, expect, it, vi} from "vitest";
const fixture=vi.hoisted(()=>({request:vi.fn(),grant:vi.fn(),avatars:vi.fn(),account:{did:"did:plc:owner"}}));
vi.mock("$lib/server/canary.js",()=>({ORIGIN:"https://example.com",canaryAccount:async()=>({account:fixture.account,client:{request:fixture.request,grant:fixture.grant}}),senderAvatars:fixture.avatars}));
import {load} from "../routes/permissions/+page.server.js";
const event=()=>({url:new URL("https://example.com/permissions"),cookies:{},setHeaders:vi.fn()}) as never;
beforeEach(()=>{
  vi.clearAllMocks();
  fixture.request.mockResolvedValue({grants:[{grantId:"one",localRole:"grantor"},{grantId:"two",localRole:"grantor"},{grantId:"incoming",localRole:"grantee"}],next:null});
  fixture.grant.mockImplementation(async(grantId:string)=>({localRole:"grantor",digest:"digest",payload:{grant_id:grantId,grantor:fixture.account.did,grantee:"did:plc:sender",consent_context:{grantee_address:"sender@example.com"},scope:[{type:"categories",values:["general"]}],status:"active",revision:1,expires_at:null}}));
});
it("loads one avatar per sender and attaches it to each owned subscription",async()=>{
  const avatar={src:"data:image/png;base64,AQID",width:48,height:48};
  fixture.avatars.mockResolvedValue(new Map([["did:plc:sender",avatar]]));
  const result=await load(event());
  expect(result.permissions).toHaveLength(2);
  expect(result.permissions.every(permission=>permission.avatar===avatar)).toBe(true);
  expect(fixture.avatars.mock.calls[0][1]).toEqual(new Set(["did:plc:sender"]));
  expect(fixture.grant).toHaveBeenCalledTimes(2);
});
it("keeps subscriptions available with initials when no sender avatar exists",async()=>{
  fixture.avatars.mockResolvedValue(new Map());
  expect((await load(event())).permissions.map(permission=>permission.avatar)).toEqual([null,null]);
});
