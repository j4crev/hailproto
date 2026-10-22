import {generateKeyPairSync} from "node:crypto";
import {expect,it,vi} from "vitest";
import {MonitorSigner} from "../src/signing.js";
import worker,{AlertDeduplicator,type Env} from "../deploy/cloudflare-alert-worker/worker.js";
import {encodeBase64Url} from "@hailproto/codec";
import {cidForCbor} from "@atproto/common";

function deduplicator(env:Record<string,unknown>){
  let alarm:number|null=null,queue:Promise<unknown>=Promise.resolve();
  const values=new Map<string,unknown>(),storage={get:async(key:string)=>values.get(key),put:async(key:string,value:unknown)=>{values.set(key,value)},
    delete:async(key:string)=>values.delete(key),list:async({prefix}:{prefix:string})=>new Map([...values].filter(([key])=>key.startsWith(prefix))),
    getAlarm:async()=>alarm,setAlarm:async(time:number)=>{alarm=time;},
    transaction:<T>(callback:(value:unknown)=>Promise<T>):Promise<T>=>{
      const result=queue.then(()=>callback(storage));queue=result.catch(()=>{});return result;
    }};
  const object=new AlertDeduplicator({storage} as never,env as never);
  return {idFromName:(name:string)=>name,get:()=>({fetch:(request:Request)=>object.fetch(request)}),values,object};
}

it("emails only a valid pinned signed monitor alert",async()=>{
  const signer=new MonitorSigner(generateKeyPairSync("ed25519").privateKey),
    send=vi.fn(async(_message:{to:string;from:string;subject:string;text:string})=>({messageId:"test"}));
  const env:any={EMAIL:{send},ALERT_RECIPIENT:"the@j4w8n.com",ALERT_SENDER:"alerts@plcmonitor.us",MONITOR_PUBLIC_KEY:signer.publicDidKey,
    HEARTBEAT_TOKEN:"token",BACKUP_TOKEN:"backup",PROVIDER_HEALTH_URL:"https://haili.app/health/ready",HAIL_PRODUCTION_MONITOR:{get:vi.fn(),put:vi.fn()}};
  env.ALERT_DEDUPLICATOR=deduplicator(env);
  const payload=JSON.stringify({type:"hail.plc-monitor-alert",version:1,id:"00000000-0000-0000-0000-000000000000",
    did:`did:plc:${"a".repeat(24)}`,category:"unexpected-operation",detail:{operationCid:"bafyrei"},occurred_at:new Date().toISOString()});
  const bytes=new TextEncoder().encode(payload),request=(signature:Uint8Array)=>new Request("https://alerts.plcmonitor.us/hail",{
    method:"POST",headers:{"Content-Type":"application/json","Content-Length":String(bytes.length),
      "X-Hail-Monitor-Key":signer.publicDidKey,"X-Hail-Monitor-Signature":encodeBase64Url(signature)},body:bytes});
  expect((await worker.fetch(request(signer.signAlert(bytes)),env)).status).toBe(204);
  expect((await worker.fetch(request(signer.signAlert(bytes)),env)).status).toBe(204);
  expect(send).toHaveBeenCalledWith(expect.objectContaining({to:"the@j4w8n.com",from:"alerts@plcmonitor.us"}));
  expect(send.mock.calls[0]![0].text).not.toContain("Monitor key:");
  const bad=signer.signAlert(bytes);bad[0]=bad[0]!^1;
  expect((await worker.fetch(request(bad),env)).status).toBe(401);
  const staleBytes=new TextEncoder().encode(JSON.stringify({...JSON.parse(payload),id:"00000000-0000-0000-0000-000000000001",
    occurred_at:new Date(Date.now()-8*86400_000).toISOString()}));
  expect((await worker.fetch(new Request("https://alerts.plcmonitor.us/hail",{method:"POST",headers:{"Content-Type":"application/json",
    "X-Hail-Monitor-Key":signer.publicDidKey,"X-Hail-Monitor-Signature":encodeBase64Url(signer.signAlert(staleBytes))},body:staleBytes}),env)).status).toBe(400);
  expect(send).toHaveBeenCalledOnce();
});

