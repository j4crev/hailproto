import {canaryAccount,isConfigured,senderPresentations} from "$lib/server/canary.js";
import {messagePreview,parseSent,parseSentMessage} from "$lib/messages.js";

export async function load(){
  if(!isConfigured())return {configured:false as const};
  const {account,client}=await canaryAccount(),sent=parseSent(await client.request("/sent"));
  const presentations=await senderPresentations(client,new Set(sent.map(item=>item.recipient)));
  // ponytail: one bounded detail read per row; add a batch summary only if 50 requests becomes measurable.
  const messages=await Promise.all(sent.map(async item=>{
    try {const detail=parseSentMessage(await client.request(`/sent/${item.messageId}`));
      return {...item,recipientAddress:presentations.get(item.recipient)?.address??null,
        preview:messagePreview({...detail,deliveredAt:detail.createdAt}),header:detail.header};}
    catch{return {...item,recipientAddress:presentations.get(item.recipient)?.address??null,preview:"Message preview unavailable",header:null};}
  }));
  return {configured:true as const,account,messages};
}
