import {expect,it,vi} from "vitest";
vi.mock("$env/dynamic/private",()=>({env:{}}));
import {senderAvatars} from "./server/canary.js";
import type {AccountApiClient} from "../../../cli/src/account-api.js";
const did=`did:plc:${"a".repeat(24)}`;
it("loads presentation avatars without calling the fresh profile verification endpoint",async()=>{
  const request=vi.fn(async()=>({did,avatar:{data:"AQID",width:48,height:48}}));
  const senderProfile=vi.fn(()=>new Promise<never>(()=>{}));
  const avatars=await senderAvatars({request,senderProfile} as unknown as AccountApiClient,new Set([did,did]));
  expect(avatars.get(did)).toEqual({src:"data:image/png;base64,AQID",width:48,height:48});
  expect(request).toHaveBeenCalledExactlyOnceWith(`/senders/${encodeURIComponent(did)}/avatar`);
  expect(senderProfile).not.toHaveBeenCalled();
});
it("keeps initials for absent, malformed, mismatched or unavailable avatars",async()=>{
  const request=vi.fn();
  for(const result of [{did,avatar:null},{did:"other",avatar:{data:"AQID",width:48,height:48}},
    {did,avatar:{data:"https://sender.example/image",width:48,height:48}},{did,avatar:{data:"AQID",width:-1,height:48}}]){
    request.mockResolvedValue(result);
    expect((await senderAvatars({request} as unknown as AccountApiClient,new Set([did]))).get(did)).toBeNull();
  }
  request.mockRejectedValue(new Error("Unavailable"));
  expect((await senderAvatars({request} as unknown as AccountApiClient,new Set([did]))).get(did)).toBeNull();
});
