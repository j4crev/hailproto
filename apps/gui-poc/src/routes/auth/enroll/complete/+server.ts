import {error,json} from "@sveltejs/kit";
import {bootstrapAccount,ORIGIN} from "$lib/server/canary.js";
import {boundedJson} from "$lib/server/request.js";

export async function POST({request}){
  if(request.headers.get("origin")!==ORIGIN)error(403,"Forbidden");
  const {client}=await bootstrapAccount();
  return json(await client.request("/registration",await boundedJson(request),"/api/v1/auth/passkeys"));
}
