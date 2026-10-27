import {canaryAccount} from "$lib/server/canary.js";
export async function load({cookies, url}) {
  const {account,client} = await canaryAccount(cookies, url);
  const preferences=await client.request("/message-preferences");
  return {account,trashEnabled:preferences.trashEnabled!==false};
}
