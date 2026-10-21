import {error} from "@sveltejs/kit";
import {canaryAccount,senderPresentations} from "$lib/server/canary.js";
import {parseSentMessage} from "$lib/messages.js";

export async function load({params}){
  const {client}=await canaryAccount();
  try{const message=parseSentMessage(await client.request(`/sent/${encodeURIComponent(params.messageId)}`));
    return {message,recipientAddress:(await senderPresentations(client,new Set([message.recipient]))).get(message.recipient)?.address??null};}
  catch{error(502,"The provider returned a sent message this GUI cannot safely render");}
}
