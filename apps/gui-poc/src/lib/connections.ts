import type {startAuthentication} from "@simplewebauthn/browser";
const UUID=/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/,DID=/^did:plc:[a-z2-7]{24}$/;
export const CONNECTION_APPROVAL="hail.connection-approval.v1",CONNECTION_CODE="hail.connection-code.v1";
export interface ConnectCode {id:string;did:string;token:string;}
export interface ConnectReview {id:string;did:string;address:string;expiresAt:number|null;preview:true;}
export interface ConnectApproval {requestId:string;action:string;review:Record<string,any>;expiresAt:string;
  result:{connectionId?:string;invitationId?:string;state?:string;revoked?:boolean}|null;
  options:Parameters<typeof startAuthentication>[0]["optionsJSON"]|null;}
export interface ConnectionList {preview:true;codes:{id:string;personal:boolean;label:string;expiresAt:number|null;link:string}[];
  connections:{id:string;did:string;address:string;connectedAt:string}[];}
export class ConnectionRequestError extends Error {constructor(readonly status:number,message:string){super(message);}}
export function connectionCode(hash:string):ConnectCode {
  const p=new URLSearchParams(hash.replace(/^#/,"")),id=p.get("id"),did=p.get("did"),token=p.get("token");
  if(p.size!==3||!id||!UUID.test(id)||!did||!DID.test(did)||!token||!/^[A-Za-z0-9_-]{43}$/.test(token))throw new Error("This connection code is incomplete or invalid. Ask for a current link.");
  return {id,did,token};
}
export function connectApproval(value:any):ConnectApproval {
  if(!value||!UUID.test(value.requestId)||!["create","replace","revoke","connect","disconnect"].includes(value.action)||
    !Number.isFinite(Date.parse(value.expiresAt))||!value.review||typeof value.review!=="object"||Array.isArray(value.review)||
    value.result!==null&&(!value.result||typeof value.result!=="object")||!value.result&&!value.options&&Date.parse(value.expiresAt)>Date.now())
    throw new Error("The provider returned an invalid connection review.");
  return value;
}
export async function connectionRequest(step="",body?:unknown){
  if(!["","prepare","commit","review"].includes(step)&&!UUID.test(step))throw new Error("Invalid connection action.");
  const response=await fetch("/api/v1/account/connections"+(step?"/"+step:""),{method:body===undefined?"GET":"POST",
    credentials:"same-origin",cache:"no-store",redirect:"error",signal:AbortSignal.timeout(45_000),
    headers:body===undefined?{}:{"Content-Type":"application/json"},...(body===undefined?{}:{body:JSON.stringify(body)})});
  const reader=response.body?.getReader();if(!reader)throw new Error("Connection response unavailable.");
  const chunks:Uint8Array[]=[];let size=0;
  while(true){const next=await reader.read();if(next.done)break;size+=next.value.length;if(size>131072){await reader.cancel();throw new Error("Connection response too large.");}chunks.push(next.value);}
  const bytes=new Uint8Array(size);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length;}
  let value;try{value=JSON.parse(new TextDecoder("utf-8",{fatal:true}).decode(bytes));}catch{throw new ConnectionRequestError(response.status,"Connection preview is unavailable on this provider.");}
  if(!response.ok)throw new ConnectionRequestError(response.status,typeof value?.error==="string"?value.error:"Connection request failed. Check the original approval before retrying.");
  return value;
}
