import {canaryAccount,senderAvatars} from "$lib/server/canary.js";
import type {ConnectionList} from "$lib/connections.js";
export async function load({cookies,url,setHeaders}) {
  setHeaders({"cache-control":"no-store"});
  const {account,client}=await canaryAccount(cookies,url);
  // Keep the component's retry UI available when connection preview is unavailable.
  let initialList:ConnectionList|null=null;
  try{initialList=await client.request('/connections') as unknown as ConnectionList;}catch{}
  const avatars=await senderAvatars(client,new Set((initialList?.connections??[]).map(connection=>connection.did)));
  return {account,initialList,avatars:Object.fromEntries(avatars)};
}
