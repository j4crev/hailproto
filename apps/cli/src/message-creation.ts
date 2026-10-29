import {randomUUID} from "node:crypto";
import {readFile,stat} from "node:fs/promises";
import {privateFile,savePrivateBytes} from "./grant-revocation.js";
import type {AccountApiClient} from "./account-api.js";

export async function sendMessage(client:AccountApiClient,file:string,statePath:string,grantId?:string,
  category?:string,replyTo?:string,replyUntil?:number,connectionId?:string) {
  const info=await stat(file);if(!info.isFile()||info.size>65536)throw new Error("Message text file must be at most 64 KiB");
  const text=new TextDecoder("utf-8",{fatal:true}).decode(await readFile(file));
  let state:Record<string,unknown>|undefined;
  const account=await client.account();if(account.migrationState||!account.scopes.includes("messages:write"))throw new Error("Account cannot send messages");
  try{state=JSON.parse(new TextDecoder().decode(await privateFile(statePath,524288)));}
  catch(error){if(!(error instanceof Error&&"code" in error&&error.code==="ENOENT"))throw error;}
  let connection:Record<string,unknown>|undefined;
  if(connectionId){
    if(grantId||replyTo||category||replyUntil!==undefined)throw new Error("Connection sends cannot use subscription or reply-capability options");
    // Exact retries retain the original recipient and epoch, even after removal.
    // The provider rechecks that authority; never silently select a new connection.
    if(state){
      const saved=state.request as Record<string,unknown>;
      connection={connectionId,connectionEpoch:saved?.connectionEpoch,recipientDid:saved?.recipientDid};
    }else{
      const listed=await client.request("/connections/cli-list");
      const selected=Array.isArray(listed.connections)?listed.connections.filter(row=>row.id===connectionId):[];
      if(selected.length!==1)throw new Error("Selected connection is not active on this account");
      connection={connectionId,connectionEpoch:selected[0].epoch,recipientDid:selected[0].did};
    }
    if(!Number.isSafeInteger(connection.connectionEpoch)||Number(connection.connectionEpoch)<1||typeof connection.recipientDid!=="string"||!/^did:plc:[a-z2-7]{24}$/.test(connection.recipientDid))
      throw new Error("Connection must identify one peer and a current epoch; update the provider if epoch metadata is missing");
  }
  const request={text,...(connection??(grantId?{grantId,category:category ?? ""}:{replyTo})),...(replyUntil===undefined?{}:{replyUntil})};
  if(!state){
    const clock=Date.now().toString(16).padStart(12,"0"),random=randomUUID();
    const messageId=`${clock.slice(0,8)}-${clock.slice(8)}-7${random.slice(15,18)}-${random.slice(19)}`;
    state={accountId:account.accountId,provider:account.provider,request:{messageId,...request}};
    await savePrivateBytes(statePath,new TextEncoder().encode(JSON.stringify(state)));}
  const saved=state.request as Record<string,unknown>;
  if(state.accountId!==account.accountId||state.provider!==account.provider||!saved||typeof saved.messageId!=="string"||
    JSON.stringify({...saved,messageId:undefined})!==JSON.stringify(request))throw new Error("Message retry changed account or content");
  return client.request("/messages",saved);
}
