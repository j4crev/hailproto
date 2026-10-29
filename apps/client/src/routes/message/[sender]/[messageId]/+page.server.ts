import {encodePayload} from "@hailproto/codec";
import {replyBody} from "$lib/reply.js";
import {parseThread} from "$lib/threads.js";
import { canaryAccount, senderAvatars } from "$lib/server/canary.js";
import {senderSubscription} from "$lib/server/subscription.js";
import { messageId } from "$lib/server/message-id.js";
import { parseMessage } from "$lib/messages.js";
import { error,fail,isRedirect,redirect } from "@sveltejs/kit";

export async function load({ params,cookies,url }) {
  const { account, client } = await canaryAccount(cookies,url);
  const result = await client.request(`/inbox/${encodeURIComponent(params.sender)}/${encodeURIComponent(params.messageId)}`);
  try {
    const message=parseMessage(result);
    let subscription: Awaited<ReturnType<typeof senderSubscription>> = null, subscriptionUnavailable = false;
    if (message.kind !== "connection" && account.custodyProfile === "managed") {
      try {subscription = await senderSubscription(client, account.did, message.sender);}
      catch {subscriptionUnavailable = true;}
    }
    let thread:ReturnType<typeof parseThread>|null=null,threadUnavailable=false;
    if(!message.trashedAt){try{thread=parseThread(await client.request(`/threads/${encodeURIComponent(message.sender)}/${message.messageId}`));}catch{threadUnavailable=true;}}
    return {message,account,subscription,subscriptionUnavailable,thread,threadUnavailable,newReplyId:messageId(),newReplyUntil:Math.floor(Date.now()/1000)+7*86400,canReply:!message.trashedAt&&(message.connection?.active??message.replyAvailable),
      avatar:(await senderAvatars(client,new Set([message.sender]))).get(message.sender)??null};
  } catch {
    error(502, "The provider returned a message this GUI cannot safely render");
  }
}

export const actions={reply:async({params,request,cookies,url})=>{
  const form=await request.formData(),text=form.get("text"),id=form.get("messageId"),allowReply=form.get("allowReply")==="yes",replyUntil=Number(form.get("replyUntil"));
  if(typeof id!=="string"||!/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(id)||
    (allowReply&&(!Number.isSafeInteger(replyUntil)||replyUntil<1))||typeof text!=="string"||!text.trim()||Buffer.byteLength(text)>65536)
    return fail(400,{error:"Enter a reply within the message limit.",messageId:undefined,replyUntil:undefined,allowReply,text:typeof text==="string"?text:""});
  try {
    const {client}=await canaryAccount(cookies,url);
    const source=await client.request(`/inbox/${encodeURIComponent(params.sender)}/${encodeURIComponent(params.messageId)}`);
    const original=parseMessage(source);
    const body=replyBody(source,{sender:params.sender,messageId:params.messageId},text);
    if(encodePayload("hail.body.spt-2",body).length>262144)
      return fail(400,{error:"This reply exceeds the message limit.",messageId:id,text,replyUntil,allowReply});
    if(original.kind==="connection"&&!original.connection?.active)
      return fail(409,{error:"This connection is no longer active.",messageId:id,text,replyUntil,allowReply});
    const result=await client.request("/messages",{messageId:id,body,inReplyTo:{sender:original.sender,messageId:original.messageId},
      ...(original.kind==="connection"?{connectionId:original.connection!.id,connectionEpoch:original.connection!.epoch,recipientDid:original.sender}:
        {replyTo:original.messageId,...(allowReply?{replyUntil}:{})})});
    if(result.messageId!==id)throw new Error("Provider acknowledged another message");
    redirect(303,`/sent/${id}`);
  } catch(error_) {if(isRedirect(error_))throw error_;return fail(502,{error:"The reply could not be confirmed. Check its sent status before trying again.",messageId:id,text,replyUntil,allowReply});}
}};
