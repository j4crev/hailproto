import {it,expect,vi} from "vitest";
import {Hono} from "hono";
import {registerOperatorRoutes} from "../src/operator/routes.js";
import {invitationEmail} from "../src/operator/invitations.js";
const origin="https://example.com";
function setup(){
  const session={account_id:"a",passkey_credential_id:"key",migration_state:null,passkey_verified_at:new Date()};
  const accounts={authenticate:vi.fn(async()=>session)},invitations={authorized:vi.fn(async()=>true),list:vi.fn(async()=>({invitations:[]})),create:vi.fn(async()=>({id:"created"}))};
  const statistics={read:vi.fn(async(range:string)=>({range,totals:{sent:0},activity:[]}))};
  const app=new Hono();registerOperatorRoutes(app,accounts as never,invitations as never,origin,statistics as never);
  const request=(method="GET",headers:Record<string,string>={},body?:string)=>app.request("/api/v1/operator/invitations",{method,headers:{Origin:origin,Cookie:"hail_session=test",...headers},...(body?{body}:{})});
  return {session,accounts,invitations,request,statistics,app};
}
it("requires a passkey session and explicit operator authority on every request",async()=>{
  const t=setup();expect((await t.request()).status).toBe(200);
  expect(t.accounts.authenticate).toHaveBeenCalledWith(undefined,"test");
  t.invitations.authorized.mockResolvedValue(false);expect((await t.request()).status).toBe(403);
  t.accounts.authenticate.mockResolvedValue(null as never);expect((await t.request("GET",{Authorization:"Bearer hailp_token"})).status).toBe(401);
  expect(t.invitations.list).toHaveBeenCalledTimes(1);
});
it("rejects cross-origin requests, stale login, fenced accounts, and malformed bodies before creation",async()=>{
  const t=setup(),json={"Content-Type":"application/json"};
  expect((await t.request("POST",{...json,Origin:"https://evil.example"},"{}")).status).toBe(403);
  t.session.passkey_verified_at=new Date(Date.now()-11*60_000);
  expect((await t.request("POST",json,"{}")).status).toBe(403);
  t.session.passkey_verified_at=new Date();t.session.migration_state="fenced" as never;
  expect((await t.request()).status).toBe(403);t.session.migration_state=null;
  for(const body of ['{"id":1,"id":2}','null','[]'])expect((await t.request("POST",json,body)).status).toBe(400);
  expect(t.invitations.create).not.toHaveBeenCalled();
  const response=await t.request("POST",json,'{"id":"test","email":null}');
  expect(response.status).toBe(200);expect(response.headers.get("cache-control")).toBe("no-store");
});
it("validates email without allowing header injection",()=>{
  expect(invitationEmail("Person@EXAMPLE.COM")).toBe("Person@example.com");expect(invitationEmail(null)).toBeNull();
  for(const value of ["a@b", "a@-host.com", "a\r\nbcc:x@y.com", "a..b@example.com", "a@@example.com", "a@x.c",{},""])
    expect(()=>invitationEmail(value)).toThrow();
});

it("protects statistics with operator session authority and validates ranges",async()=>{
  const t=setup();
  const request=(suffix="",headers:Record<string,string>={},method="GET")=>t.app.request(`/api/v1/operator/stats${suffix}`,{method,headers:{Origin:origin,Cookie:"hail_session=test",...headers}});
  for(const range of ["day","week","month"]){
    const response=await request(`?range=${range}`);
    expect(response.status).toBe(200);expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect((await response.json()).range).toBe(range);
  }
  expect((await request("?range=constructor")).status).toBe(400);
  expect((await request("",{},"POST")).status).toBe(405);
  expect((await request("",{Origin:"https://evil.example"})).status).toBe(403);
  t.session.migration_state="fenced" as never;expect((await request()).status).toBe(403);t.session.migration_state=null;
  t.invitations.authorized.mockResolvedValue(false);expect((await request()).status).toBe(403);
  t.accounts.authenticate.mockResolvedValue(null as never);expect((await request("",{Authorization:"Bearer test"})).status).toBe(401);
  expect(t.statistics.read).toHaveBeenCalledTimes(3);
});
it("returns a safe retryable statistics error without database diagnostics",async()=>{
  const t=setup();t.statistics.read.mockRejectedValue(new Error("private database details"));
  const response=await t.app.request("/api/v1/operator/stats",{headers:{Origin:origin,Cookie:"hail_session=test"}});
  expect(response.status).toBe(503);expect(await response.json()).toEqual({error:"Statistics unavailable"});
});
