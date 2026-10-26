import {describe,expect,it,vi} from "vitest";
import {Hono} from "hono";
import {registerPasskeyRoutes} from "../src/accounts/passkey-routes.js";
import {PasskeyError,type PasskeyAuth} from "../src/accounts/passkeys.js";
import type {AccountApiRepository} from "../src/accounts/repository.js";

const origin="https://haili.app",token=`hails_${"A".repeat(43)}`;
function fixture(){
  const authenticate=vi.fn(async()=>({account_id:"00000000-0000-4000-8000-000000000001",credential_id:"00000000-0000-4000-8000-000000000002",
    credential_expires_at:new Date(Date.now()+60_000),did:`did:plc:${"a".repeat(24)}`,canonical_address:"canary@haili.app",
    scopes:["credentials:write"],migration_state:null,serving_generation:1}));
  const service={origin,rpId:"haili.app",authenticationOptions:vi.fn(async()=>({challengeId:"00000000-0000-4000-8000-000000000003",options:{challenge:"challenge"}})),
    authenticate:vi.fn(async()=>({token,expiresAt:new Date("2030-01-01T00:00:00Z")})),registrationOptions:vi.fn(async()=>({ok:true})),
    register:vi.fn(async()=>({registered:true})),list:vi.fn(async()=>({recentlyVerified:true,passkeys:[]})),
    rename:vi.fn(async()=>({renamed:true})),revoke:vi.fn(async()=>({revoked:true})),
    recoveryOptions:vi.fn(async()=>({challengeId:"00000000-0000-4000-8000-000000000004",options:{challenge:"recovery"}})),
    recover:vi.fn(async()=>({registered:true})),revokeSessions:vi.fn(async()=>({revoked:true})),
    prepareAuthorization:vi.fn(async()=>({requestId:"00000000-0000-4000-8000-000000000005"})),
    authorizationDetails:vi.fn(async()=>({clientId:"hailp-cli-v1",scopes:["account:read"]})),
    completeAuthorization:vi.fn(async()=>({redirectUri:"http://127.0.0.1:45678/callback"})),
    exchangeAuthorization:vi.fn(async()=>({type:"hailp.api-credential"})),logout:vi.fn(async()=>{})};
  const app=new Hono(),audit=vi.fn();registerPasskeyRoutes(app,service as unknown as PasskeyAuth,{authenticate} as unknown as AccountApiRepository,audit);
  return {app,service,authenticate,audit};
}

