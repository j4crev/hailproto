import {error} from "@sveltejs/kit";
import {canaryAccount} from "$lib/server/canary.js";

type Passkey={credentialId:string;label:string;deviceType:string;backedUp:boolean;createdAt:string;lastUsedAt:string|null;current:boolean};

export async function load({cookies,url}){
  const {client}=await canaryAccount(cookies,url),result=await client.request("/passkeys",undefined,"/api/v1/auth");
  if(typeof result.recentlyVerified!=="boolean"||!Array.isArray(result.passkeys))error(502,"Invalid passkey list");
  const passkeys=result.passkeys.map(value=>{
    if(!value||typeof value!=="object"||Array.isArray(value))error(502,"Invalid passkey list");
    const item=value as Record<string,unknown>;
    if(typeof item.credentialId!=="string"||typeof item.label!=="string"||typeof item.deviceType!=="string"||
      typeof item.backedUp!=="boolean"||typeof item.createdAt!=="string"||item.lastUsedAt!==null&&typeof item.lastUsedAt!=="string"||
      typeof item.current!=="boolean")error(502,"Invalid passkey list");
    return item as Passkey;
  });
  return {recentlyVerified:result.recentlyVerified,passkeys};
}