it("accepts authenticated heartbeats and alerts only on health transitions",async()=>{
  const values=new Map<string,string>(),send=vi.fn(async(_message:{to:string;from:string;subject:string;text:string})=>({messageId:"test"})),put=vi.fn(async(key:string,value:string)=>{values.set(key,value)}),
    env:any={EMAIL:{send},ALERT_RECIPIENT:"the@j4w8n.com",ALERT_SENDER:"alerts@plcmonitor.us",MONITOR_PUBLIC_KEY:"unused",
      HEARTBEAT_TOKEN:"secret",BACKUP_TOKEN:"backup",PROVIDER_HEALTH_URL:"https://haili.app/health/ready",HAIL_PRODUCTION_MONITOR:{get:async(key:string)=>values.get(key)??null,put}};
  env.ALERT_DEDUPLICATOR=deduplicator(env);
  expect((await worker.fetch(new Request("https://alerts.plcmonitor.us/heartbeat",{method:"POST",headers:{Authorization:"Bearer wrong"}}),env)).status).toBe(401);
  expect((await worker.fetch(new Request("https://alerts.plcmonitor.us/heartbeat",{method:"POST",headers:{Authorization:"Bearer secret"}}),env)).status).toBe(204);
  expect((await worker.fetch(new Request("https://alerts.plcmonitor.us/backup-heartbeat",{method:"POST",headers:{Authorization:"Bearer backup"}}),env)).status).toBe(204);
  const originalFetch=globalThis.fetch;globalThis.fetch=vi.fn(async()=>new Response(null,{status:200})) as unknown as typeof fetch;
  try{await worker.scheduled({},env);await worker.scheduled({},env);}finally{globalThis.fetch=originalFetch;}
  expect(send).not.toHaveBeenCalled();expect(put).toHaveBeenCalledTimes(5);
  values.set("monitor-heartbeat",String(Date.now()-7*60_000));
  values.set("backup-heartbeat",String(Date.now()-27*60*60_000));
  const originalFetch2=globalThis.fetch;globalThis.fetch=vi.fn(async()=>new Response(null,{status:503})) as unknown as typeof fetch;
  try{await worker.scheduled({},env);await worker.scheduled({},env);}finally{globalThis.fetch=originalFetch2;}
  expect(send).toHaveBeenCalledTimes(3);
  expect(send.mock.calls.map(call=>call[0].subject)).toEqual(["[Hail ops] haili provider down","[Hail ops] PLC monitor down","[Hail ops] provider backup down"]);
  await worker.fetch(new Request("https://alerts.plcmonitor.us/heartbeat",{method:"POST",headers:{Authorization:"Bearer secret"}}),env);
  await worker.fetch(new Request("https://alerts.plcmonitor.us/backup-heartbeat",{method:"POST",headers:{Authorization:"Bearer backup"}}),env);
  const originalFetch3=globalThis.fetch;globalThis.fetch=vi.fn(async()=>new Response(null,{status:200})) as unknown as typeof fetch;
  try{await worker.scheduled({},env);await worker.scheduled({},env);}finally{globalThis.fetch=originalFetch3;}
  expect(send.mock.calls.slice(3).map(call=>call[0].subject)).toEqual(["[Hail ops] haili provider ok","[Hail ops] PLC monitor ok","[Hail ops] provider backup ok"]);
  expect(put).toHaveBeenCalledTimes(13);
});

function signupFixture(){
  const signer=new MonitorSigner(generateKeyPairSync("ed25519").privateKey);
  const send=vi.fn(async(_message:{to:string;from:string;subject:string;text:string})=>({messageId:"test"}));
  const env:Env={EMAIL:{send},ALERT_RECIPIENT:"operator@example.com",ALERT_SENDER:"security@notify.haili.app",
    SIGNUP_SENDER:"welcome@notify.haili.app",SIGNUP_ORIGIN:"https://haili.app",
    SIGNUP_EMAIL_TOKEN:encodeBase64Url(crypto.getRandomValues(new Uint8Array(32))),MONITOR_PUBLIC_KEY:signer.publicDidKey,
    HEARTBEAT_TOKEN:"heartbeat",BACKUP_TOKEN:"backup",PROVIDER_HEALTH_URL:"https://haili.app/health/ready",
    HAIL_PRODUCTION_MONITOR:{get:async()=>null,put:async()=>{}},ALERT_DEDUPLICATOR:null as never};
  const coordinator=deduplicator(env as unknown as Record<string,unknown>);env.ALERT_DEDUPLICATOR=coordinator;
  const identity={signupId:crypto.randomUUID(),signupHash:encodeBase64Url(crypto.getRandomValues(new Uint8Array(32)))};
  const post=(path:string,input:unknown,token=env.SIGNUP_EMAIL_TOKEN)=>worker.fetch(new Request(`https://alerts.plcmonitor.us${path}`,{
    method:"POST",headers:{"Content-Type":"application/json",Authorization:`Bearer ${token}`},body:JSON.stringify(input)}),env);
  const challenge=()=>send.mock.calls.at(-1)![0].text.match(/code is: (\d{8})/)![1]!;
  const alert=(did:string,id:string=crypto.randomUUID())=>{
    const bytes=new TextEncoder().encode(JSON.stringify({type:"hail.plc-monitor-alert",version:1,id,did,category:"unexpected-operation",
      detail:{operationCid:"bafyrei"},occurred_at:new Date(Date.now()).toISOString()}));
    return new Request("https://alerts.plcmonitor.us/hail",{method:"POST",headers:{"Content-Type":"application/json",
      "X-Hail-Monitor-Key":signer.publicDidKey,"X-Hail-Monitor-Signature":encodeBase64Url(signer.signAlert(bytes))},body:bytes});
  };
  return {env,send,coordinator,identity,post,challenge,alert};
}

