import type {OperatorStats} from "../../../../server/src/operator/stats.js";
import {error} from "@sveltejs/kit";
import {canaryAccount} from "$lib/server/canary.js";
import {AccountApiError} from "../../../../../packages/hail-client-support/src/account-api.js";

type Invitation={id:string;email:string|null;created_at:string;expires_at:string;status:string;delivery:string};
export async function load({cookies,url}){
  const {account,client}=await canaryAccount(cookies,url);
  try{
    const result=await client.request("/invitations",undefined,"/api/v1/operator");
    if(!Array.isArray(result.invitations))error(502,"Invalid invitation list");
    const requested=url.searchParams.get("range")??"day";
    const range=["day","week","month"].includes(requested)?requested:"day";
    let stats:OperatorStats|null=null;
    try{stats=await client.request(`/stats?range=${range}`,undefined,"/api/v1/operator") as OperatorStats;}
    catch(cause){if(!(cause instanceof AccountApiError)||![429,503].includes(cause.status))throw cause;}
    const registration=await client.request("/registration",undefined,"/api/v1/operator");
    if(registration.mode!=="invite"&&registration.mode!=="public")error(502,"Invalid registration policy");
    return {account,signupMode:registration.mode as "invite"|"public",invitations:result.invitations as Invitation[],stats,range};
  }catch(cause){
    if(cause instanceof AccountApiError){
      if(cause.status===403)error(403,"This account does not have provider operator access.");
      if(cause.status===404)error(404,"Provider invitations are not enabled on this server.");
    }
    throw cause;
  }
}
