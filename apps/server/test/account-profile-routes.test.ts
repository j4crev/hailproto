import {expect,it,vi} from "vitest";
import {createApp} from "../src/app.js";
import type {AppConfig} from "../src/config.js";
import type {AccountApiRepository} from "../src/accounts/repository.js";
import type {GrantRepository} from "../src/grants/repository.js";
import type {GrantService} from "../src/grants/service.js";
import {SenderProfileConflictError,type SenderProfileService} from "../src/profiles/service.js";
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
  const app=createApp({publicOrigin:"https://example.com",hailServiceBase:"https://example.com/hail",providerId:"test",passkeys:{origin:"https://example.com"}} as AppConfig,
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

it("limits browser profile writes to fresh same-origin passkey sessions without broadening account scopes",async()=>{
  const session={account_id:crypto.randomUUID(),canonical_address:"alice@example.com",did:`did:plc:${"a".repeat(24)}`,
    scopes:["account:read"],migration_state:null as string|null,serving_generation:1,
    passkey_credential_id:"passkey" as string|null,passkey_verified_at:new Date()};
  const profiles={getLatest:vi.fn(async()=>null),createOrReuse:vi.fn(async()=>({revision:1,digest:new Uint8Array(32),cose:new Uint8Array([1]),
    payload:{type:"hail.sender-profile",version:1,did:session.did,revision:1,display_name:"Alice",offers_uncategorized:false,
      categories:[{id:"general",label:"General"}],updated_at:1,key_id:session.did+"#hail-messaging"}}))};
  const accounts={authenticate:vi.fn(async()=>session)} as unknown as AccountApiRepository;
  const app=createApp({publicOrigin:"https://example.com",hailServiceBase:"https://example.com/hail",providerId:"test",passkeys:{origin:"https://example.com"}} as AppConfig,
    {accountApi:{accounts,grants:{} as GrantRepository,service:{} as GrantService,profiles:profiles as unknown as SenderProfileService},async checkReadiness(){return {ready:true};}});
  const headers={Cookie:"hail_session=test",Origin:"https://example.com","Content-Type":"application/json"};
  const body=JSON.stringify({expectedRevision:0,definition:{display_name:"Alice",offers_uncategorized:false,categories:[{id:"general",label:"General"}]}});
  const save=(h:Record<string,string>=headers)=>app.request("/api/v1/account/profile",{method:"POST",headers:h,body});
  expect((await save({...headers,Origin:"https://other.example"})).status).toBe(403);
  session.passkey_verified_at=new Date(Date.now()-6*60_000);
  expect((await save()).status).toBe(403);
  session.passkey_verified_at=new Date();session.passkey_credential_id=null;
  expect((await save()).status).toBe(403);
  session.passkey_credential_id="passkey";
  expect((await save({Authorization:"Bearer read-only","Content-Type":"application/json"})).status).toBe(403);
  for(const categories of [[],[{id:"general",label:"Renamed"}],[{id:"general",label:"General",description:"Changed"}],
    [{id:"general",label:"General"},{id:"general",label:"General"}]]){
    const invalid={expectedRevision:0,definition:{display_name:"Alice",offers_uncategorized:false,categories}};
    expect((await app.request("/api/v1/account/profile",{method:"POST",headers,body:JSON.stringify(invalid)})).status).toBe(400);
  }
  expect(profiles.createOrReuse).not.toHaveBeenCalled();
  expect((await save()).status).toBe(200);
  expect(profiles.createOrReuse).toHaveBeenCalledTimes(1);
  expect(session.scopes).toEqual(["account:read"]);
  expect((await app.request("/api/v1/account/binding",{method:"POST",headers,body:"{}"})).status).toBe(403);
  session.migration_state="moving";
  expect((await save()).status).toBe(409);
  expect(profiles.createOrReuse).toHaveBeenCalledTimes(1);
  session.migration_state=null;
  profiles.createOrReuse.mockRejectedValueOnce(new SenderProfileConflictError("Revision changed"));
  expect((await save()).status).toBe(409);
});
