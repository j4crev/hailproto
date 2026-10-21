import {error,fail,isRedirect,redirect} from "@sveltejs/kit";
import {canaryAccount} from "$lib/server/canary.js";
import {parseSentMessage} from "$lib/messages.js";

export async function load({params}){
  const {client}=await canaryAccount();
  try{return {message:parseSentMessage(await client.request(`/sent/${encodeURIComponent(params.messageId)}`))};}
  catch{error(502,"The provider returned a sent message this GUI cannot safely render");}
}

export const actions={retry:async({params})=>{
  try{const {client}=await canaryAccount(),message=parseSentMessage(await client.request(`/sent/${encodeURIComponent(params.messageId)}`));
    if(message.state!=="indeterminate")return fail(409,{error:"Only a message without an authenticated receipt can be retried."});
    await client.request(`/messages/${encodeURIComponent(params.messageId)}/submit`,{});redirect(303,`/sent/${params.messageId}`);
  }catch(error_){if(isRedirect(error_))throw error_;return fail(502,{error:"Submission retry failed. Wait before trying again."});}
}};
