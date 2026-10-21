import {error} from "@sveltejs/kit";
import {canaryAccount} from "$lib/server/canary.js";
import {parseSentMessage} from "$lib/messages.js";

export async function load({params}){
  const {client}=await canaryAccount();
  try{return {message:parseSentMessage(await client.request(`/sent/${encodeURIComponent(params.messageId)}`))};}
  catch{error(502,"The provider returned a sent message this GUI cannot safely render");}
}
