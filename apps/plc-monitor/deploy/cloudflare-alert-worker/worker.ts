import { base58btc } from "multiformats/bases/base58";

const context = new TextEncoder().encode("hail.plc-monitor-alert.v1\0");
const categories = new Set(["unexpected-operation", "coverage-lost", "invalid-operation-log", "export-gap", "onboarding-enrollment"]);

interface Env {
  ALERT_EMAIL: { send(message: { to:string;from:string;subject:string;text:string }):Promise<unknown> };
  ALERT_RECIPIENT:string;
  ALERT_SENDER:string;
  MONITOR_PUBLIC_KEY:string;
}

function signature(value:string|null):Uint8Array<ArrayBuffer>|null {
  if(!value||!/^[A-Za-z0-9_-]{86}$/.test(value))return null;
  try{const raw=atob(value.replaceAll("-","+").replaceAll("_","/")+"=="),bytes=new Uint8Array(raw.length);
    for(let index=0;index<raw.length;index++)bytes[index]=raw.charCodeAt(index);return bytes;}
  catch{return null;}
}

async function verify(bytes:Uint8Array,encoded:string,keyDid:string):Promise<boolean>{
  try{
    const decoded=base58btc.decode(keyDid.slice(8));
    if(!keyDid.startsWith("did:key:z")||decoded.length!==34||decoded[0]!==0xed||decoded[1]!==1)return false;
    const signed=new Uint8Array(context.length+bytes.length);signed.set(context);signed.set(bytes,context.length);
    const publicKey=Uint8Array.from(decoded.slice(2)),sig=signature(encoded)!;
    return crypto.subtle.verify("Ed25519",await crypto.subtle.importKey("raw",publicKey,"Ed25519",false,["verify"]),sig,signed);
  }catch{return false;}
}

async function body(request:Request):Promise<Uint8Array|null>{
  if(!request.body)return null;
  const reader=request.body.getReader(),parts:Uint8Array[]=[];let length=0,done=false;
  try{while(true){const next=await reader.read();if(next.done){done=true;break;}length+=next.value.length;
    if(length>65_536)return null;parts.push(next.value);}}
  finally{if(!done)await reader.cancel();}
  if(!length)return null;
  const bytes=new Uint8Array(length);let offset=0;for(const part of parts){bytes.set(part,offset);offset+=part.length;}return bytes;
}

export default {
  async fetch(request:Request,env:Env):Promise<Response>{
    const url=new URL(request.url);
    if(request.method!=="POST"||url.pathname!=="/hail")return new Response(null,{status:404});
    if(request.headers.get("content-type")!=="application/json")return new Response(null,{status:415});
    const bytes=await body(request);if(!bytes)return new Response(null,{status:413});
    const key=request.headers.get("x-hail-monitor-key"),encoded=request.headers.get("x-hail-monitor-signature");
    if(key!==env.MONITOR_PUBLIC_KEY||!encoded||!signature(encoded)||!await verify(bytes,encoded,key))return new Response(null,{status:401});
    let alert:Record<string,unknown>;
    try{alert=JSON.parse(new TextDecoder("utf-8",{fatal:true}).decode(bytes));}catch{return new Response(null,{status:400});}
    if(!alert||Array.isArray(alert)||Object.keys(alert).length!==7||alert.type!=="hail.plc-monitor-alert"||alert.version!==1||
      typeof alert.id!=="string"||!/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/.test(alert.id)||
      typeof alert.did!=="string"||!/^did:plc:[a-z2-7]{24}$/.test(alert.did)||typeof alert.category!=="string"||!categories.has(alert.category)||
      typeof alert.occurred_at!=="string"||!Number.isFinite(Date.parse(alert.occurred_at))||!alert.detail||typeof alert.detail!=="object"||Array.isArray(alert.detail))
      return new Response(null,{status:400});
    await env.ALERT_EMAIL.send({to:env.ALERT_RECIPIENT,from:env.ALERT_SENDER,
      subject:`[Hail PLC] ${alert.category}: ${alert.did}`,
      text:`A signed Hail PLC monitor alert was received.\n\n${JSON.stringify(alert,null,2)}`});
    return new Response(null,{status:204});
  },
};
