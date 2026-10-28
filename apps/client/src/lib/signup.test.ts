import {expect,it,vi} from "vitest";
import {createSignupBackup,encodeBase64Url} from "./signup-recovery.js";
import {checkSummary,enrollmentHash,openPending,pendingKey,sealPending,setupToken,signupRequest,SignupRequestError,type PendingSignup} from "./signup.js";

const policy={provider:"https://provider.example",monitorOrigin:"https://monitor.example",monitorKey:"did:key:z6MkTest"};
it("round-trips encrypted pending setup without retaining its recovery secret; refuses wrong secret, mutation, bound vault and policy changes",async()=>{
  const made=await createSignupBackup(),secret=encodeBase64Url(made.recoverySecret);
  try{
    const pending:PendingSignup={type:"hail.pending-signup",version:1,policy,signupId:crypto.randomUUID(),address:"alice@provider.example",email:"alice@example.net",
      token:setupToken(),enrollmentToken:setupToken(),invitation:"single-use-invitation",vault:made.vault,operation:null,did:null};
    expect(pending.token).not.toBe(pending.enrollmentToken);
    expect(await enrollmentHash(pending.enrollmentToken)).toHaveLength(43);
    const key=await pendingKey(secret),text=await sealPending(pending,key);
    expect(key.extractable).toBe(false);
    for(const sensitive of [secret,pending.token,pending.enrollmentToken,pending.invitation,pending.email,pending.vault.recovery.ciphertext])expect(text).not.toContain(sensitive);
    expect(await openPending(text,key,policy)).toEqual(pending);
    const publicPending={...pending,invitation:""};
    expect(await openPending(await sealPending(publicPending,key),key,policy)).toEqual(publicPending);
    expect(await sealPending(pending,key)).not.toBe(text); // fresh nonce per checkpoint
    await expect(openPending(text,await pendingKey(encodeBase64Url(crypto.getRandomValues(new Uint8Array(32)))),policy)).rejects.toThrow();
    const altered=JSON.parse(text);altered.ciphertext=(altered.ciphertext[0]==="A"?"B":"A")+altered.ciphertext.slice(1);
    await expect(openPending(JSON.stringify(altered),key,policy)).rejects.toThrow();
    await expect(openPending(text,key,{...policy,provider:"https://other.example"})).rejects.toThrow();
    await expect(openPending(text,key,{...policy,monitorKey:"changed"})).rejects.toThrow();
    await expect(openPending(await sealPending({...pending,vault:{...pending.vault,did:"did:plc:"+"a".repeat(24)}},key),key,policy)).rejects.toThrow();
    await expect(openPending(" ".repeat(65_537),key,policy)).rejects.toThrow();
    const summary={type:"hail.signup" as const,version:1 as const,signupId:pending.signupId,address:pending.address,accountId:crypto.randomUUID(),did:null,
      state:"prepared" as const,expiresAt:new Date().toISOString(),preparation:null,enrollmentExpiresAt:null};
    expect(checkSummary(summary,pending)).toBe(summary);
    for(const bad of [{...summary,address:"other@provider.example"},{...summary,signupId:crypto.randomUUID()},{...summary,state:"complete"}])
      expect(()=>checkSummary(bad as never,pending)).toThrow();
  }finally{made.recoverySecret.fill(0);}
});

it("requests only fixed same-origin endpoints without redirects or cache and does not reflect vendor errors",async()=>{
  const request=vi.fn(async()=>new Response(JSON.stringify({state:"prepared"}),{headers:{"Content-Type":"application/json"}}));
  const token=setupToken();
  await signupRequest("/api/v1/signup",{invitation:"test"},token,request);
  expect(request).toHaveBeenCalledWith("/api/v1/signup",expect.objectContaining({credentials:"same-origin",redirect:"error",cache:"no-store",
    headers:expect.objectContaining({Authorization:`Bearer ${token}`})}));
  await expect(signupRequest("https://evil.example/api/v1/signup",{},token,request)).rejects.toThrow();
  const refused=async()=>new Response(JSON.stringify({error:"secret-vendor-diagnostic"}),{status:429,headers:{"Retry-After":"60"}});
  await expect(signupRequest("/api/v1/signup",{},token,refused)).rejects.toMatchObject({status:429,retryAfter:60});
  try{await signupRequest("/api/v1/signup",{},token,refused);}catch(error){expect(error).toBeInstanceOf(SignupRequestError);expect(String(error)).not.toContain("secret-vendor-diagnostic");}
  await expect(signupRequest("/api/v1/signup",{},token,async()=>new Response('{"error":"busy"}',{status:202}))).rejects.toMatchObject({status:202});
});
