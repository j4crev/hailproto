import {expect,it,vi} from "vitest";
import {senderLink,senderRequest,senderQr,permissionRequest,subscriptionScopeLabel} from "./permissions.js";

it("makes public identity-pinned QR links and rejects malformed or credential-bearing requests",()=>{
  const did="did:plc:"+"a".repeat(24),link=senderLink("https://haili.app","canary-prov@haili.app",did),url=new URL(link);
  expect(url.pathname).toBe("/permissions");expect(senderRequest(url.hash)).toEqual({sender:"canary-prov@haili.app",did});
  expect(link).not.toMatch(/token|credential|hails_|hailp_/);
  const qr=senderQr(link);expect(qr.size).toBeGreaterThan(29);expect(qr.path).toMatch(/^M\d+ \d+h1v1h-1z/);expect(qr.path).not.toContain("<");
  expect(senderQr(link)).toEqual(qr);
  expect(senderRequest("")).toBeNull();
  for(const hash of ["#sender=a@b.com","#sender=a@b.com&did=evil",url.hash+"&token=secret",url.hash+"&sender=other@b.com"])
    expect(()=>senderRequest(hash)).toThrow();
  expect(()=>senderLink("https://evil.example/path","a@b.com",did)).toThrow();
  expect(()=>senderLink("javascript:alert(1)","a@b.com",did)).toThrow();
});

it("labels General and keeps historical uncategorized permissions distinguishable",()=>{
  expect(subscriptionScopeLabel({type:"categories",values:["general","updates"]})).toBe("General, updates");
  expect(subscriptionScopeLabel({type:"uncategorized"})).toBe("Legacy uncategorized");
  expect(subscriptionScopeLabel(undefined)).toBe("Permission unavailable");
});

it("permission requests use only the bounded same-origin cookie API, never QR-selected endpoints",async()=>{
  const request=vi.fn(async()=>Response.json({address:"sender@example.com"}));vi.stubGlobal("fetch",request);
  try{
    await permissionRequest("review",{sender:"sender@example.com"});
    expect(request).toHaveBeenCalledWith("/api/v1/account/permissions/review",expect.objectContaining({credentials:"same-origin",cache:"no-store",redirect:"error"}));
    await expect(permissionRequest("https://evil.example/commit",{})).rejects.toThrow();
    expect(request).toHaveBeenCalledOnce();
    vi.stubGlobal("fetch",async()=>new Response('{"error":"private vendor diagnostics"}',{status:503}));
    await expect(permissionRequest("commit",{})).rejects.toThrow("Permission was not confirmed");
  }finally{vi.unstubAllGlobals();}
});
