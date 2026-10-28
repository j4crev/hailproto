import {registration} from "$lib/server/registration.js";
import {returnPath} from "$lib/auth-routing.js";
import { canaryAccount, isConfigured, senderAvatars } from "$lib/server/canary.js";
import { messageListSummary, parseInboxFeed } from "$lib/messages.js";

export async function load({url,cookies,fetch,setHeaders}) {
  if (url.searchParams.has("next")) {setHeaders({"cache-control":"no-store"});return {configured:false as const,returnTo:returnPath(url.searchParams.get("next")),registration:await registration(fetch)};}
  const view=url.searchParams.get("view")==="connections"?"connections":"subscriptions";
  if (!isConfigured(cookies)&&view!=="connections") {setHeaders({"cache-control":"no-store"});return { configured: false as const,returnTo:"/",registration:await registration(fetch) };}
  const { account, client } = await canaryAccount(cookies,url);
  const after=url.searchParams.get("after"),page=parseInboxFeed(await client.request(`/inbox?include=body&kind=${view}${after?`&after=${encodeURIComponent(after)}`:""}`,undefined,"/api/v1/account",2_000_000));
  const avatars=await senderAvatars(client,new Set(page.messages.map(message=>message.sender)));
  return {configured:true as const,account,view,paged:after!==null,next:page.next,messages:page.messages.map(message=>({...message,
    avatar:avatars.get(message.sender)??null,...messageListSummary(message)}))};
}
