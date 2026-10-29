import {expect,it,vi} from "vitest";
vi.mock("$env/dynamic/private",()=>({env:{}}));
import {senderAvatars} from "./server/canary.js";
import type {AccountApiClient} from "../../../cli/src/account-api.js";
const did=`did:plc:${"a".repeat(24)}`;
it("returns same-origin image URLs without waiting for API or identity requests",async()=>{
  const request=vi.fn(()=>new Promise<never>(()=>{})),senderProfile=vi.fn(()=>new Promise<never>(()=>{}));
  const avatars=await senderAvatars({request,senderProfile} as unknown as AccountApiClient,new Set([did,did,"invalid"]));
  expect([...avatars]).toEqual([[did,{src:`/api/v1/account/senders/${encodeURIComponent(did)}/avatar/image`,width:44,height:44}]]);
  expect(request).not.toHaveBeenCalled();expect(senderProfile).not.toHaveBeenCalled();
});
