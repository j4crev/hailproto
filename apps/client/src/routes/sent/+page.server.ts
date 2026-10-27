import {canaryAccount} from "$lib/server/canary.js";
import {messagePreview,parseSentFeed} from "$lib/messages.js";

export async function load({url,cookies}){
  const {account,client}=await canaryAccount(cookies,url),after=url.searchParams.get("after");
  const page=parseSentFeed(await client.request(`/sent?include=body${after?`&after=${encodeURIComponent(after)}`:""}`,undefined,"/api/v1/account",2_000_000));
  const messages=page.messages.map(message=>({...message,
    preview:messagePreview({...message,deliveredAt:message.createdAt})}));
  return {configured:true as const,account,paged:after!==null,next:page.next,messages};
}
