import {error} from "@sveltejs/kit";
import {canaryAccount} from "$lib/server/canary.js";
import {AccountApiError} from "../../../../cli/src/account-api.js";

type Invitation={id:string;email:string|null;created_at:string;expires_at:string;status:string;delivery:string};
export async function load({cookies,url}){
  const {account,client}=await canaryAccount(cookies,url);
  try{
    const result=await client.request("/invitations",undefined,"/api/v1/operator");
    if(!Array.isArray(result.invitations))error(502,"Invalid invitation list");
    return {account,invitations:result.invitations as Invitation[]};
  }catch(cause){
    if(cause instanceof AccountApiError){
      if(cause.status===403)error(403,"This account does not have provider operator access.");
      if(cause.status===404)error(404,"Provider invitations are not enabled on this server.");
    }
    throw cause;
  }
}
