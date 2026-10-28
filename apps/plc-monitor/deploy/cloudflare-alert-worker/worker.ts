import { alertMessage } from "./alert-message.js";
import { base58btc } from "multiformats/bases/base58";
import { parseJsonWithoutDuplicateKeys } from "../../src/strict-json.js";
import { pruneSignupEmail, sendEmail, signupEmail, signupEmailPaths,
  type DurableStorage, type EmailEnvironment, type Recipient } from "./signup-email.js";
import { authenticated, hash, boundedBody } from "../../src/http.js";
import { EMAIL_BINDING_CONTEXT, SIGNUP_ALERT_PATH, SIGNUP_BINDING_PATH, checkEmailBindingQuery } from "../../src/email-binding.js";

const context = new TextEncoder().encode("hail.plc-monitor-alert.v1\0");
const categories = new Set(["unexpected-operation", "coverage-lost", "invalid-operation-log", "export-gap", "onboarding-enrollment", "operation-status", "monitoring-restored"]);

export interface Env extends EmailEnvironment {
  ALERT_RECIPIENT:string;
  ALERT_SENDER:string;
  BACKUP_TOKEN:string;
  HEARTBEAT_TOKEN:string;
  HAIL_PRODUCTION_MONITOR:{get(key:string):Promise<string|null>;put(key:string,value:string):Promise<void>};
  MONITOR_PUBLIC_KEY:string;
  PROVIDER_HEALTH_URL:string;
  ALERT_DEDUPLICATOR:{idFromName(name:string):unknown;get(id:unknown):{fetch(request:Request):Promise<Response>}};
  SIGNUP_EMAIL_TOKEN?:string;
}
interface DurableState {storage:DurableStorage}

const heartbeatKey="monitor-heartbeat",backupKey="backup-heartbeat",staleAfterMs=6*60_000,backupStaleAfterMs=26*60*60_000;

async function email(env:Env,subject:string,text:string):Promise<void>{
  await sendEmail(env,{to:env.ALERT_RECIPIENT,from:env.ALERT_SENDER,subject,text});
}

export class AlertDeduplicator {
  constructor(private readonly state:DurableState,private readonly env:Env){}
  async fetch(request:Request):Promise<Response>{
    if(request.method!=="POST")return new Response(null,{status:405});
    const path=new URL(request.url).pathname;
    const bytes=await boundedBody(request,signupEmailPaths.has(path)||path==="/binding"?4096:65_536);
    if(!bytes)return new Response(null,{status:413});
    let alert:Record<string,unknown>;
    try{alert=parseJsonWithoutDuplicateKeys(new TextDecoder("utf-8",{fatal:true}).decode(bytes)) as Record<string,unknown>;}catch{return new Response(null,{status:400});}
    if(signupEmailPaths.has(path))return signupEmail(path,alert,this.state.storage,this.env);
    if(path==="/binding"){
      try{checkEmailBindingQuery(alert,Math.floor(Date.now()/1000));}catch{return new Response(null,{status:400});}
      const recipient=await this.state.storage.get<Recipient>(`recipient:${alert.did}`);
      if(!recipient||recipient.signupId!==alert.signupId||recipient.signupHash!==alert.signupHash||recipient.operationCid!==alert.operationCid)
        return new Response(null,{status:409,headers:{"Cache-Control":"no-store"}});
      return Response.json({bound:true,did:alert.did,operationCid:alert.operationCid},{headers:{"Cache-Control":"no-store"}});
    }
    if(!alert||typeof alert!=="object"||Array.isArray(alert)||typeof alert.id!=="string"||typeof alert.did!=="string"||typeof alert.category!=="string")return new Response(null,{status:400});
    const consumer=path==="/alert/signup",recipient=await this.state.storage.get<Recipient>(`recipient:${alert.did}`);
    if(consumer&&(!recipient||alert.category==="onboarding-enrollment"&&
      (alert.detail as Record<string,unknown>|undefined)?.operationCid!==recipient.operationCid))return new Response(null,{status:409});
    const digest=await hash(new TextDecoder().decode(bytes));
    // An earlier operator-fallback acknowledgement cannot satisfy consumer delivery.
    const key=`alert:${consumer?"signup:":""}${alert.id}`,now=Date.now(),claim=crypto.randomUUID(),claimed=await this.state.storage.transaction(async storage=>{
      const prior=await storage.get<{state:string;updatedAt:number;digest?:string}>(key);
      if(prior?.digest&&prior.digest!==digest)return "conflict";
      if(prior?.state==="sent")return "sent";
      if(prior&&now-prior.updatedAt<5*60_000)return "busy";
      await storage.put(key,{state:"sending",digest,claim,updatedAt:now,expiresAt:now+30*86400_000});return "send";
    });
    if(claimed!=="send")return new Response(null,{status:claimed==="sent"?204:claimed==="busy"?503:409});
    try{
      await sendEmail(this.env,{to:recipient?.email??this.env.ALERT_RECIPIENT,from:this.env.ALERT_SENDER,
        ...alertMessage(alert,recipient?.hailAddress)});
      await this.state.storage.transaction(async storage=>{
        if((await storage.get<{claim:string}>(key))?.claim===claim)
          await storage.put(key,{state:"sent",digest,claim,updatedAt:Date.now(),expiresAt:Date.now()+30*86400_000});
      });
      for(const [stored,value] of await this.state.storage.list<{expiresAt:number}>({prefix:"alert:"}))
        if(value.expiresAt<=now)await this.state.storage.delete(stored);
      return new Response(null,{status:204});
    }catch{
      await this.state.storage.transaction(async storage=>{if((await storage.get<{claim:string}>(key))?.claim===claim)await storage.delete(key);});
      return new Response(null,{status:503});
    }
  }
  async alarm():Promise<void>{await pruneSignupEmail(this.state.storage);}
}

