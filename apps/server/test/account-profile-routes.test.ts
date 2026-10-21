import {expect,it,vi} from "vitest";
import {createApp} from "../src/app.js";
import type {AppConfig} from "../src/config.js";
import type {AccountApiRepository} from "../src/accounts/repository.js";
import type {GrantRepository} from "../src/grants/repository.js";
import type {GrantService} from "../src/grants/service.js";
import type {SenderProfileService} from "../src/profiles/service.js";
import type {StoredSenderProfile} from "../src/profiles/store.js";

it("creates and reads an authenticated Sender Profile",async()=>{
  const did=`did:plc:${"a".repeat(24)}`;let current:StoredSenderProfile|null=null;
  const profiles={
    getLatest:vi.fn(async()=>current),
    createOrReuse:vi.fn(async(_address:string,definition:Record<string,unknown>,expected:number)=>{
      const revision=(current?.revision??0)+1;expect(expected).toBe(revision-1);
      const common={type:"hail.sender-profile" as const,did,revision,display_name:definition.display_name as string,
        offers_uncategorized:false,categories:[{id:"updates",label:"Updates"}],updated_at:revision,key_id:`${did}#hail-messaging`};
      current={id:crypto.randomUUID(),accountId:crypto.randomUUID(),did,revision,
        payload:definition.version===2?{...common,version:2,assets:{version:1,assets:[definition.avatar as never]}}:{...common,version:1},
        cose:new Uint8Array([revision]),digest:new Uint8Array(32),signingPublicKey:"did:key:zTest",updatedAt:revision,createdAt:new Date()};
      return current;
    }),
  } as unknown as SenderProfileService;
  const accounts={authenticate:vi.fn(async()=>({account_id:crypto.randomUUID(),canonical_address:"alice@example.com",did,
    scopes:["account:read","account:write","messages:read"],migration_state:null,serving_generation:1}))} as unknown as AccountApiRepository;
  const profileVerifier={verify:vi.fn(async()=>({did,profile:current!.payload,representation:current!.cose,digest:current!.digest,
    serviceBase:"https://sender.example/hail",messagingDidKey:"did:key:zTest",etag:"A".repeat(43),
    plcEvidence:{document:{},data:{},log:[]},verifiedAt:new Date()}))};
  const app=createApp({publicOrigin:"https://example.com",hailServiceBase:"https://example.com/hail",providerId:"test"} as AppConfig,
    {accountApi:{accounts,grants:{} as GrantRepository,service:{} as GrantService,profiles,profileVerifier},async checkReadiness(){return {ready:true};}});
  const headers={Authorization:"Bearer test","Content-Type":"application/json"};
  expect((await app.request("/api/v1/account/profile",{headers:{Authorization:"Bearer test"}})).status).toBe(404);
  const created=await app.request("/api/v1/account/profile",{method:"POST",headers,
    body:JSON.stringify({expectedRevision:0,definition:{display_name:"Alice",offers_uncategorized:false,
      categories:[{id:"updates",label:"Updates"}]}})});
  expect(created.status).toBe(200);expect(await created.json()).toMatchObject({type:"hailp.sender-profile",revision:1});
  const shown=await app.request("/api/v1/account/profile",{headers:{Authorization:"Bearer test"}});
  expect(shown.status).toBe(200);expect(await shown.json()).toMatchObject({profile:{display_name:"Alice"}});
  const avatar=Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=","base64").toString("base64url");
  const updated=await app.request("/api/v1/account/profile",{method:"POST",headers,
    body:JSON.stringify({expectedRevision:1,definition:{version:2,display_name:"Alice",offers_uncategorized:false,
      categories:[{id:"updates",label:"Updates"}],avatar}})});
  expect(updated.status).toBe(200);expect(await updated.json()).toMatchObject({revision:2,profile:{version:2}});
  const sender=await app.request(`/api/v1/account/senders/${did}/profile`,{headers:{Authorization:"Bearer test"}});
  expect(sender.status).toBe(200);expect(await sender.json()).toMatchObject({type:"hailp.verified-sender-profile",did,revision:2});
  expect((await app.request("/api/v1/account/profile",{method:"POST",headers,
    body:JSON.stringify({expectedRevision:0,definition:{display_name:"Alice",offers_uncategorized:false,categories:[],extra:true}})})).status).toBe(400);
});
