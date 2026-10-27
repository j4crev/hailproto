import {canaryAccount} from "$lib/server/canary.js";
export async function load({cookies, url}) {
  const {account} = await canaryAccount(cookies, url);
  return {account};
}
