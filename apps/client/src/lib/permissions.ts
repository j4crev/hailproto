import qrcode from "qrcode-generator";
import type {HailGrant,HailGrantScope} from "@racrproto/codec";
import type {startAuthentication} from "@simplewebauthn/browser";

export const APPROVAL_STORAGE="hail.pending-grant-approval.v1";
export interface SenderReview {previousDids?:string[];address:string;did:string;displayName:string;addressDigest:string;profileDigest:string;
  categories:{id:string;label:string;description?:string}[];}
export interface PermissionResult {grantId:string;revision:number;status:"active"|"revoked";publication:"durable";}
export interface BatchPermissionResult {items:{grantId:string;result:PermissionResult|null;error:string|null}[];}
export interface Approval {previousDids?:string[];previousScope?:HailGrantScope[];requestId:string;action:"allow"|"revoke"|"revoke-batch"|"restrict";expiresAt:string;approved:boolean;
  permission:Pick<HailGrant,"grant_id"|"revision"|"grantor"|"grantee"|"expires_at">&{scope:HailGrantScope[];consent_context:{grantee_address:string}};
  options:Parameters<typeof startAuthentication>[0]["optionsJSON"]|null;
  permissions?:Approval["permission"][];
  result:PermissionResult|BatchPermissionResult|null;}
const UUID=/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/,DID=/^did:plc:[a-z2-7]{24}$/;
export function subscriptionScopeLabel(scope:HailGrantScope|undefined){
  if(!scope)return "Permission unavailable";
  return scope.type==="categories"?scope.values.map(value=>value==="general"?"General":value).join(", "):"Permission unavailable";
}
export function senderLink(origin:string,address:string,did:string){
  const url=new URL(origin);
  if(url.origin!==origin||url.protocol!=="https:"&&!(url.protocol==="http:"&&url.hostname==="localhost")||!DID.test(did)||
    address.length>254||!/^\S+@[^@\s]+$/.test(address))throw new Error("Invalid sender identity");
  return `${origin}/permissions#${new URLSearchParams({sender:address,did})}`;
}
export function senderRequest(hash:string){
  const params=new URLSearchParams(hash.startsWith("#")?hash.slice(1):hash),sender=params.get("sender"),did=params.get("did");
  if(!sender&&!did)return null;
  if(params.size!==2||!sender||sender.length>254||!/^\S+@[^@\s]+$/.test(sender)||!did||!DID.test(did))throw new Error("This sender QR link is incomplete or invalid. Ask for a current link or enter the address manually.");
  return {sender,did};
}
export function senderQr(value:string){
  if(value.length>1024)throw new Error("Sender link too large");
  const qr=qrcode(0,"M");qr.addData(value,"Byte");qr.make();
  const size=qr.getModuleCount(),path:string[]=[];
  for(let row=0;row<size;row++)for(let col=0;col<size;col++)if(qr.isDark(row,col))path.push(`M${col+4} ${row+4}h1v1h-1z`);
  return {size:size+8,path:path.join("")};
}
function validPermission(permission:any):boolean{
  const scope=permission?.scope?.[0];
  return !!permission&&UUID.test(permission.grant_id)&&Number.isSafeInteger(permission.revision)&&permission.revision>=1&&DID.test(permission.grantor)&&DID.test(permission.grantee)&&
    Array.isArray(permission.scope)&&permission.scope.length===1&&!!scope&&
    (scope.type==="categories"&&Array.isArray(scope.values)&&scope.values.length>0&&scope.values.every((v:unknown)=>typeof v==="string"&&/^[a-z0-9][a-z0-9._-]{0,63}$/.test(v)))&&
    (permission.expires_at===null||Number.isSafeInteger(permission.expires_at)&&permission.expires_at>0)&&
    typeof permission.consent_context?.grantee_address==="string"&&permission.consent_context.grantee_address.length<=254;
}
function validScope(scope:any):scope is HailGrantScope[]{
  return Array.isArray(scope)&&scope.length===1&&(scope[0]?.type==="categories"&&Array.isArray(scope[0].values)&&
    scope[0].values.length>0&&scope[0].values.every((v:unknown)=>typeof v==="string"&&/^[a-z0-9][a-z0-9._-]{0,63}$/.test(v)));
}
function validResult(result:any):boolean{
  return !!result&&UUID.test(result.grantId)&&Number.isSafeInteger(result.revision)&&["active","revoked"].includes(result.status)&&result.publication==="durable";
}
export function approval(value:any):Approval{
  if(value?.previousDids!==undefined&&(!Array.isArray(value.previousDids)||value.previousDids.length>20||value.previousDids.some((did:unknown)=>typeof did!=="string"||!DID.test(did))))throw new Error("Invalid identity history");
  if(!value||!UUID.test(value.requestId)||!["allow","revoke","revoke-batch","restrict"].includes(value.action)||!Number.isFinite(Date.parse(value.expiresAt))||
    typeof value.approved!=="boolean"||!value.approved&&!value.options||!validPermission(value.permission))
    throw new Error("The provider returned an invalid permission review");
  if(value.action==="restrict"){
    const before=value.previousScope?.[0],after=value.permission.scope[0];
    if(!validScope(value.previousScope)||before?.type!=="categories"||after?.type!=="categories"||
      after.values.length>=before.values.length||after.values.some((category:string)=>!before.values.includes(category))||
      value.permission.revision<2||value.permission.expires_at===undefined||value.permissions!==undefined)
      throw new Error("The provider returned an invalid category restriction review");
  }else if(value.previousScope!==undefined)throw new Error("The provider returned unexpected category restriction details");
  if(value.permissions!==undefined){
    const permissions=value.permissions;
    if(value.action!=="revoke-batch"||!Array.isArray(permissions)||!permissions.length||permissions.length>50||
      !permissions.every((permission:any)=>validPermission(permission)&&permission.grantor===value.permission.grantor)||
      new Set(permissions.map((permission:any)=>permission.grant_id)).size!==permissions.length||
      JSON.stringify(permissions[0])!==JSON.stringify(value.permission))throw new Error("The provider returned an invalid batch review");
    if(value.result){
      const items=value.result.items;
      if(!value.approved||!Array.isArray(items)||items.length!==permissions.length||items.some((item:any,index:number)=>
        !item||item.grantId!==permissions[index].grant_id||
        (item.result?(!validResult(item.result)||item.result.grantId!==item.grantId||item.result.status!=="revoked"||item.result.revision!==permissions[index].revision+1||item.error!==null):
          typeof item.error!=="string"||!item.error||item.error.length>512)))throw new Error("The provider returned an invalid batch result");
    }
  }else if(value.action==="revoke-batch"||value.result&&!validResult(value.result))throw new Error("The provider returned an invalid permission result");
  if(value.action==="restrict"&&value.result&&(!validResult(value.result)||value.result.grantId!==value.permission.grant_id||
    value.result.revision!==value.permission.revision||value.result.status!=="active"))throw new Error("The provider returned an invalid category restriction result");
  return value;
}

