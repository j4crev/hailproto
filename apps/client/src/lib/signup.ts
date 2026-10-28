import { decodeBase64Url, encodeBase64Url } from "@hailproto/codec/base64url";
import { bytes, cipher, validateVault, type UserVaultFile } from "../../../cli/src/vault-crypto.js";
import type { PublicOnboardingPreparation } from "../../../server/src/onboarding/public.js";
import type { Operation } from "@did-plc/lib";

export interface SignupPolicy { provider:string; monitorOrigin:string; monitorKey:string; }
export interface PendingSignup {
  type:"hail.pending-signup"; version:1|2; policy:SignupPolicy; signupId:string; address:string;
  token:string; enrollmentToken:string; invitation:string; vault:UserVaultFile;
  email:string;
  operation:Operation|null; did:string|null;
}
export interface SignupSummary {
  type:"hail.signup"; version:1; signupId:string; accountId:string|null; address:string; did:string|null;
  state:"recovery-required"|"preparing"|"prepared"|"awaiting-monitor"|"passkey-enrollment"|"enrollment-expired"|"sign-in-required";
  operation?:Operation|null;
  expiresAt:string; preparation:PublicOnboardingPreparation|null; enrollmentExpiresAt:string|null;
}
export const PENDING_STORAGE="hail.pending-signup.v1";
const uuid=/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/,token=/^hailp_[A-Za-z0-9_-]{43}$/;
const aad=new TextEncoder().encode("hail.pending-signup.v1");
export const setupToken=()=>`hailp_${encodeBase64Url(crypto.getRandomValues(new Uint8Array(32)))}`;
export async function enrollmentHash(value:string){return encodeBase64Url(new Uint8Array(await crypto.subtle.digest("SHA-256",new TextEncoder().encode(value))));}
export async function pendingKey(secret:string){
  const raw=decodeBase64Url(secret,32);
  try{return await cipher(raw);}finally{raw.fill(0);}
}
export function validatePending(value:PendingSignup,policy:SignupPolicy):PendingSignup{
  if(!value||Object.keys(value).length!==12||Object.keys(value).some(key=>!["type","version","policy","signupId","address","token","enrollmentToken","invitation","vault","email","operation","did"].includes(key))||
    value.type!=="hail.pending-signup"||![1,2].includes(value.version)||!uuid.test(value.signupId)||
    !token.test(value.token)||!token.test(value.enrollmentToken)||value.token===value.enrollmentToken||
    typeof value.invitation!=="string"||value.invitation.length>2048||
    typeof value.email!=="string"||value.email.length>254||(value.version===1?!value.email.includes("@"):value.email!==""&&!value.email.includes("@"))||
    typeof value.address!=="string"||!new RegExp(`^[a-z0-9][a-z0-9._-]{0,63}@`).test(value.address)||
    value.address.split("@").length!==2||value.address.split("@")[1]!==new URL(policy.provider).hostname||
    value.policy?.provider!==policy.provider||value.policy?.monitorOrigin!==policy.monitorOrigin||value.policy?.monitorKey!==policy.monitorKey||
    (value.did!==null&&!/^did:plc:[a-z2-7]{24}$/.test(value.did))||
    (value.operation!==null&&(!value.operation||value.operation.type!=="plc_operation"||typeof value.operation.sig!=="string")))
    throw new Error("This is not the pending signup for this provider and monitoring policy.");
  validateVault(value.vault);
  if(value.vault.did!==null)throw new Error("Only unfinished signup state can be reopened here.");
  return value;
}
export async function sealPending(value:PendingSignup,key:CryptoKey){
  const nonce=crypto.getRandomValues(new Uint8Array(12));
  const ciphertext=await crypto.subtle.encrypt({name:"AES-GCM",iv:nonce,additionalData:aad},key,new TextEncoder().encode(JSON.stringify(value)));
  return JSON.stringify({type:"hail.pending-signup.encrypted",version:1,nonce:encodeBase64Url(nonce),ciphertext:encodeBase64Url(new Uint8Array(ciphertext))});
}
export async function openPending(text:string,key:CryptoKey,policy:SignupPolicy){
  if(new TextEncoder().encode(text).length>65_536)throw new Error("Pending setup file is too large.");
  const file=JSON.parse(text);
  if(file?.type!=="hail.pending-signup.encrypted"||file.version!==1||Object.keys(file).length!==4)throw new Error("Choose an encrypted pending setup file.");
  const raw=new Uint8Array(await crypto.subtle.decrypt({name:"AES-GCM",iv:bytes(decodeBase64Url(file.nonce,12)),additionalData:aad},key,bytes(decodeBase64Url(file.ciphertext))));
  try{return validatePending(JSON.parse(new TextDecoder("utf-8",{fatal:true}).decode(raw)),policy);}finally{raw.fill(0);}
}

