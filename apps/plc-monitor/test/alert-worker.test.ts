import {generateKeyPairSync} from "node:crypto";
import {expect,it,vi} from "vitest";
import {MonitorSigner} from "../src/signing.js";
import worker from "../deploy/cloudflare-alert-worker/worker.js";
import {encodeBase64Url} from "@hailproto/codec";

it("emails only a valid pinned signed monitor alert",async()=>{
  const signer=new MonitorSigner(generateKeyPairSync("ed25519").privateKey),
    send=vi.fn(async(_message:{to:string;from:string;subject:string;text:string})=>({messageId:"test"}));
  const env={ALERT_EMAIL:{send},ALERT_RECIPIENT:"the@j4w8n.com",ALERT_SENDER:"alerts@plcmonitor.us",MONITOR_PUBLIC_KEY:signer.publicDidKey};
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
