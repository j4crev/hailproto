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
it("shows only active, unexpired subscriptions and preserves pagination",async()=>{
  fixture.request.mockResolvedValue({grants:['ongoing','future','expired','revoked','boundary'].map(grantId=>({grantId,localRole:'grantor'})),next:'next-page'});
  const now=Math.floor(Date.now()/1000);
  fixture.grant.mockImplementation(async(grantId:string)=>({localRole:'grantor',digest:'digest',payload:{grant_id:grantId,grantor:fixture.account.did,grantee:'did:plc:'+grantId,consent_context:{grantee_address:grantId+'@example.com'},scope:[{type:'categories',values:['general']}],status:grantId==='revoked'?'revoked':'active',revision:1,expires_at:grantId==='future'?now+3600:grantId==='expired'?now-1:grantId==='boundary'?now:null}}));
  fixture.avatars.mockResolvedValue(new Map());
  const result=await load(event());
  expect(result.permissions.map(permission=>permission.grantId)).toEqual(['ongoing','future']);
  expect(result.next).toBe('next-page');
  expect(fixture.avatars.mock.calls[0][1]).toEqual(new Set(['did:plc:ongoing','did:plc:future']));
});