export class SignupRequestError extends Error {
  constructor(readonly status:number,readonly retryAfter:number){
    super(status===410?"Setup authority expired. Keep your recovery kit and setup file; do not start a replacement identity. Contact the provider.":
      status===403?"Invitation or setup authority refused or retired. If you already finished, sign in with your passkey.":
      status===409?"The address, invitation or retained signup state conflicts. Keep this setup file; do not replace keys or retry with different intent.":
      status===429?"Too many attempts. Wait before retrying with the same setup.":
      "Setup could not finish. Keep the original setup state and retry; nothing will be silently replaced.");
  }
}
export async function signupRequest(path:string,body:unknown|undefined,authority?:string,request:(...args:Parameters<typeof fetch>)=>Promise<Response>=fetch):Promise<any>{
  // No caller-selected origin, redirects, vendor errors or recovery material.
  if(!/^\/api\/v1\/(signup(?:\/check-address|\/[0-9a-f-]{36}(?:\/(?:advance|complete|verify-backup))?)?|signup-email\/(?:start|verify)|auth\/passkeys\/(?:recovery(?:\/options)?|authentication(?:\/options)?))$/.test(path))throw new Error("Unexpected signup endpoint");
  const response=await request(path,{method:body===undefined?"GET":"POST",credentials:"same-origin",redirect:"error",cache:"no-store",
    signal:AbortSignal.timeout(35_000),headers:{...(body===undefined?{}:{"Content-Type":"application/json"}),...(authority?{Authorization:`Bearer ${authority}`}:{})},
    ...(body===undefined?{}:{body:JSON.stringify(body)})});
  const retry=Number(response.headers.get("Retry-After"));
  if(!response.ok){await response.body?.cancel();throw new SignupRequestError(response.status,Number.isSafeInteger(retry)&&retry>0?Math.min(retry,3600):15);}
  const reader=response.body?.getReader();if(!reader)throw new Error("Unexpected signup response");
  const chunks:Uint8Array[]=[];let size=0;
  while(true){const next=await reader.read();if(next.done)break;size+=next.value.length;
    if(size>32_768){await reader.cancel();throw new Error("Unexpected signup response");}chunks.push(next.value);}
  const raw=new Uint8Array(size);let offset=0;for(const chunk of chunks){raw.set(chunk,offset);offset+=chunk.length;}
  const text=new TextDecoder("utf-8",{fatal:true}).decode(raw);
  const value=JSON.parse(text);
  if(value.error)throw new SignupRequestError(response.status,15);
  return value;
}
export function checkSummary(value:SignupSummary,pending:PendingSignup):SignupSummary{
  if(value?.type!=="hail.signup"||value.version!==1||value.signupId!==pending.signupId||value.address!==pending.address||
    !["recovery-required","preparing","prepared","awaiting-monitor","passkey-enrollment","enrollment-expired","sign-in-required"].includes(value.state)||
    !Number.isFinite(Date.parse(value.expiresAt))||value.accountId!==null&&!uuid.test(value.accountId)||
    value.did!==null&&!/^did:plc:[a-z2-7]{24}$/.test(value.did)||pending.did!==null&&value.did!==null&&pending.did!==value.did||
    pending.operation&&value.operation&&JSON.stringify(pending.operation)!==JSON.stringify(value.operation))
    throw new Error("Provider response differs from retained signup intent.");
  return value;
}
