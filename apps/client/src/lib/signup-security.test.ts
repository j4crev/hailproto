import { expect, it, vi } from "vitest";

const { env } = vi.hoisted(() => ({ env: {} as Record<string, string> }));
vi.mock("$env/dynamic/private", () => ({ env }));
import { load } from "../routes/signup/recovery/+page.server.js";
import { handle } from "../hooks.server.js";
import { load as signupLoad } from "../routes/signup/+page.server.js";

it("keeps the recovery preview off by default and preserves nonce CSP while denying connections", async () => {
  const setHeaders = vi.fn();
  expect(() => load({ setHeaders } as never)).toThrow(expect.objectContaining({ status: 404 }));
  env.HAIL_GUI_SIGNUP_PREVIEW = "true";
  try {
    expect(load({ setHeaders } as never)).toEqual({});
    expect(setHeaders).toHaveBeenCalledWith(expect.objectContaining({ "cache-control": "no-store", "referrer-policy": "no-referrer" }));
    const response = await handle({ event: { url: new URL("https://provider.example/signup/recovery") },
      resolve: async () => new Response("preview", { headers: { "content-security-policy": "script-src 'nonce-test'" } }),
    } as never);
    expect(response.headers.get("content-security-policy")).toBe("script-src 'nonce-test', connect-src 'none'; form-action 'none'; frame-ancestors 'none'");
    expect(response.headers.get("cache-control")).toBe("no-store");
  } finally { delete env.HAIL_GUI_SIGNUP_PREVIEW; }
});

it("keeps invited signup off by default and exposes only public pins, never service or invitation signing secrets",async()=>{
  const setHeaders=vi.fn();
  expect(()=>signupLoad({setHeaders} as never)).toThrow(expect.objectContaining({status:404}));
  Object.assign(env,{HAIL_GUI_SIGNUP:"true",HAIL_GUI_PROVIDER:"https://provider.example",ALPHA_SIGNUP_MONITOR_ORIGIN:"https://monitor.example",
    SIGNUP_MONITOR_PUBLIC_KEY:"did:key:z6MkTest",SIGNUP_MONITOR_TOKEN:"private-service-secret",ALPHA_SIGNUP_INVITE_KEY:"private-invitation-key"});
  try{
    const value=signupLoad({setHeaders} as never);
    expect(value).toEqual({policy:{provider:"https://provider.example",monitorOrigin:"https://monitor.example",monitorKey:"did:key:z6MkTest"}});
    expect(JSON.stringify(value)).not.toContain("private-");
    const response=await handle({event:{url:new URL("https://provider.example/signup")},resolve:async()=>new Response("signup",{headers:{"content-security-policy":"script-src 'nonce-test'"}})} as never);
    expect(response.headers.get("content-security-policy")).toContain("script-src 'nonce-test', connect-src 'self'; form-action 'none'; frame-ancestors 'none'");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
  }finally{for(const key of Object.keys(env))delete env[key];}
});
