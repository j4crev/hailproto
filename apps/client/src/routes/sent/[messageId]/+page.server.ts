import {parseThread} from "$lib/threads.js";
import {error,fail,isRedirect,redirect} from "@sveltejs/kit";
import {canaryAccount} from "$lib/server/canary.js";
import {parseSentMessage} from "$lib/messages.js";

export async function load({params,cookies,url}){
  const {client}=await canaryAccount(cookies,url);
  try{
    const message=parseSentMessage(await client.request(`/sent/${encodeURIComponent(params.messageId)}`));
    let thread:ReturnType<typeof parseThread>|null=null,threadUnavailable=false;
    try{thread=parseThread(await client.request(`/threads/${encodeURIComponent(message.sender)}/${message.messageId}`));}catch{threadUnavailable=true;}
    return {message,thread,threadUnavailable};
  }
  catch{error(502,"The provider returned a sent message this GUI cannot safely render");}
}

export const actions={retry:async({params,cookies,url})=>{
  try{const {client}=await canaryAccount(cookies,url),message=parseSentMessage(await client.request(`/sent/${encodeURIComponent(params.messageId)}`));
    if(message.state!=="indeterminate")return fail(409,{error:"Only a message without an authenticated receipt can be retried."});
    await client.request(`/messages/${encodeURIComponent(params.messageId)}/submit`,{});redirect(303,`/sent/${params.messageId}`);
  }catch(error_){if(isRedirect(error_))throw error_;return fail(502,{error:"Submission retry failed. Wait before trying again."});}
}};
