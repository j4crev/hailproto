import { canaryAccount, senderPresentations } from "$lib/server/canary.js";
import { parseMessage } from "$lib/messages.js";
import { error } from "@sveltejs/kit";

export async function load({ params }) {
  const { client } = await canaryAccount();
  const result = await client.request(`/inbox/${encodeURIComponent(params.sender)}/${encodeURIComponent(params.messageId)}`);
  try {
    const message=parseMessage(result);
    const presentation=(await senderPresentations(client,new Set([message.sender]))).get(message.sender);
    return { message, senderAddress:presentation?.address??null,avatar:presentation?.avatar??null };
  } catch {
    error(502, "The provider returned a message this GUI cannot safely render");
  }
}
