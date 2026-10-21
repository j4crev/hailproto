import { canaryAccount, isConfigured, senderAvatars } from "$lib/server/canary.js";
import { messagePreview, parseInboxFeed } from "$lib/messages.js";

export async function load({url}) {
  if (!isConfigured()) return { configured: false as const };
  const { account, client } = await canaryAccount();
  const after=url.searchParams.get("after"),page=parseInboxFeed(await client.request(`/inbox?include=body${after?`&after=${encodeURIComponent(after)}`:""}`,undefined,"/api/v1/account",2_000_000));
  const avatars=await senderAvatars(client,new Set(page.messages.map(message=>message.sender)));
  return {configured:true as const,account,paged:after!==null,next:page.next,messages:page.messages.map(message=>({...message,
    avatar:avatars.get(message.sender)??null,preview:messagePreview(message)}))};
}
