import {error} from "@sveltejs/kit";
import {canaryAccount} from "$lib/server/canary.js";
import {parseSentSend} from "$lib/messages.js";

export async function load({params,cookies,url}){
  if(!["category","connections","message"].includes(params.kind))error(404,"Sent message not found");
  const {client}=await canaryAccount(cookies,url);
  return {trash:url.searchParams.get("trash")==="true",message:parseSentSend(await client.request(`/sent/${encodeURIComponent(params.messageId)}?kind=${params.kind}${url.searchParams.get("trash")==="true"?"&trash=true":""}`,undefined,"/api/v1/account",2_000_000))};
}
