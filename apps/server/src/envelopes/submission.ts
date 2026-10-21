import { createHash } from "node:crypto";
import { encodeBase64Url, inspectSignedPayload } from "@hailproto/codec";
import { COSE_SIGN1_MEDIA_TYPE } from "../discovery/routes.js";
import type { SafeHttpsTransport } from "../discovery/safe-fetch.js";
import type { HailDidResolver } from "../plc/resolver.js";
import type { EnvelopeRepository } from "./repository.js";
import type { DeliveryStatusReceiver } from "../delivery/status-receiver.js";

export async function submitEnvelope(sender:string,id:string,repository:EnvelopeRepository,resolver:HailDidResolver,
  receiver:DeliveryStatusReceiver,transport:Pick<SafeHttpsTransport,"fetch"|"validateTarget">) {
  const bytes=await repository.sent(sender,id);if(!bytes)throw new Error("Sent envelope is not stored");
  const inspected=inspectSignedPayload("hail.envelope",bytes);
  if(inspected.payload.from!==sender||inspected.payload.message_id!==id)throw new Error("Stored envelope does not match sender/message");
  const destination=await resolver.resolve(inspected.payload.to);
  const url=new URL(`${destination.serviceBase}/envelopes`);await transport.validateTarget(url);
  const response=await transport.fetch(new Request(url,{method:"POST",body:Uint8Array.from(bytes),redirect:"manual",
    signal:AbortSignal.timeout(15000),headers:{"Content-Type":COSE_SIGN1_MEDIA_TYPE,"Accept-Encoding":"identity","Cache-Control":"no-store"}}));
  if(response.headers.has("Content-Encoding")||![200,202].includes(response.status)){await response.body?.cancel();throw new Error("Envelope submission unavailable; retry the same message ID");}
  const reader=response.body?.getReader();const chunks:Uint8Array[]=[];let length=0;
  try{if(reader)while(true){const next=await reader.read();if(next.done)break;length+=next.value.length;if(length>16384)throw new Error("Receipt exceeds limit");chunks.push(next.value);}}
  catch(error){await reader?.cancel().catch(()=>{});throw error;}
  const receipt=new Uint8Array(length);let offset=0;for(const chunk of chunks){receipt.set(chunk,offset);offset+=chunk.length;}
  const digest=encodeBase64Url(new Uint8Array(createHash("sha256").update(inspected.payloadBytes).digest()));
  if(response.status===200){
    if(response.headers.get("Content-Type")!==COSE_SIGN1_MEDIA_TYPE||await receiver.receive(digest,receipt)!=="acknowledged")throw new Error("Submission status did not authenticate");
    const status=inspectSignedPayload("hail.delivery-status",receipt).payload;
    return {messageId:id,envelopeDigest:digest,state:status.state,revision:status.revision};
  }
  if(response.headers.get("Content-Type")!=="application/json"||new TextDecoder("utf-8",{fatal:true}).decode(receipt)!=='{"outcome":"received"}')throw new Error("Invalid generic receipt");
  return {messageId:id,envelopeDigest:digest,outcome:"received",accepted:false};
}
