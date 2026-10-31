import {canaryAccount} from "$lib/server/canary.js";
import {parseConversationPreferences} from "$lib/conversation-preferences.js";

export async function load({cookies,url,setHeaders}) {
  setHeaders({"cache-control":"no-store"});
  const {client}=await canaryAccount(cookies,url);
  return {preferences:parseConversationPreferences(await client.request("/connections/conversation-preferences"))};
}
