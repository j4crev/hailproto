import {canaryAccount} from "$lib/server/canary.js";
import {parseSentSends} from "$lib/messages.js";

export async function load({url,cookies}){
  const {account,client}=await canaryAccount(cookies,url),after=url.searchParams.get("after");
  const page=parseSentSends(await client.request(`/sent?include=sends${after?`&after=${encodeURIComponent(after)}`:""}`,undefined,"/api/v1/account",2_000_000));
  return {configured:true as const,account,paged:after!==null,next:page.next,messages:page.messages};
}
