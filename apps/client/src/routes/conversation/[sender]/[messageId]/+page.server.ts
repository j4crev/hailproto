import {canaryAccount,senderAvatars} from '$lib/server/canary.js';
import {parseConversation} from '$lib/connection-threads.js';
import {parseMessage,parseSentMessage} from '$lib/messages.js';
import {messageId} from '$lib/server/message-id.js';
export async function load({params,cookies,url}) {
  const {client,account}=await canaryAccount(cookies,url);
  const thread=parseConversation(await client.request(`/connection-threads/${encodeURIComponent(params.sender)}/${encodeURIComponent(params.messageId)}`));
  const selected=thread.selected;
  const raw=await client.request(selected.sent?`/sent/${selected.messageId}`:`/inbox/${encodeURIComponent(selected.sender)}/${selected.messageId}`);
  const message=selected.sent?parseSentMessage(raw):parseMessage(raw);
  const avatars=await senderAvatars(client,new Set(thread.messages.filter(m=>!m.sent).map(m=>m.sender)));
  return {account,thread,message,avatars:Object.fromEntries(avatars),root:params,newReplyId:messageId()};
}
