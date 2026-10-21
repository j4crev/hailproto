import {mkdtemp,rm,writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {expect,it,vi} from "vitest";
import type {HailSenderProfile} from "@hailproto/codec";
import type {AccountApiClient} from "../src/account-api.js";
import {createProfile,showProfile,updateProfile} from "../src/sender-profile.js";

it("creates, reads and revision-checks explicit Sender Profiles",async()=>{
  const directory=await mkdtemp(join(tmpdir(),"hail-profile-")),path=join(directory,"profile.json");
  const did=`did:plc:${"a".repeat(24)}`,payload=(revision:number):HailSenderProfile=>({type:"hail.sender-profile",version:1,did,revision,
    display_name:"Canary",offers_uncategorized:false,categories:[{id:"updates",label:"Updates"}],updated_at:revision,
    key_id:`${did}#hail-messaging`});
  const profile=vi.fn().mockResolvedValue({payload:payload(1),digest:"a".repeat(43),representation:new Uint8Array()}),
    saveProfile=vi.fn().mockResolvedValue({payload:payload(1),digest:"a".repeat(43),representation:new Uint8Array()}),
    client={profile,saveProfile} as unknown as AccountApiClient;
  try{
    await writeFile(path,JSON.stringify({display_name:"Canary",offers_uncategorized:false,categories:[{id:"updates",label:"Updates"}]}),{mode:0o600});
    expect(await createProfile(client,path)).toMatchObject({revision:1});expect(saveProfile).toHaveBeenCalledWith(expect.anything(),0);
    expect(await showProfile(client)).toMatchObject({revision:1});
    saveProfile.mockResolvedValueOnce({payload:payload(2),digest:"b".repeat(43),representation:new Uint8Array()});
    expect(await updateProfile(client,path)).toMatchObject({revision:2});expect(saveProfile).toHaveBeenLastCalledWith(expect.anything(),1);
    await writeFile(path,JSON.stringify({display_name:"Canary",offers_uncategorized:false,categories:[],extra:true}),{mode:0o600});
    await expect(createProfile(client,path)).rejects.toThrow("invalid shape");
  }finally{await rm(directory,{recursive:true,force:true});}
});
