import {expect,it,vi} from "vitest";

vi.mock("$env/dynamic/private",()=>({env:{HAIL_GUI_PROVIDER:"https://provider.example",HAIL_GUI_API_ORIGIN:"https://provider.example",HAIL_GUI_ORIGIN:"https://provider.example"}}));
import {load} from "../routes/+page.server.js";
import {load as loadPermissions} from "../routes/permissions/+page.server.js";
import {AccountApiClient} from "../../../cli/src/account-api.js";

const token="hails_"+"A".repeat(43),provider="https://provider.example";
const account={type:"hailp.account",version:1,provider,accountId:"12345678-1234-1234-1234-123456789abc",did:"did:plc:"+"a".repeat(24),
  address:"new@provider.example",migrationState:null,custodyProfile:"managed",monitorVerificationMode:"reduced-assurance-alpha-v1",
  managedProfileVersion:"hail-managed-custody-v1",identityPublicKey:"did:key:z6MkTest",ownerRecoveryPublicKey:"did:key:zDnaTest",
  scopes:["account:read","grants:read","messages:read","messages:write"],
  credential:{credentialId:"12345678-1234-1234-1234-123456789def",expiresAt:"2027-01-01T00:00:00.000Z"}};

it("loads a new alpha account's empty inbox through the real session account client without relabeling assurance",async()=>{
  const request=vi.fn(async(url:string)=>new Response(JSON.stringify(url===provider+"/api/v1/account"?account:{messages:[],next:null}),{headers:{"Content-Type":"application/json"}}));
  vi.stubGlobal("fetch",request);
  const cookies={get:()=>token,delete:vi.fn()};
  try{
    const result=await load({url:new URL(provider+"/"),cookies} as never);
    expect(result).toMatchObject({configured:true,account:{monitorVerificationMode:"reduced-assurance-alpha-v1",custodyProfile:"managed"},messages:[],next:null});
    expect(cookies.delete).not.toHaveBeenCalled();
    expect(request).toHaveBeenCalledTimes(2);
    expect(request).toHaveBeenLastCalledWith(provider+"/api/v1/account/inbox?include=body&kind=subscriptions",expect.objectContaining({headers:expect.objectContaining({Cookie:`hail_session=${token}`})}));
  }finally{vi.unstubAllGlobals();}
});

it("preserves public managed profile validation and rejects unknown or non-managed alpha labels",async()=>{
  const client=AccountApiClient.fromSession(provider,token);
  try{
    for(const mode of ["strict-public-v1","reduced-assurance-alpha-v1"]){
      vi.stubGlobal("fetch",async()=>new Response(JSON.stringify({...account,monitorVerificationMode:mode}),{headers:{"Content-Type":"application/json"}}));
      await expect(client.account()).resolves.toMatchObject({monitorVerificationMode:mode});
      for(const profile of [null,"unknown-profile"]){
        vi.stubGlobal("fetch",async()=>new Response(JSON.stringify({...account,monitorVerificationMode:mode,managedProfileVersion:profile}),{headers:{"Content-Type":"application/json"}}));
        await expect(client.account()).rejects.toThrow("contract");
      }
    }
    for(const bad of [{...account,monitorVerificationMode:"unknown-assurance"},{...account,custodyProfile:"owner-controlled",managedProfileVersion:null}]){
      vi.stubGlobal("fetch",async()=>new Response(JSON.stringify(bad),{headers:{"Content-Type":"application/json"}}));
      await expect(client.account()).rejects.toThrow("contract");
    }
  }finally{vi.unstubAllGlobals();}
});

it("redirects an expired permission session to the shared login and preserves its return path",async()=>{
  vi.stubGlobal("fetch",async()=>new Response("",{status:401}));
  const cookies={get:()=>token,delete:vi.fn()};
  try{
    await expect(loadPermissions({url:new URL(provider+"/permissions?after=page"),cookies,setHeaders:vi.fn()} as never))
      .rejects.toMatchObject({status:303,location:"/?next=%2Fpermissions%3Fafter%3Dpage"});
    expect(cookies.delete).toHaveBeenCalledWith("hail_session",{path:"/"});
  }finally{vi.unstubAllGlobals();}
});
