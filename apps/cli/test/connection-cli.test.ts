import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { parseCommand } from "../src/cli/options.js";
import { sendMessage } from "../src/message-creation.js";
import type { AccountApiClient } from "../src/account-api.js";

const id="019a0000-0000-7000-8000-000000000001",other="019a0000-0000-7000-8000-000000000002",peer="did:plc:"+"b".repeat(24);
it("discovers Connection commands and rejects missing identity pins and subscription-only flags",()=>{
  expect(parseCommand(["connection","invite","--help"]).help).toContain("admission capability");
  expect(parseCommand(["connection","accept","--file","code.json","--expected-did",peer,"--vault","vault.json","--state","accept.json"]).authenticated).toBe(true);
  for(const args of [
    ["connection","accept","--file","code.json","--vault","vault.json","--state","accept.json"],
    ["connection","accept","--file","code.json","--expected-did","unbound","--vault","vault.json","--state","accept.json"],
    ["connection","send",id,"--file","body.txt","--state","send.json","--category","general"],
    ["connection","send",id,"--file","body.txt","--state","send.json","--reply-until","2000000000"],
    ["connection","send","bad","--file","body.txt","--state","send.json"],
    ["connection","invite","--label"," ","--expires-at","2000000000","--vault","v","--state","s","--output","o"],
  ])expect(()=>parseCommand(args)).toThrow();
});

it("pins Connection recipient/epoch and exact message ID across ambiguous sends, refusing changed content or connection",async()=>{
  const root=await mkdtemp(join(tmpdir(),"hail-connection-cli-")),file=join(root,"body.txt"),state=join(root,"send.json");
  const requests:Record<string,unknown>[]=[];
  const request=vi.fn(async(path:string,body?:Record<string,unknown>)=>{
    if(path==="/connections/cli-list")return {connections:[{id,did:peer,epoch:7}]};
    requests.push(body!);
    if(requests.length===1)throw new Error("Response lost after persistence");
    return {messageId:body!.messageId,state:"accepted"};
  });
  const client={account:async()=>({accountId:"account",provider:"https://source.example.com",migrationState:null,scopes:["messages:write"]}),request} as unknown as AccountApiClient;
  try{
    await writeFile(file,"hello",{mode:0o600});
    await expect(sendMessage(client,file,state,undefined,undefined,undefined,undefined,id)).rejects.toThrow("Response lost");
    const retained=await readFile(state,"utf8");
    const sent=await sendMessage(client,file,state,undefined,undefined,undefined,undefined,id);
    expect(sent.messageId).toBe(requests[0]!.messageId);
    expect(requests[1]).toEqual(requests[0]);
    expect(requests[0]).toMatchObject({connectionId:id,recipientDid:peer,connectionEpoch:7,text:"hello"});
    expect(request.mock.calls.filter(([path])=>path==="/connections/cli-list")).toHaveLength(1);
    expect(await readFile(state,"utf8")).toBe(retained);
    await expect(sendMessage(client,file,state,undefined,undefined,undefined,undefined,other)).rejects.toThrow("changed account or content");
    await writeFile(file,"different");
    await expect(sendMessage(client,file,state,undefined,undefined,undefined,undefined,id)).rejects.toThrow("changed account or content");
    expect(requests).toHaveLength(2);
  }finally{await rm(root,{recursive:true,force:true});}
});
