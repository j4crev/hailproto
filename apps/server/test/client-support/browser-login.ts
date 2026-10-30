import {createHash,randomBytes} from "node:crypto";
import {isIP} from "node:net";
import {resolve} from "node:path";
import {encodeBase64Url} from "@hailproto/codec";
import {credentialScopes} from "../../../../packages/hail-client-support/src/account-api.js";
import {privateFile,savePrivateBytes} from "./grant-revocation.js";
import {writeState} from "./account-creation.js";
import {ClientError} from "../../../../packages/hail-client-support/src/client-error.js";

const CLIENT="hailp-cli-v1",DEFAULT_SCOPES=["account:read","grants:read","messages:read","messages:write"];
interface BrowserLoginState {
  type:"hailp.browser-login";version:1;provider:string;scopes:string[];state:string;code:string;verifier:string;token:string;
  redirectUri:string;createdAt:number;requestId?:string;authorizationUrl?:string;expiresAt?:string;approved?:boolean;
}
type OpenBrowser=(url:string)=>Promise<void>;
type Transport=(url:string,init:RequestInit)=>Promise<Response>;

async function request(provider:string,path:string,body:Record<string,unknown>,transport:Transport){
  let response:Response;try{response=await transport(`${provider}/api/v1/auth/authorization/${path}`,{method:"POST",redirect:"error",
    headers:{"Content-Type":"application/json",Accept:"application/json","Accept-Encoding":"identity","Cache-Control":"no-store"},
    body:JSON.stringify(body),signal:AbortSignal.timeout(20_000)});}catch{throw new ClientError("TRANSPORT_ERROR","Provider authorization transport failed");}
  if(!response.ok){void response.body?.cancel();throw new Error(`Provider authorization returned HTTP ${response.status}`);}
  if(response.headers.get("Content-Type")!=="application/json"||response.headers.has("Content-Encoding")||response.headers.has("Location")){
    void response.body?.cancel();throw new Error("Provider returned an invalid authorization response");}
  const reader=response.body?.getReader();if(!reader)throw new Error("Provider returned an empty authorization response");
  const chunks:Uint8Array[]=[];let size=0;
  try{while(true){const next=await reader.read();if(next.done)break;size+=next.value.length;
    if(size>65_536)throw new Error("Provider authorization response was too large");chunks.push(next.value);}}
  catch(error){await reader.cancel().catch(()=>{});throw error;}
  const bytes=new Uint8Array(size);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length;}
  const value=JSON.parse(new TextDecoder("utf-8",{fatal:true}).decode(bytes));
  if(!value||typeof value!=="object"||Array.isArray(value))throw new Error("Provider returned an invalid authorization response");
  return value as Record<string,unknown>;
}

async function openBrowser(url:string){
  const command=process.platform==="darwin"?["open",url]:process.platform==="win32"?["rundll32","url.dll,FileProtocolHandler",url]:["xdg-open",url];
  const child=Bun.spawn(command,{stdin:"ignore",stdout:"ignore",stderr:"pipe"});
  if(await child.exited!==0)throw new Error(`Could not open the system browser: ${await new Response(child.stderr).text()}`);
}

