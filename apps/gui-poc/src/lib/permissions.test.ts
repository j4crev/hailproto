import {expect,it,vi} from "vitest";
import {recoverPermission,senderLink,senderRequest,senderQr,permissionRequest,subscriptionScopeLabel} from "./permissions.js";

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

const requestId="00000000-0000-4000-8000-000000000001",grantor="did:plc:"+"a".repeat(24);
function pending(approved=false,result:unknown=null){return {requestId,action:"revoke",expiresAt:new Date(Date.now()+60000).toISOString(),approved,
  options:approved?null:{challenge:"passkey-required"},result,permission:{grant_id:requestId,revision:1,grantor,grantee:"did:plc:"+"b".repeat(24),
    expires_at:null,scope:[{type:"categories",values:["general"]}],consent_context:{grantee_address:"sender@example.com"}}};}
const saved={grantId:requestId,revision:2,status:"revoked",publication:"durable"};

it("restores an unconfirmed review without submitting or authorizing it",async()=>{
  const request=vi.fn(async()=>Response.json(pending()));vi.stubGlobal("fetch",request);
  try{expect((await recoverPermission(requestId,grantor)).approved).toBe(false);expect(request).toHaveBeenCalledOnce();}
  finally{vi.unstubAllGlobals();}
});

it("recognizes completion after a lost response without repeating the change",async()=>{
  const request=vi.fn(async()=>Response.json(pending(true,saved)));vi.stubGlobal("fetch",request);
  try{expect((await recoverPermission(requestId,grantor)).result).toEqual(saved);expect(request).toHaveBeenCalledOnce();}
  finally{vi.unstubAllGlobals();}
});

it("finishes an already authorized action using the same request and no new proof",async()=>{
  const request=vi.fn().mockResolvedValueOnce(Response.json(pending(true))).mockResolvedValueOnce(Response.json(pending(true,saved)));
  vi.stubGlobal("fetch",request);
  try{
    expect((await recoverPermission(requestId,grantor)).result).toEqual(saved);
    expect(request).toHaveBeenNthCalledWith(2,"/api/v1/account/permissions/commit",expect.objectContaining({body:JSON.stringify({requestId})}));
    expect(request).toHaveBeenCalledTimes(2);
  }finally{vi.unstubAllGlobals();}
});

it("bounds automatic recovery when saving remains unavailable",async()=>{
  const request=vi.fn().mockResolvedValueOnce(Response.json(pending(true))).mockResolvedValueOnce(Response.json({}, {status:503}));
  vi.stubGlobal("fetch",request);
  try{await expect(recoverPermission(requestId,grantor)).rejects.toThrow();expect(request).toHaveBeenCalledTimes(2);}
  finally{vi.unstubAllGlobals();}
});

it("does not retry another account's action",async()=>{
  const request=vi.fn(async()=>Response.json(pending(true)));vi.stubGlobal("fetch",request);
  try{await expect(recoverPermission(requestId,"did:plc:"+"c".repeat(24))).rejects.toThrow("account mismatch");expect(request).toHaveBeenCalledOnce();}
  finally{vi.unstubAllGlobals();}
});

it.each([404,410])("preserves terminal status %s so the UI can clear a stale review",async status=>{
  vi.stubGlobal("fetch",async()=>Response.json({}, {status}));
  try{await expect(recoverPermission(requestId,grantor)).rejects.toMatchObject({status});}
  finally{vi.unstubAllGlobals();}
});
