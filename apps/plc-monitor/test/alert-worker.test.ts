import {generateKeyPairSync} from "node:crypto";
import {expect,it,vi} from "vitest";
import {MonitorSigner} from "../src/signing.js";
import worker from "../deploy/cloudflare-alert-worker/worker.js";
import {encodeBase64Url} from "@hailproto/codec";

it("emails only a valid pinned signed monitor alert",async()=>{
  const signer=new MonitorSigner(generateKeyPairSync("ed25519").privateKey),
    send=vi.fn(async(_message:{to:string;from:string;subject:string;text:string})=>({messageId:"test"}));
  const env={ALERT_EMAIL:{send},ALERT_RECIPIENT:"the@j4w8n.com",ALERT_SENDER:"alerts@plcmonitor.us",MONITOR_PUBLIC_KEY:signer.publicDidKey,
    HEARTBEAT_TOKEN:"token",BACKUP_TOKEN:"backup",PROVIDER_HEALTH_URL:"https://haili.app/health/ready",HAIL_PRODUCTION_MONITOR:{get:vi.fn(),put:vi.fn()}};
  const payload=JSON.stringify({type:"hail.plc-monitor-alert",version:1,id:"00000000-0000-0000-0000-000000000000",
    did:`did:plc:${"a".repeat(24)}`,category:"unexpected-operation",detail:{operationCid:"bafyrei"},occurred_at:new Date().toISOString()});
  const bytes=new TextEncoder().encode(payload),request=(signature:Uint8Array)=>new Request("https://alerts.plcmonitor.us/hail",{
    method:"POST",headers:{"Content-Type":"application/json","Content-Length":String(bytes.length),
      "X-Hail-Monitor-Key":signer.publicDidKey,"X-Hail-Monitor-Signature":encodeBase64Url(signature)},body:bytes});
  expect((await worker.fetch(request(signer.signAlert(bytes)),env)).status).toBe(204);
  expect(send).toHaveBeenCalledWith(expect.objectContaining({to:"the@j4w8n.com",from:"alerts@plcmonitor.us"}));
  expect(send.mock.calls[0]![0].text).not.toContain("Monitor key:");
  const bad=signer.signAlert(bytes);bad[0]=bad[0]!^1;
  expect((await worker.fetch(request(bad),env)).status).toBe(401);
  expect(send).toHaveBeenCalledOnce();
});

it("accepts authenticated heartbeats and alerts only on health transitions",async()=>{
  const values=new Map<string,string>(),send=vi.fn(async(_message:{to:string;from:string;subject:string;text:string})=>({messageId:"test"})),put=vi.fn(async(key:string,value:string)=>{values.set(key,value)}),
    env={ALERT_EMAIL:{send},ALERT_RECIPIENT:"the@j4w8n.com",ALERT_SENDER:"alerts@plcmonitor.us",MONITOR_PUBLIC_KEY:"unused",
      HEARTBEAT_TOKEN:"secret",BACKUP_TOKEN:"backup",PROVIDER_HEALTH_URL:"https://haili.app/health/ready",HAIL_PRODUCTION_MONITOR:{get:async(key:string)=>values.get(key)??null,put}};
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
