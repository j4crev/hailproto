import {expect,it,vi} from "vitest";

vi.mock("$env/dynamic/private",()=>({env:{}}));
import {isAccountPath,loginPath,returnPath} from "./auth-routing.js";
import {handle} from "../hooks.server.js";
import {load as layout} from "../routes/+layout.server.js";
import {load as home} from "../routes/+page.server.js";
import {load as legacyLogin} from "../routes/auth/login/+page.server.js";

it("uses one sign-in destination for every anonymous private screen and action",async()=>{
  const cookies={get:()=>undefined},resolve=vi.fn();
  for(const path of ["/admin","/categories","/account","/settings","/connections","/permissions","/settings/security","/sent","/compose","/sent/message-id","/message/did%3Aplc%3Atest/message-id"]){
    expect(isAccountPath(path)).toBe(true);
    for(const search of ["","?after=page","?/reply"]){
      const url=new URL("https://provider.example"+path+search);
      const response=await handle({event:{url,cookies},resolve} as never);
      expect(response.status).toBe(303);
      expect(response.headers.get("location")).toBe(loginPath(url));
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(new URL(loginPath(url),url).pathname).toBe("/");
      expect(new URL(loginPath(url),url).searchParams.get("next")).toBe(path+search);
    }
  }
  expect(resolve).not.toHaveBeenCalled();
  expect(layout({cookies} as never)).toEqual({hasAccountSession:false});
  // This only controls navigation visibility; it is not proof of authentication.
  expect(layout({cookies:{get:()=>"expired-token"}} as never)).toEqual({hasAccountSession:true});
});

it("allows only local inbox return paths, including public QR fragments",()=>{
  for(const value of [null,"https://evil.example/sent","//evil.example/sent","/\\evil.example/sent","/sent\nX-Test: bad","/auth/login","/auth/recover#secret","/signup","/sent/../auth/login","javascript:alert(1)"])
    expect(returnPath(value)).toBe("/");
  for(const value of ["/admin","/categories","/account","/settings","/connections","/","/sent?after=page","/permissions#sender=a%40example.com&did=did%3Aplc%3Aa","/compose","/settings/security"])
    expect(returnPath(value)).toBe(value);
});

it("redirects old sign-in links to the homepage with a validated destination",()=>{
  for(const [next,expected] of [["/admin","/admin"],["/connect?token=secret","/connect"],["https://evil.example","/"],["/auth/login","/"]]){
    expect(()=>legacyLogin({url:new URL("https://provider.example/auth/login?next="+encodeURIComponent(next))} as never))
      .toThrow(expect.objectContaining({status:303,location:"/?next="+encodeURIComponent(expected)}));
  }
});

it("shows homepage sign-in for validated return paths even with an existing session",async()=>{
  for(const token of [undefined,"existing-session"]){
    for(const [next,expected] of [["/admin","/admin"],["/connect?token=secret","/connect"],["https://evil.example","/"]]){
      const url=new URL("https://provider.example/?next="+encodeURIComponent(next));
      await expect(home({url,cookies:{get:()=>token}} as never)).resolves.toEqual({configured:false,returnTo:expected});
    }
  }
});
