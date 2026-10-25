import type {startAuthentication} from "@simplewebauthn/browser";
import {decodeDeterministic,encodeDeterministic} from "@hailproto/codec/cbor";
import {encodeBase64Url} from "@hailproto/codec/base64url";
const UUID=/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/,DID=/^did:plc:[a-z2-7]{24}$/;
export const CONNECTION_APPROVAL="hail.connection-approval.v1",CONNECTION_CODE="hail.connection-code.v1";
export interface ConnectCode {id:string;did:string;token:string;}
export interface ConnectReview {id:string;did:string;address:string;expiresAt:number|null;preview:true;admissionSupported?:boolean;provider?:string;}
export interface ConnectApproval {requestId:string;action:string;review:Record<string,any>;expiresAt:string;
  ownerSigning?:{type:"hailp.connection-signing";version:1;provider:string;requestId:string;expiresAt:string;payload:Record<string,unknown>}|null;
  result:{connectionId?:string|null;invitationId?:string;state?:string;revoked?:boolean;attemptId?:string;propagation?:string}|null;
  options:Parameters<typeof startAuthentication>[0]["optionsJSON"]|null;}
export interface ConnectionList {preview:true;codes:{id:string;personal:boolean;label:string;expiresAt:number|null;link:string}[];
  connections:{id:string;did:string;address:string;connectedAt:string;remote?:boolean}[];
  pendingConnections?:{id:string;did:string;address:string;kind:"connect"|"disconnect";state:string}[];}
export interface ConnectionMessageTarget {connectionId:string;recipientDid:string;epoch:number;address:string;}
export function connectionMessageTargets(value:any):{maxRecipients:number;connections:ConnectionMessageTarget[]}{
  if(!value||!Number.isSafeInteger(value.maxRecipients)||value.maxRecipients<1||value.maxRecipients>100||!Array.isArray(value.connections)||value.connections.length>201||
    value.connections.some((row:any)=>!row||!UUID.test(row.connectionId)||!DID.test(row.recipientDid)||!Number.isSafeInteger(row.epoch)||row.epoch<1||typeof row.address!=="string"||row.address.length>254)||
    new Set(value.connections.map((row:any)=>row.connectionId)).size!==value.connections.length)throw new Error("Invalid connection message recipients.");
  return value;
}
export class ConnectionRequestError extends Error {constructor(readonly status:number,message:string){super(message);}}
export function signedConnectionFile(bytes:Uint8Array,proposal:NonNullable<ConnectApproval["ownerSigning"]>){
  // Inspect locally before upload: an accidentally selected vault/secret must never leave the browser.
  if(bytes.length<1||bytes.length>16384||bytes[0]!==0xd2)throw new Error("Choose the signed COSE file, not a vault or backup.");
  const parts=decodeDeterministic(bytes.slice(1));
  if(!Array.isArray(parts)||parts.length!==4||!(parts[0] instanceof Uint8Array)||parts[0].length>512||
    !parts[1]||typeof parts[1]!=="object"||Object.keys(parts[1]).length!==0||!(parts[2] instanceof Uint8Array)||
    !(parts[3] instanceof Uint8Array)||parts[3].length!==64)throw new Error("Invalid signed consent file.");
  const diagnostic=(value:any):any=>value instanceof Uint8Array?encodeBase64Url(value):Array.isArray(value)?value.map(diagnostic):
    value&&typeof value==="object"?Object.fromEntries(Object.entries(value).map(([key,item])=>[key,diagnostic(item)])):value;
  const actual=encodeDeterministic(diagnostic(decodeDeterministic(parts[2]))),expected=encodeDeterministic(proposal.payload as never);
  if(actual.length!==expected.length||!actual.every((v,i)=>v===expected[i]))throw new Error("The file must sign this exact consent proposal.");
  return encodeBase64Url(bytes);
}
export function connectionCode(hash:string):ConnectCode {
  const p=new URLSearchParams(hash.replace(/^#/,"")),id=p.get("id"),did=p.get("did"),token=p.get("token");
  if(p.size!==3||!id||!UUID.test(id)||!did||!DID.test(did)||!token||!/^[A-Za-z0-9_-]{43}$/.test(token))throw new Error("This connection code is incomplete or invalid. Ask for a current link.");
  return {id,did,token};
}
export function connectionHomeLink(origin:string,code:ConnectCode){
  const url=new URL(origin);
  if(url.protocol!=="https:"||url.origin!==origin||!url.hostname.includes(".")||/^[\d.]+$/.test(url.hostname)||url.hostname.startsWith("["))throw new Error("Enter your trusted provider's exact HTTPS origin, with no path.");
  connectionCode(new URLSearchParams({...code}).toString());
  return origin+"/connect#"+new URLSearchParams({...code});
}
export function connectApproval(value:any):ConnectApproval {
  if(!value||!UUID.test(value.requestId)||!["create","replace","revoke","connect","disconnect"].includes(value.action)||
    !Number.isFinite(Date.parse(value.expiresAt))||!value.review||typeof value.review!=="object"||Array.isArray(value.review)||
    value.result!==null&&(!value.result||typeof value.result!=="object")||!value.result&&!value.options&&Date.parse(value.expiresAt)>Date.now())
    throw new Error("The provider returned an invalid connection review.");
  const owner=value.ownerSigning;
  if(owner!==undefined&&owner!==null&&(owner.type!=="hailp.connection-signing"||owner.version!==1||owner.requestId!==value.requestId||
    owner.expiresAt!==value.expiresAt||typeof owner.provider!=="string"||!owner.payload||
    !(value.action==="connect"&&owner.payload.type==="hail.connection-confirmation"||["create","replace"].includes(value.action)&&owner.payload.type==="hail.connection-invitation")))
    throw new Error("The provider returned an invalid owner-signing proposal.");
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
