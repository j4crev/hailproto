import { base58btc } from "multiformats/bases/base58";

const context = new TextEncoder().encode("hail.plc-monitor-alert.v1\0");
const categories = new Set(["unexpected-operation", "coverage-lost", "invalid-operation-log", "export-gap", "onboarding-enrollment"]);

interface Env {
  ALERT_EMAIL: { send(message: { to:string;from:string;subject:string;text:string }):Promise<unknown> };
  ALERT_RECIPIENT:string;
  ALERT_SENDER:string;
  BACKUP_TOKEN:string;
  HEARTBEAT_TOKEN:string;
  HAIL_PRODUCTION_MONITOR:{get(key:string):Promise<string|null>;put(key:string,value:string):Promise<void>};
  MONITOR_PUBLIC_KEY:string;
  PROVIDER_HEALTH_URL:string;
  ALERT_DEDUPLICATOR:{idFromName(name:string):unknown;get(id:unknown):{fetch(request:Request):Promise<Response>}};
}

interface DurableStorage {
  get<T>(key:string):Promise<T|undefined>;put(key:string,value:unknown):Promise<void>;delete(key:string):Promise<boolean>;
  list<T>(options:{prefix:string}):Promise<Map<string,T>>;
  transaction<T>(callback:(transaction:Pick<DurableStorage,"get"|"put"|"delete">)=>Promise<T>):Promise<T>;
}
interface DurableState {storage:DurableStorage}

const heartbeatKey="monitor-heartbeat",backupKey="backup-heartbeat",staleAfterMs=6*60_000,backupStaleAfterMs=26*60*60_000;

async function email(env:Env,subject:string,text:string):Promise<void>{
  await env.ALERT_EMAIL.send({to:env.ALERT_RECIPIENT,from:env.ALERT_SENDER,subject,text});
}

export class AlertDeduplicator {
  constructor(private readonly state:DurableState,private readonly env:Env){}
  async fetch(request:Request):Promise<Response>{
    if(request.method!=="POST")return new Response(null,{status:405});
    let alert:Record<string,unknown>;
    try{alert=await request.json() as Record<string,unknown>;}catch{return new Response(null,{status:400});}
    if(typeof alert.id!=="string"||typeof alert.did!=="string"||typeof alert.category!=="string")return new Response(null,{status:400});
    const key=`alert:${alert.id}`,now=Date.now(),claimed=await this.state.storage.transaction(async storage=>{
      const prior=await storage.get<{state:string;updatedAt:number}>(key);
      if(prior&&(prior.state==="sent"||now-prior.updatedAt<5*60_000))return false;
      await storage.put(key,{state:"sending",updatedAt:now,expiresAt:now+30*86400_000});return true;
    });
    if(!claimed)return new Response(null,{status:204});
    try{
      await email(this.env,`[Hail PLC] ${alert.category}: ${alert.did}`,
        `A signed Hail PLC monitor alert was received.\n\n${JSON.stringify(alert,null,2)}`);
      await this.state.storage.put(key,{state:"sent",updatedAt:Date.now(),expiresAt:Date.now()+30*86400_000});
      for(const [stored,value] of await this.state.storage.list<{expiresAt:number}>({prefix:"alert:"}))
        if(value.expiresAt<=now)await this.state.storage.delete(stored);
      return new Response(null,{status:204});
    }catch{await this.state.storage.delete(key);return new Response(null,{status:503});}
  }
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
    if(request.method==="POST"&&url.pathname==="/heartbeat"){
      if(request.headers.get("authorization")!==`Bearer ${env.HEARTBEAT_TOKEN}`)return new Response(null,{status:401});
      await env.HAIL_PRODUCTION_MONITOR.put(heartbeatKey,String(Date.now()));
      return new Response(null,{status:204});
    }
    if(request.method==="POST"&&url.pathname==="/backup-heartbeat"){
      if(request.headers.get("authorization")!==`Bearer ${env.BACKUP_TOKEN}`)return new Response(null,{status:401});
      await env.HAIL_PRODUCTION_MONITOR.put(backupKey,String(Date.now()));
      return new Response(null,{status:204});
    }
    if(request.method!=="POST"||url.pathname!=="/hail")return new Response(null,{status:404});
    if(request.headers.get("content-type")!=="application/json")return new Response(null,{status:415});
    const bytes=await body(request);if(!bytes)return new Response(null,{status:413});
    const key=request.headers.get("x-hail-monitor-key"),encoded=request.headers.get("x-hail-monitor-signature");
    if(key!==env.MONITOR_PUBLIC_KEY||!encoded||!signature(encoded)||!await verify(bytes,encoded,key))return new Response(null,{status:401});
    let alert:Record<string,unknown>;
    try{alert=JSON.parse(new TextDecoder("utf-8",{fatal:true}).decode(bytes));}catch{return new Response(null,{status:400});}
    const occurred=typeof alert.occurred_at==="string"?Date.parse(alert.occurred_at):NaN,now=Date.now();
    if(!alert||Array.isArray(alert)||Object.keys(alert).length!==7||alert.type!=="hail.plc-monitor-alert"||alert.version!==1||
      typeof alert.id!=="string"||!/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/.test(alert.id)||
      typeof alert.did!=="string"||!/^did:plc:[a-z2-7]{24}$/.test(alert.did)||typeof alert.category!=="string"||!categories.has(alert.category)||
      !Number.isFinite(occurred)||occurred>now+5*60_000||occurred<now-7*86400_000||!alert.detail||typeof alert.detail!=="object"||Array.isArray(alert.detail))
      return new Response(null,{status:400});
    const id=env.ALERT_DEDUPLICATOR.idFromName("hail-monitor-alerts");
    return env.ALERT_DEDUPLICATOR.get(id).fetch(new Request("https://deduplicator.internal/alert",{method:"POST",
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