describe("passkey routes",()=>{
  it("requires the pinned browser origin before issuing a challenge",async()=>{
    const {app,service}=fixture();
    expect((await app.request("/api/v1/auth/passkeys/authentication/options",{method:"POST",headers:{Origin:"https://evil.example"}})).status).toBe(403);
    const response=await app.request("/api/v1/auth/passkeys/authentication/options",{method:"POST",headers:{Origin:origin}});
    expect(response.status).toBe(200);expect(service.authenticationOptions).toHaveBeenCalledOnce();
  });

  it("returns only session metadata and sets a protected cookie",async()=>{
    const {app,service}=fixture(),response=await app.request("/api/v1/auth/passkeys/authentication",{method:"POST",headers:{Origin:origin,"Content-Type":"application/json",Cookie:`hail_session=${token}`},
      body:JSON.stringify({challengeId:"00000000-0000-4000-8000-000000000003",response:{id:"credential"}})});
    expect(response.status).toBe(200);expect(await response.json()).toEqual({authenticated:true,expiresAt:"2030-01-01T00:00:00.000Z"});
    expect(service.logout).toHaveBeenCalledWith(token);
    const cookie=response.headers.get("Set-Cookie")!;
    for(const attribute of ["hail_session=hails_","Max-Age=43200","Path=/","HttpOnly","SameSite=Lax","Secure"])
      expect(cookie).toContain(attribute);
  });

  it("permits server-side trusted enrollment but still requires account access",async()=>{
    const {app,service,authenticate}=fixture();
    const response=await app.request("/api/v1/auth/passkeys/registration/options",{method:"POST",headers:{Authorization:`Bearer hailp_${"B".repeat(43)}`}});
    expect(response.status).toBe(200);expect(authenticate).toHaveBeenCalledOnce();expect(service.registrationOptions).toHaveBeenCalledOnce();
  });

  it("lists and manages passkeys through an authenticated session",async()=>{
    const {app,service}=fixture(),headers={Origin:origin,Cookie:`hail_session=${token}`};
    expect((await app.request("/api/v1/auth/passkeys",{headers})).status).toBe(200);
    const response=await app.request("/api/v1/auth/passkeys/manage",{method:"POST",headers:{...headers,"Content-Type":"application/json"},
      body:JSON.stringify({credentialId:"credential",label:"Phone"})});
    expect(response.status).toBe(200);expect(service.rename).toHaveBeenCalledOnce();
  });

  it("accepts recovery tokens only through origin-checked JSON posts",async()=>{
    const {app,service}=fixture(),response=await app.request("/api/v1/auth/passkeys/recovery/options",{method:"POST",
      headers:{Origin:origin,"Content-Type":"application/json"},body:JSON.stringify({token:`hailp_${"B".repeat(43)}`})});
    expect(response.status).toBe(200);expect(service.recoveryOptions).toHaveBeenCalledOnce();
    expect((await app.request("/api/v1/auth/passkeys/recovery/options",{method:"POST",headers:{Origin:"https://evil.example",
      "Content-Type":"application/json"},body:JSON.stringify({token:`hailp_${"B".repeat(43)}`})})).status).toBe(403);
  });

  it("revokes every account session and clears the current cookie",async()=>{
    const {app,service}=fixture(),response=await app.request("/api/v1/auth/passkeys/sessions/revoke",{method:"POST",
      headers:{Origin:origin,Cookie:`hail_session=${token}`}});
    expect(response.status).toBe(200);expect(service.revokeSessions).toHaveBeenCalledOnce();
    expect(response.headers.get("Set-Cookie")).toContain("hail_session=; Max-Age=0");
  });

  it("revokes only selected sessions and keeps the cookie unless this session is selected",async()=>{
    for(const id of ["00000000-0000-4000-8000-000000000003","00000000-0000-4000-8000-000000000002"]){
      const {app,service}=fixture();
      const response=await app.request("/api/v1/auth/passkeys/sessions/revoke",{method:"POST",
        headers:{Origin:origin,"Content-Type":"application/json",Cookie:`hail_session=${token}`},
        body:JSON.stringify({sessionIds:[id]})});
      expect(response.status).toBe(200);
      expect(service.revokeSessions).toHaveBeenCalledWith(expect.any(Object),[id]);
      expect(response.headers.has("Set-Cookie")).toBe(id.endsWith("2"));
    }
  });

  it("rejects malformed selections without falling back to signing out everywhere",async()=>{
    for(const value of [{sessionIds:[]},{sessionIds:["invalid"]},{sessionIds:null},{}, {sessionIds:[2]}]){
      const {app,service}=fixture();
      const response=await app.request("/api/v1/auth/passkeys/sessions/revoke",{method:"POST",
        headers:{Origin:origin,"Content-Type":"application/json"},body:JSON.stringify(value)});
      expect(response.status).toBe(400);
      expect(service.revokeSessions).not.toHaveBeenCalled();
      expect(response.headers.has("Set-Cookie")).toBe(false);
    }
  });

  it("allows CLI prepare/exchange without an Origin but protects browser approval with the pinned origin",async()=>{
    const {app,service}=fixture(),json={"Content-Type":"application/json"};
    expect((await app.request("/api/v1/auth/authorization/prepare",{method:"POST",headers:json,body:"{}"})).status).toBe(200);
    expect(service.prepareAuthorization).toHaveBeenCalledOnce();
    expect((await app.request("/api/v1/auth/authorization/details",{method:"POST",headers:{...json,Origin:"https://evil.example"},
      body:JSON.stringify({requestId:"00000000-0000-4000-8000-000000000005",state:"A".repeat(43)})})).status).toBe(403);
    expect((await app.request("/api/v1/auth/authorization/token",{method:"POST",headers:json,body:"{}"})).status).toBe(200);
    expect(service.exchangeAuthorization).toHaveBeenCalledOnce();
  });

  it("returns generic failures and bounds authentication requests",async()=>{
    const failure=fixture(),headers={Origin:origin,"Content-Type":"application/json"},body=JSON.stringify({
      challengeId:"00000000-0000-4000-8000-000000000003",response:{id:"credential"}});
    failure.service.authenticate.mockRejectedValueOnce(new Error("private account detail"));
    const unavailable=await failure.app.request("/api/v1/auth/passkeys/authentication",{method:"POST",headers,body});
    expect(unavailable.status).toBe(503);expect(await unavailable.text()).not.toContain("private account detail");
    expect(unavailable.headers.get("Retry-After")).toBe("30");
    failure.service.authenticate.mockRejectedValueOnce(new PasskeyError(401));
    expect(await (await failure.app.request("/api/v1/auth/passkeys/authentication",{method:"POST",headers,body})).json())
      .toEqual({type:"about:blank",title:"Unauthorized",status:401});

    const limited=fixture();
    for(let request=0;request<120;request++)expect((await limited.app.request("/api/v1/auth/passkeys/authentication/options",{method:"POST",headers:{Origin:origin}})).status).toBe(200);
    const blocked=await limited.app.request("/api/v1/auth/passkeys/authentication/options",{method:"POST",headers:{Origin:origin}});
    expect(blocked.status).toBe(429);expect(blocked.headers.get("Retry-After")).toBe("60");
    expect((await limited.app.request("/api/v1/auth/passkeys/authentication/options",{method:"POST",headers:{Origin:origin,
      "X-Hail-Trusted-Client-IP":"192.0.2.2"}})).status).toBe(200);
  });

  it("audits outcomes without request or account identifiers",async()=>{
    const {app,service,audit}=fixture();service.authenticate.mockRejectedValueOnce(new PasskeyError(401));
    await app.request("/api/v1/auth/passkeys/authentication",{method:"POST",headers:{Origin:origin,"Content-Type":"application/json"},
      body:JSON.stringify({challengeId:"00000000-0000-4000-8000-000000000003",response:{id:"sensitive-credential"}})});
    expect(audit).toHaveBeenCalledWith({type:"hail.auth",operation:"passkey.authentication",outcome:"refused",status:401});
    expect(JSON.stringify(audit.mock.calls)).not.toMatch(/sensitive|account|token|challenge|credential/i);
  });
});