it("authenticates signup verification, stores only code hashes and binds one verified destination to one exact signup identity",async()=>{
  const f=signupFixture(),input={...f.identity,email:"alice@example.com"};
  expect((await f.post("/signup-email",input,"wrong")).status).toBe(401);
  const token=f.env.SIGNUP_EMAIL_TOKEN;delete f.env.SIGNUP_EMAIL_TOKEN;
  expect((await f.post("/signup-email",input,token)).status).toBe(503);f.env.SIGNUP_EMAIL_TOKEN=token!;
  for(const invalid of [null,{...input,email:"alice@example.com\r\nBcc: victim@example.com"},{...input,html:"arbitrary email"},
    {...input,signupHash:"not-a-hash"},{...input,email:"a..b@example.com"}])
    expect((await f.post("/signup-email",invalid)).status).toBe(400);
  const duplicate=new Request("https://alerts.plcmonitor.us/signup-email",{method:"POST",headers:{"Content-Type":"application/json",
    Authorization:`Bearer ${token}`},body:`{"signupId":"${input.signupId}","signupHash":"${input.signupHash}","email":"alice@example.com","email":"bob@example.com"}`});
  expect((await worker.fetch(duplicate,f.env)).status).toBe(400);
  const start=await f.post("/signup-email",input),result=await start.json() as Record<string,unknown>;
  expect(start.status).toBe(200);expect(result.verified).toBe(false);
  const code=f.challenge();expect(JSON.stringify(result)).not.toContain(code);
  expect(JSON.stringify([...f.coordinator.values])).not.toContain(code);
  expect(f.send).toHaveBeenCalledWith(expect.objectContaining({to:input.email,from:"welcome@notify.haili.app"}));
  expect((await f.post("/signup-email",input)).status).toBe(200);expect(f.send).toHaveBeenCalledOnce();
  expect((await f.post("/signup-email",{...input,email:"bob@example.com"})).status).toBe(409);
  const did=`did:plc:${"a".repeat(24)}`,operationCid=(await cidForCbor({genesis:"fixture"})).toString();
  const binding={...f.identity,did,operationCid};
  expect((await f.post("/signup-email/bind",binding)).status).toBe(409);
  expect((await f.post("/signup-email/verify",{...f.identity,code:code==="00000000"?"00000001":"00000000"})).status).toBe(409);
  expect((await f.post("/signup-email/verify",{...f.identity,code})).status).toBe(200);
  expect((f.coordinator.values.get(`signup:${f.identity.signupId}`) as {codeHash:unknown}).codeHash).toBeNull();
  expect((await f.post("/signup-email/verify",{...f.identity,code})).status).toBe(200);
  expect((await f.post("/signup-email/bind",binding)).status).toBe(200);
  expect((await f.post("/signup-email/bind",binding)).status).toBe(200);
  expect((await f.post("/signup-email/bind",{...binding,did:`did:plc:${"b".repeat(24)}`})).status).toBe(409);
  expect((await f.post("/signup-email/bind",{...binding,operationCid:(await cidForCbor({genesis:"different"})).toString()})).status).toBe(409);
  const other={signupId:crypto.randomUUID(),signupHash:encodeBase64Url(crypto.getRandomValues(new Uint8Array(32)))};
  await f.post("/signup-email",{...other,email:"bob@example.com"});
  await f.post("/signup-email/verify",{...other,code:f.challenge()});
  expect((await f.post("/signup-email/bind",{...other,did,operationCid})).status).toBe(409);
  const request=f.alert(did);
  expect((await worker.fetch(request.clone(),f.env)).status).toBe(204);
  expect(f.send.mock.calls.at(-1)![0]).toMatchObject({to:"alice@example.com",from:"security@notify.haili.app"});
  const count=f.send.mock.calls.length;
  expect((await worker.fetch(request.clone(),f.env)).status).toBe(204);expect(f.send).toHaveBeenCalledTimes(count);
  const changed=f.alert(`did:plc:${"c".repeat(24)}`,(await request.clone().json() as {id:string}).id);
  expect((await worker.fetch(changed,f.env)).status).toBe(409);
  expect((await worker.fetch(f.alert(`did:plc:${"d".repeat(24)}`),f.env)).status).toBe(204);
  expect(f.send.mock.calls.at(-1)![0].to).toBe("operator@example.com");
});

