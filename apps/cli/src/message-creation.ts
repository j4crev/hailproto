import {randomUUID} from "node:crypto";
import {readFile,stat} from "node:fs/promises";
import {privateFile,savePrivateBytes} from "./grant-revocation.js";
import type {AccountApiClient} from "./account-api.js";

export async function sendMessage(client:AccountApiClient,file:string,statePath:string,grantId?:string,
  category?:string,replyTo?:string,replyUntil?:number) {
  const info=await stat(file);if(!info.isFile()||info.size>65536)throw new Error("Message text file must be at most 64 KiB");
  const text=new TextDecoder("utf-8",{fatal:true}).decode(await readFile(file));
  const request={text,...(grantId?{grantId,category:category ?? ""}:{replyTo}),...(replyUntil===undefined?{}:{replyUntil})};
  let state:Record<string,unknown>;
  const account=await client.account();if(account.migrationState||!account.scopes.includes("messages:write"))throw new Error("Account cannot send messages");
  try{state=JSON.parse(new TextDecoder().decode(await privateFile(statePath,524288)));}
  catch(error){if(!(error instanceof Error&&"code" in error&&error.code==="ENOENT"))throw error;
    const clock=Date.now().toString(16).padStart(12,"0"),random=randomUUID();
    const messageId=`${clock.slice(0,8)}-${clock.slice(8)}-7${random.slice(15,18)}-${random.slice(19)}`;
    state={accountId:account.accountId,provider:account.provider,request:{messageId,...request}};
    await savePrivateBytes(statePath,new TextEncoder().encode(JSON.stringify(state)));}
  const saved=state.request as Record<string,unknown>;
  if(state.accountId!==account.accountId||state.provider!==account.provider||!saved||typeof saved.messageId!=="string"||
    JSON.stringify({...saved,messageId:undefined})!==JSON.stringify(request))throw new Error("Message retry changed account or content");
  return client.request("/messages",saved);
}