async function recordHealth(env:Env,name:string,ok:boolean,detail:string):Promise<void>{
  const key=`health:${name}`,next=ok?"ok":"down",previous=await env.HAIL_PRODUCTION_MONITOR.get(key);
  if(previous!==next){
    if(next==="down"||previous==="down")await email(env,`[Hail ops] ${name} ${next}`,`${name} is ${next}.\n\n${detail}`);
    await env.HAIL_PRODUCTION_MONITOR.put(key,next);
  }
}

function signature(value:string|null):Uint8Array<ArrayBuffer>|null {
  if(!value||!/^[A-Za-z0-9_-]{86}$/.test(value))return null;
  try{const raw=atob(value.replaceAll("-","+").replaceAll("_","/")+"=="),bytes=new Uint8Array(raw.length);
    for(let index=0;index<raw.length;index++)bytes[index]=raw.charCodeAt(index);return bytes;}
  catch{return null;}
}

async function verify(bytes:Uint8Array,encoded:string,keyDid:string,domain=context):Promise<boolean>{
  try{
    const decoded=base58btc.decode(keyDid.slice(8));
    if(!keyDid.startsWith("did:key:z")||decoded.length!==34||decoded[0]!==0xed||decoded[1]!==1)return false;
    const signed=new Uint8Array(domain.length+bytes.length);signed.set(domain);signed.set(bytes,domain.length);
    const publicKey=Uint8Array.from(decoded.slice(2)),sig=signature(encoded)!;
    return crypto.subtle.verify("Ed25519",await crypto.subtle.importKey("raw",publicKey,"Ed25519",false,["verify"]),sig,signed);
  }catch{return false;}
}