it("bounds guesses, explicit resends and proof lifetime without treating email as account recovery",async()=>{
  let now=Date.now();const clock=vi.spyOn(Date,"now").mockImplementation(()=>now);
  try{
    const f=signupFixture(),input={...f.identity,email:"alice@example.com"};
    await f.post("/signup-email",input);const original=f.challenge(),wrong=original==="00000000"?"00000001":"00000000";
    for(let i=0;i<5;i++)expect((await f.post("/signup-email/verify",{...f.identity,code:wrong})).status).toBe(409);
    expect((await f.post("/signup-email/verify",{...f.identity,code:original})).status).toBe(429);
    expect((await f.post("/signup-email",{...input,resend:true})).status).toBe(429);
    now+=61_000;
    expect((await f.post("/signup-email",{...input,resend:true})).status).toBe(200);
    const latest=f.challenge();
    expect((await f.post("/signup-email/verify",{...f.identity,code:latest})).status).toBe(200);
    now+=25*3_600_000;
    expect((await f.post("/signup-email/bind",{...f.identity,did:`did:plc:${"a".repeat(24)}`,
      operationCid:(await cidForCbor({fixture:true})).toString()})).status).toBe(409);
    await f.coordinator.object.alarm();
    expect(f.coordinator.values.has(`signup:${f.identity.signupId}`)).toBe(false);
    const pending=signupFixture();await pending.post("/signup-email",{...pending.identity,email:"pending@example.com"});
    const code=pending.challenge();now+=11*60_000;
    expect((await pending.post("/signup-email/verify",{...pending.identity,code})).status).toBe(409);
  }finally{clock.mockRestore();}
});

it("persists mailbox and global sending limits across new signup IDs",async()=>{
  const f=signupFixture();
  for(let i=0;i<6;i++){
    const result=await f.post("/signup-email",{...f.identity,signupId:crypto.randomUUID(),email:"alice@example.com"});
    expect(result.status).toBe(i<5?200:429);
  }
  expect(f.send).toHaveBeenCalledTimes(5);
  f.coordinator.values.set("email-rate:global",{count:100,expiresAt:Date.now()+3_600_000});
  expect((await f.post("/signup-email",{...f.identity,email:"another@example.com"})).status).toBe(429);
  expect(f.send).toHaveBeenCalledTimes(5);
});

it("does not acknowledge an in-flight alert and retries failures without exposing vendor errors",async()=>{
  const f=signupFixture();
  let release!:(value:{messageId:string})=>void,entered!:()=>void;
  const started=new Promise<void>(resolve=>{entered=resolve;});
  f.send.mockImplementationOnce(()=>new Promise(resolve=>{release=resolve;entered();}));
  const request=f.alert(`did:plc:${"a".repeat(24)}`),first=worker.fetch(request.clone(),f.env);
  await started;
  expect((await worker.fetch(request.clone(),f.env)).status).toBe(503);
  release({messageId:"test"});expect((await first).status).toBe(204);
  expect((await worker.fetch(request.clone(),f.env)).status).toBe(204);expect(f.send).toHaveBeenCalledOnce();
  f.send.mockRejectedValueOnce(new Error("vendor error with private recipient and content"));
  const failed=f.alert(`did:plc:${"b".repeat(24)}`);
  expect((await worker.fetch(failed.clone(),f.env)).status).toBe(503);
  expect((await worker.fetch(failed.clone(),f.env)).status).toBe(204);
  f.send.mockRejectedValueOnce(new Error("vendor secret"));
  const response=await f.post("/signup-email",{...f.identity,email:"failed@example.com"});
  expect(response.status).toBe(503);expect(await response.text()).not.toContain("vendor secret");
});
