import qrcode from "qrcode-generator";
import type {HailGrant,HailGrantScope} from "@hailproto/codec";
import type {startAuthentication} from "@simplewebauthn/browser";

export const APPROVAL_STORAGE="hail.pending-grant-approval.v1";
export interface SenderReview {address:string;did:string;displayName:string;addressDigest:string;profileDigest:string;
  offersUncategorized:boolean;categories:{id:string;label:string;description?:string}[];}
export interface PermissionResult {grantId:string;revision:number;status:"active"|"revoked";publication:"durable";}
export interface BatchPermissionResult {items:{grantId:string;result:PermissionResult|null;error:string|null}[];}
export interface Approval {requestId:string;action:"allow"|"revoke"|"revoke-batch";expiresAt:string;approved:boolean;
  permission:Pick<HailGrant,"grant_id"|"revision"|"grantor"|"grantee"|"expires_at">&{scope:HailGrantScope[];consent_context:{grantee_address:string}};
  options:Parameters<typeof startAuthentication>[0]["optionsJSON"]|null;
  permissions?:Approval["permission"][];
  result:PermissionResult|BatchPermissionResult|null;}
const UUID=/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/,DID=/^did:plc:[a-z2-7]{24}$/;
export function subscriptionScopeLabel(scope:HailGrantScope|undefined){
  if(!scope)return "Permission unavailable";
  return scope.type==="categories"?scope.values.map(value=>value==="general"?"General":value).join(", "):"Legacy uncategorized";
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
    (scope.type==="uncategorized"||scope.type==="categories"&&Array.isArray(scope.values)&&scope.values.length>0&&scope.values.every((v:unknown)=>typeof v==="string"&&/^[a-z0-9][a-z0-9._-]{0,63}$/.test(v)))&&
    (permission.expires_at===null||Number.isSafeInteger(permission.expires_at)&&permission.expires_at>0)&&
    typeof permission.consent_context?.grantee_address==="string"&&permission.consent_context.grantee_address.length<=254;
}
function validResult(result:any):boolean{
  return !!result&&UUID.test(result.grantId)&&Number.isSafeInteger(result.revision)&&["active","revoked"].includes(result.status)&&result.publication==="durable";
}
export function approval(value:any):Approval{
  if(!value||!UUID.test(value.requestId)||!["allow","revoke","revoke-batch"].includes(value.action)||!Number.isFinite(Date.parse(value.expiresAt))||
    typeof value.approved!=="boolean"||!value.approved&&!value.options||!validPermission(value.permission))
    throw new Error("The provider returned an invalid permission review");
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
  if(!response.ok)throw new PermissionRequestError(response.status,response.status===401?"Sign in with your passkey before managing permissions.":
    response.status===410?"This review expired. Check your subscriptions and start again.":
    response.status===413?"This permission review is too large. For bulk unsubscribe, select fewer subscriptions.":
    response.status===429?"Too many requests. Wait a minute and try again.":
    response.status===409?"The subscription may have changed, or your request is still being processed. Please try again.":
    "Permission was not confirmed. Please try again. The sender must have a current published Sender Profile.");
  return value;
}
