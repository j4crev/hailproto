import {expect,it,vi} from "vitest";
const {request}=vi.hoisted(()=>({request:vi.fn()}));
vi.mock("$lib/server/canary.js",()=>({canaryAccount:async()=>({client:{request}})}));
import {actions} from "../routes/compose/+page.server.js";

const id="019a15fd-2bd0-7433-8afa-bd0355e0608d";
const targetId="019a15fd-2bd0-7433-8afa-bd0355e0608e";
for(const kind of ["category","connections"] as const){
  const accepted=()=>({publicationId:id,category:kind==="category"?"general":null,...(kind==="connections"?{kind}:{}),total:1,state:"publishing",
    counts:{pending:1,submitted:0,blocked:0,cancelled:0,expired:0,indeterminate:0},
    delivery:{accepted:0,delivered:0,"on-hold":0,failed:0,cancelled:0,indeterminate:0},
    targets:[{messageId:targetId,recipient:"did:plc:"+"a".repeat(24),state:"pending",delivery:null}],
    createdAt:"2026-10-24T00:00:00Z",expiresAt:"2026-10-25T00:00:00Z"});
  const publish=()=>{
    const body=new FormData();
    for(const [key,value] of Object.entries({publicationId:id,audience:kind,mode:"plain",text:"Hello",
      ...(kind==="category"?{category:"general"}:{connection:targetId})}))body.set(key,value);
    return actions.publish({request:new Request("https://example.com/compose",{method:"POST",body}),cookies:{get:()=>undefined,getAll:()=>[],set:vi.fn(),delete:vi.fn(),serialize:()=>""},url:new URL("https://example.com/compose")} as unknown as Parameters<typeof actions.publish>[0]);
  };
  it(`${kind}: acknowledges provider acceptance while all recipients are still pending`,async()=>{
    request.mockResolvedValueOnce(accepted());
    await expect(publish()).rejects.toMatchObject({status:303,location:`/compose?${kind==="connections"?"audience=connections&":""}publication=${id}`});
  });
  it(`${kind}: does not acknowledge a lost or mismatched provider response`,async()=>{
    request.mockRejectedValueOnce(new Error("Response lost"));
    expect(await publish()).toMatchObject({status:502,data:{publicationId:id,error:expect.any(String)}});
    request.mockResolvedValueOnce({...accepted(),publicationId:targetId});
    expect(await publish()).toMatchObject({status:502,data:{publicationId:id,error:expect.any(String)}});
  });
}
