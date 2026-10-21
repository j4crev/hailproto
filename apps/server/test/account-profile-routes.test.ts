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
      expect(expected).toBe(0);
      current={id:crypto.randomUUID(),accountId:crypto.randomUUID(),did,revision:1,
        payload:{type:"hail.sender-profile",version:1,did,revision:1,display_name:definition.display_name as string,
          offers_uncategorized:false,categories:[{id:"updates",label:"Updates"}],updated_at:1,key_id:`${did}#hail-messaging`},
        cose:new Uint8Array([1]),digest:new Uint8Array(32),signingPublicKey:"did:key:zTest",updatedAt:1,createdAt:new Date()};
      return current;
    }),
  } as unknown as SenderProfileService;
  const accounts={authenticate:vi.fn(async()=>({account_id:crypto.randomUUID(),canonical_address:"alice@example.com",did,
    scopes:["account:read","account:write"],migration_state:null,serving_generation:1}))} as unknown as AccountApiRepository;
  const app=createApp({publicOrigin:"https://example.com",hailServiceBase:"https://example.com/hail",providerId:"test"} as AppConfig,
    {accountApi:{accounts,grants:{} as GrantRepository,service:{} as GrantService,profiles},async checkReadiness(){return {ready:true};}});
  const headers={Authorization:"Bearer test","Content-Type":"application/json"};
  expect((await app.request("/api/v1/account/profile",{headers:{Authorization:"Bearer test"}})).status).toBe(404);
  const created=await app.request("/api/v1/account/profile",{method:"POST",headers,
    body:JSON.stringify({expectedRevision:0,definition:{display_name:"Alice",offers_uncategorized:false,
      categories:[{id:"updates",label:"Updates"}]}})});
  expect(created.status).toBe(200);expect(await created.json()).toMatchObject({type:"hailp.sender-profile",revision:1});
  const shown=await app.request("/api/v1/account/profile",{headers:{Authorization:"Bearer test"}});
  expect(shown.status).toBe(200);expect(await shown.json()).toMatchObject({profile:{display_name:"Alice"}});
  expect((await app.request("/api/v1/account/profile",{method:"POST",headers,
    body:JSON.stringify({expectedRevision:0,definition:{display_name:"Alice",offers_uncategorized:false,categories:[],extra:true}})})).status).toBe(400);
});
