import {canaryAccount} from "$lib/server/canary.js";
import {parseConversationPreferences} from "$lib/conversation-preferences.js";
export async function load({cookies, url, setHeaders}) {
  setHeaders({"cache-control":"no-store"});
  const {account,client} = await canaryAccount(cookies, url);
  const [preferences,conversations]=await Promise.all([
    client.request("/message-preferences"),
    client.request("/connections/conversation-preferences").then(parseConversationPreferences),
  ]);
  return {account,trashEnabled:preferences.trashEnabled!==false,allowIntroductions:conversations.allowIntroductions};
}