export class PermissionRequestError extends Error {
  constructor(public status:number,message:string){super(message);}
}

// Recovery may finish an authorized action, but must never request new consent.
export async function recoverPermission(requestId:string,grantor:string):Promise<Approval>{
  let next=approval(await permissionRequest(requestId));
  if(next.requestId!==requestId||next.permission.grantor!==grantor)throw new Error("Subscription account mismatch");
  if(next.approved&&!next.result){
    next=approval(await permissionRequest("commit",{requestId}));
    if(next.requestId!==requestId||next.permission.grantor!==grantor)throw new Error("Subscription account mismatch");
    if(!next.result)throw new Error("Subscription change is still being saved");
  }
  return next;
}

export async function permissionRequest(step:string,body?:unknown){
  if(!["review","prepare","commit"].includes(step)&&!UUID.test(step))throw new Error("Invalid permission operation");
  const response=await fetch(`/api/v1/account/permissions/${step}`,{method:body===undefined?"GET":"POST",credentials:"same-origin",redirect:"error",cache:"no-store",
    signal:AbortSignal.timeout(45_000),headers:body===undefined?{}:{"Content-Type":"application/json"},...(body===undefined?{}:{body:JSON.stringify(body)})});
  const reader=response.body?.getReader();if(!reader)throw new Error("Permission response unavailable");
  const chunks:Uint8Array[]=[];let size=0;
  while(true){const next=await reader.read();if(next.done)break;size+=next.value.length;if(size>65_536){await reader.cancel();throw new Error("Permission response too large");}chunks.push(next.value);}
  const bytes=new Uint8Array(size);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length;}
  const value=JSON.parse(new TextDecoder("utf-8",{fatal:true}).decode(bytes));
  if(!response.ok){
    const detail=response.status<500&&typeof value?.error==="string"&&value.error.length<=300?value.error:null;
    throw new PermissionRequestError(response.status,detail??(response.status===401?"Sign in with your passkey before managing permissions.":
    response.status===410?"This review expired. Check your subscriptions and start again.":
    response.status===413?"This permission review is too large. For bulk unsubscribe, select fewer subscriptions.":
    response.status===429?"Too many requests. Wait a minute and try again.":
    response.status===409?"The subscription may have changed, or your request is still being processed. Please try again.":
    response.status>=500?"Permission service unavailable. Try again shortly.":
    "Permission request failed. Please check your details and try again."));
  }
  return value;
}

/** Match the canonical ASCII Hail address rules before sender discovery. */
export function validateSenderAddress(input:string):string {
  const address=input.trim().toLowerCase(),parts=address.split('@');
  const [local='',domain='']=parts;
  if(parts.length!==2||address.length>254||local.length>63||
    !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*$/.test(local)||
    !domain.includes('.')||domain.length>253||domain.split('.').some(label=>!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label)))
    throw new Error("Enter a valid Hail address, such as sender@example.com.");
  return address;
}