export async function browserLogin(provider:string,requestedScopes:string[],statePath:string,output:string,browser:OpenBrowser=openBrowser,
  transport:Transport=fetch){
  if(resolve(statePath)===resolve(output))throw new Error("Browser login requires distinct private state and credential paths");
  const origin=new URL(provider);if(origin.origin!==provider||origin.protocol!=="https:"||origin.username||origin.password||origin.search||origin.hash||
    isIP(origin.hostname)!==0||!/^[a-z0-9.-]+$/.test(origin.hostname))
    throw new Error("Provider must be a canonical HTTPS origin");
  const scopes=credentialScopes(requestedScopes.length?requestedScopes:DEFAULT_SCOPES);
  if(scopes.some(scope=>!DEFAULT_SCOPES.includes(scope)))throw new Error("Browser login requested a scope outside the CLI baseline");
  let state:BrowserLoginState|null=null;
  try{state=JSON.parse(new TextDecoder("utf-8",{fatal:true}).decode(await privateFile(statePath,16_384)));}
  catch(error){if(!(error instanceof Error&&"code" in error&&error.code==="ENOENT"))throw error;}
  if(state&&(!state.redirectUri||state.type!=="hailp.browser-login"||state.version!==1||state.provider!==provider||
    JSON.stringify(state.scopes)!==JSON.stringify(scopes)||!Number.isSafeInteger(state.createdAt)||
    state.createdAt>Math.floor(Date.now()/1000)+30||Math.floor(Date.now()/1000)-state.createdAt>=300||
    !/^[A-Za-z0-9_-]{43}$/.test(state.state)||!/^hailc_[A-Za-z0-9_-]{43}$/.test(state.code)||
    !/^[A-Za-z0-9_-]{43}$/.test(state.verifier)||!/^hailp_[A-Za-z0-9_-]{43}$/.test(state.token)))
    throw new Error("Browser login state differs or expired; retain it and start a deliberate new attempt with new paths");
  const redirect=state?new URL(state.redirectUri):null;
  if(redirect&&(redirect.protocol!=="http:"||redirect.hostname!=="127.0.0.1"||redirect.pathname!=="/callback"||redirect.search||redirect.hash||
    !/^[0-9]+$/.test(redirect.port)||Number(redirect.port)<1024||Number(redirect.port)>65535))throw new Error("Browser login state has an invalid callback");
  if(state?.requestId){
    const authorization=new URL(state.authorizationUrl??"");
    if(!/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/.test(state.requestId)||authorization.origin!==provider||
      authorization.pathname!=="/auth/authorize"||authorization.searchParams.get("request")!==state.requestId||
      authorization.searchParams.get("state")!==state.state||authorization.hash!==`#code=${state.code}`||
      typeof state.expiresAt!=="string"||!Number.isFinite(Date.parse(state.expiresAt)))throw new Error("Browser login state has an invalid authorization request");
  }else if(state?.approved)throw new Error("Browser login state is incomplete");
  let approved!:()=>void,rejected!:(error:Error)=>void,expected=state;
  const callback=new Promise<void>((resolve,reject)=>{approved=resolve;rejected=reject;});
  const server=Bun.serve({hostname:"127.0.0.1",port:redirect?Number(redirect.port):0,
    async fetch(req){
      const url=new URL(req.url);
      if(req.method!=="GET"||url.pathname!=="/callback"||!expected||url.searchParams.get("state")!==expected.state||
        url.searchParams.get("code")!==expected.code||[...url.searchParams.keys()].some(key=>!["state","code"].includes(key))){
        rejected(new Error("Loopback callback did not match the browser login"));return new Response("Authorization refused",{status:400});}
      expected.approved=true;await writeState(statePath,expected);approved();
      return new Response("Hail authorization complete. You can close this tab.",{headers:{"Content-Type":"text/plain; charset=utf-8","Cache-Control":"no-store"}});
    }});
  try{
    if(!state){
      try{await privateFile(output,16_384);throw new Error("Credential output already exists without its original state");}
      catch(error){if(!(error instanceof Error&&"code" in error&&error.code==="ENOENT"))throw error;}
      state={type:"hailp.browser-login",version:1,provider,scopes,state:encodeBase64Url(randomBytes(32)),
        code:`hailc_${encodeBase64Url(randomBytes(32))}`,verifier:encodeBase64Url(randomBytes(32)),token:`hailp_${encodeBase64Url(randomBytes(32))}`,
        redirectUri:`http://127.0.0.1:${server.port}/callback`,createdAt:Math.floor(Date.now()/1000)};expected=state;await savePrivateBytes(statePath,new TextEncoder().encode(JSON.stringify(state)));
    }
    if(!state.requestId){
      const prepared=await request(provider,"prepare",{clientId:CLIENT,redirectUri:state.redirectUri,state:state.state,code:state.code,
        codeChallenge:encodeBase64Url(new Uint8Array(createHash("sha256").update(state.verifier).digest())),scopes},transport);
      if(typeof prepared.requestId!=="string"||typeof prepared.authorizationUrl!=="string"||typeof prepared.expiresAt!=="string")
        throw new Error("Provider returned an invalid authorization request");
      const url=new URL(prepared.authorizationUrl);
      if(url.origin!==provider||url.pathname!=="/auth/authorize"||url.searchParams.get("request")!==prepared.requestId||
        url.searchParams.get("state")!==state.state||url.hash!==`#code=${state.code}`||!Number.isFinite(Date.parse(prepared.expiresAt)))
        throw new Error("Provider authorization URL differs from the requested login");
      state.requestId=prepared.requestId;state.authorizationUrl=prepared.authorizationUrl;state.expiresAt=prepared.expiresAt;await writeState(statePath,state);
    }
    if(!state.approved){
      await browser(state.authorizationUrl!);
      const timeout=Math.max(0,Math.min(Date.parse(state.expiresAt!)-Date.now(),300_000));
      let timer:ReturnType<typeof setTimeout>|undefined;
      try{await Promise.race([callback,new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new Error("Browser authorization expired or was cancelled")),timeout);})]);}
      finally{if(timer)clearTimeout(timer);}
    }
    const credential=await request(provider,"token",{clientId:CLIENT,redirectUri:state.redirectUri,code:state.code,verifier:state.verifier,token:state.token},transport);
    if(credential.type!=="hailp.api-credential"||credential.version!==1||credential.provider!==provider||credential.token!==state.token||
      typeof credential.accountId!=="string"||!/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/.test(credential.accountId)||
      typeof credential.credentialId!=="string"||!/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/.test(credential.credentialId)||
      typeof credential.expiresAt!=="string"||!Number.isFinite(Date.parse(credential.expiresAt))||
      JSON.stringify(credentialScopes(credential.scopes))!==JSON.stringify(scopes))throw new Error("Provider credential differs from the authorized login");
    try{await savePrivateBytes(output,new TextEncoder().encode(JSON.stringify(credential)));}
    catch(error){if(!(error instanceof Error&&"code" in error&&error.code==="EEXIST"))throw error;
      const saved=JSON.parse(new TextDecoder("utf-8",{fatal:true}).decode(await privateFile(output,16_384)));
      if(JSON.stringify(saved)!==JSON.stringify(credential))throw new Error("Credential output conflicts with the browser authorization");}
    return {credentialId:credential.credentialId,credentialFile:output,accountId:credential.accountId,scopes,expiresAt:credential.expiresAt};
  }finally{server.stop(true);}
}
