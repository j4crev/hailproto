import {error,json} from "@sveltejs/kit";
import {bootstrapAccount,ORIGIN} from "$lib/server/canary.js";

export async function POST({request}){
  if(request.headers.get("origin")!==ORIGIN)error(403,"Forbidden");
  const {client}=await bootstrapAccount();
  return json(await client.request("/registration/options",{},"/api/v1/auth/passkeys"));
}
