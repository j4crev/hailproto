import {expect,it,vi} from "vitest";
import {createApp} from "../src/app.js";
import type {AppConfig} from "../src/config.js";
import type {AccountApiRepository} from "../src/accounts/repository.js";
import type {GrantRepository} from "../src/grants/repository.js";
import type {GrantService} from "../src/grants/service.js";
import type {SenderProfileStore,VerifiedSenderProfileStore} from "../src/profiles/store.js";

const did=`did:plc:${"a".repeat(24)}`;
const avatar={role:"avatar",data:new Uint8Array([1,2,3]),width:48,height:48};
function fixture(){
  const session={account_id:crypto.randomUUID(),did,scopes:["messages:read"],serving_generation:1};
  const authenticate=vi.fn(async()=>session as typeof session|null);
  const local=vi.fn(),retained=vi.fn();
  // A stuck identity reader must never delay this presentation endpoint.
  const verify=vi.fn(()=>new Promise<never>(()=>{}));
  const app=createApp({publicOrigin:"https://example.com",hailServiceBase:"https://example.com/hail",providerId:"test"} as AppConfig,
    {accountApi:{accounts:{authenticate} as unknown as AccountApiRepository,grants:{} as GrantRepository,service:{} as GrantService,
      profileVerifier:{verify},avatarProfiles:{findCurrentByDid:local,getLatestVerifiedSenderProfile:retained} as unknown as SenderProfileStore & VerifiedSenderProfileStore},
      async checkReadiness(){return {ready:true};}});
  const request=(path=did,method="GET")=>app.request(`/api/v1/account/senders/${path}/avatar`,{method,headers:{Authorization:"Bearer test"}});
  return {session,authenticate,local,retained,verify,request};
}
it("loads the current local avatar without identity verification or stale retained data",async()=>{
  const f=fixture();f.local.mockResolvedValue({payload:{version:2,assets:{assets:[avatar]}}});
  const response=await f.request();
  expect(response.status).toBe(200);expect(await response.json()).toEqual({did,avatar:{data:"AQID",width:48,height:48}});
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(f.verify).not.toHaveBeenCalled();expect(f.retained).not.toHaveBeenCalled();
});
it("uses retained remote avatars without refreshing PLC evidence",async()=>{
  const f=fixture();f.local.mockResolvedValue(null);f.retained.mockResolvedValue({profile:{version:2,assets:{assets:[avatar]}}});
  expect(await (await f.request()).json()).toMatchObject({avatar:{data:"AQID"}});
  expect(f.retained).toHaveBeenCalledWith(did);expect(f.verify).not.toHaveBeenCalled();
});
it("preserves local avatar removal and falls back to initials for missing or legacy profiles",async()=>{
  const f=fixture();f.retained.mockResolvedValue({profile:{version:2,assets:{assets:[avatar]}}});
  for(const payload of [{version:1},{version:2}]){
    f.local.mockResolvedValue({payload});expect(await (await f.request()).json()).toEqual({did,avatar:null});
  }
  expect(f.retained).not.toHaveBeenCalled();
  f.local.mockResolvedValue(null);f.retained.mockResolvedValue(null);
  expect(await (await f.request()).json()).toEqual({did,avatar:null});
  expect(f.verify).not.toHaveBeenCalled();
});
it("requires authentication, message read scope, canonical DIDs and GET",async()=>{
  const f=fixture();
  expect((await f.request("invalid")).status).toBe(400);
  expect((await f.request(did,"POST")).status).toBe(405);
  f.session.scopes=[];expect((await f.request()).status).toBe(403);
  f.authenticate.mockResolvedValue(null);expect((await f.request()).status).toBe(401);
  expect(f.local).not.toHaveBeenCalled();expect(f.retained).not.toHaveBeenCalled();expect(f.verify).not.toHaveBeenCalled();
});