export default {
  async fetch(request:Request,env:Env):Promise<Response>{
    const url=new URL(request.url);
    if(signupEmailPaths.has(url.pathname)){
      if(request.method!=="POST")return new Response(null,{status:405});
      if(!env.SIGNUP_EMAIL_TOKEN)return new Response(null,{status:503});
      if(!await authenticated(request,env.SIGNUP_EMAIL_TOKEN))return new Response(null,{status:401});
      if(request.headers.get("content-type")!=="application/json"||request.headers.has("content-encoding"))return new Response(null,{status:415});
      const bytes=await boundedBody(request,4096);if(!bytes)return new Response(null,{status:413});
      const id=env.ALERT_DEDUPLICATOR.idFromName("hail-monitor-alerts");
      try{return await env.ALERT_DEDUPLICATOR.get(id).fetch(new Request(`https://deduplicator.internal${url.pathname}`,{
        method:"POST",headers:{"Content-Type":"application/json"},body:Uint8Array.from(bytes).buffer}));}
      catch{return new Response(null,{status:503,headers:{"Cache-Control":"no-store"}});}
    }
    if(request.method==="POST"&&url.pathname==="/heartbeat"){
      if(!env.HEARTBEAT_TOKEN||request.headers.get("authorization")!==`Bearer ${env.HEARTBEAT_TOKEN}`)return new Response(null,{status:401});
      await env.HAIL_PRODUCTION_MONITOR.put(heartbeatKey,String(Date.now()));
      return new Response(null,{status:204});
    }
    if(request.method==="POST"&&url.pathname==="/backup-heartbeat"){
      if(!env.BACKUP_TOKEN||request.headers.get("authorization")!==`Bearer ${env.BACKUP_TOKEN}`)return new Response(null,{status:401});
      await env.HAIL_PRODUCTION_MONITOR.put(backupKey,String(Date.now()));
      return new Response(null,{status:204});
    }
    const bindingQuery=url.pathname===SIGNUP_BINDING_PATH,consumer=url.pathname===SIGNUP_ALERT_PATH;
    if(request.method!=="POST"||url.pathname!=="/hail"&&!consumer&&!bindingQuery)return new Response(null,{status:404});
    if(request.headers.get("content-type")!=="application/json")return new Response(null,{status:415});
    const bytes=await boundedBody(request,bindingQuery?4096:65_536);if(!bytes)return new Response(null,{status:413});
    const key=request.headers.get("x-hail-monitor-key"),encoded=request.headers.get("x-hail-monitor-signature");
    if(key!==env.MONITOR_PUBLIC_KEY||!encoded||!signature(encoded)||!await verify(bytes,encoded,key,
      bindingQuery?new TextEncoder().encode(EMAIL_BINDING_CONTEXT):context))return new Response(null,{status:401});
    let alert:Record<string,unknown>;
    try{alert=parseJsonWithoutDuplicateKeys(new TextDecoder("utf-8",{fatal:true}).decode(bytes)) as Record<string,unknown>;}catch{return new Response(null,{status:400});}
    if(!alert||typeof alert!=="object"||Array.isArray(alert))return new Response(null,{status:400});
    if(bindingQuery){
      try{checkEmailBindingQuery(alert,Math.floor(Date.now()/1000));}catch{return new Response(null,{status:400});}
      const id=env.ALERT_DEDUPLICATOR.idFromName("hail-monitor-alerts");
      return env.ALERT_DEDUPLICATOR.get(id).fetch(new Request("https://deduplicator.internal/binding",{method:"POST",
        headers:{"Content-Type":"application/json"},body:Uint8Array.from(bytes).buffer}));
    }
    const occurred=typeof alert.occurred_at==="string"?Date.parse(alert.occurred_at):NaN,now=Date.now();
    if(!alert||Array.isArray(alert)||Object.keys(alert).length!==7||alert.type!=="hail.plc-monitor-alert"||alert.version!==1||
      typeof alert.id!=="string"||!/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/.test(alert.id)||
      typeof alert.did!=="string"||!/^did:plc:[a-z2-7]{24}$/.test(alert.did)||typeof alert.category!=="string"||!categories.has(alert.category)||
      !Number.isFinite(occurred)||occurred>now+5*60_000||occurred<now-7*86400_000||!alert.detail||typeof alert.detail!=="object"||Array.isArray(alert.detail))
      return new Response(null,{status:400});
    const id=env.ALERT_DEDUPLICATOR.idFromName("hail-monitor-alerts");
    return env.ALERT_DEDUPLICATOR.get(id).fetch(new Request(`https://deduplicator.internal/alert${consumer?"/signup":""}`,{method:"POST",
      headers:{"Content-Type":"application/json"},body:Uint8Array.from(bytes).buffer}));
  },
  async scheduled(_controller:unknown,env:Env):Promise<void>{
    let providerOk=false,providerDetail="health request failed";
    try{const response=await fetch(env.PROVIDER_HEALTH_URL,{signal:AbortSignal.timeout(10_000)});
      providerDetail=`${env.PROVIDER_HEALTH_URL} returned HTTP ${response.status}`;providerOk=response.ok;}
    catch(error){providerDetail=`${env.PROVIDER_HEALTH_URL} failed: ${error instanceof Error?error.message:"unknown error"}`;}
    await recordHealth(env,"haili provider",providerOk,providerDetail);
    const heartbeat=Number(await env.HAIL_PRODUCTION_MONITOR.get(heartbeatKey)),age=Date.now()-heartbeat;
    await recordHealth(env,"PLC monitor",Number.isFinite(heartbeat)&&heartbeat>0&&age<=staleAfterMs,
      heartbeat>0?`Last authenticated heartbeat was ${Math.floor(age/1000)} seconds ago.`:"No authenticated heartbeat has been received.");
    const backup=Number(await env.HAIL_PRODUCTION_MONITOR.get(backupKey)),backupAge=Date.now()-backup;
    await recordHealth(env,"provider backup",Number.isFinite(backup)&&backup>0&&backupAge<=backupStaleAfterMs,
      backup>0?`Last verified encrypted backup was ${Math.floor(backupAge/3_600_000)} hours ago.`:"No verified backup heartbeat has been received.");
  },
};
