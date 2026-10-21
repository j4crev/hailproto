import { canaryAccount, senderAvatars } from "$lib/server/canary.js";
import { messageId } from "$lib/server/message-id.js";
import { parseMessage } from "$lib/messages.js";
import { error,fail,isRedirect,redirect } from "@sveltejs/kit";

export async function load({ params }) {
  const { client } = await canaryAccount();
  const result = await client.request(`/inbox/${encodeURIComponent(params.sender)}/${encodeURIComponent(params.messageId)}`);
  try {
    const message=parseMessage(result);
    return {message,canReply:message.replyAvailable,
      avatar:(await senderAvatars(client,new Set([message.sender]))).get(message.sender)??null};
  } catch {
    error(502, "The provider returned a message this GUI cannot safely render");
  }
}

export const actions={reply:async({params,request})=>{
  try {
    const {client}=await canaryAccount(),original=parseMessage(await client.request(`/inbox/${encodeURIComponent(params.sender)}/${encodeURIComponent(params.messageId)}`));
    const form=await request.formData(),text=form.get("text"),allowReply=form.get("allowReply")==="yes";
    if(original.sender!==params.sender||original.messageId!==params.messageId||!original.replyAvailable||
      typeof text!=="string"||!text.trim()||Buffer.byteLength(text)>65536)
      return fail(400,{error:"This reply invitation is unavailable or the message is invalid."});
    const id=messageId(),result=await client.request("/messages",{messageId:id,text:text.trim(),replyTo:original.messageId,
      ...(allowReply?{replyUntil:Math.floor(Date.now()/1000)+7*86400}:{})});
    if(result.messageId!==id)throw new Error("Provider acknowledged another message");
    redirect(303,`/sent/${id}`);
  } catch(error_) {if(isRedirect(error_))throw error_;return fail(502,{error:"The reply could not be submitted. Refresh and try again."});}
}};
