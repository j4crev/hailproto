import { canaryAccount, isConfigured, senderPresentations } from "$lib/server/canary.js";
import { messagePreview, parseInbox, parseMessage } from "$lib/messages.js";

export async function load() {
  if (!isConfigured()) return { configured: false as const };
  const { account, client } = await canaryAccount();
  const inbox = parseInbox(await client.request("/inbox"));
  const senderDids = new Set(inbox.map((message) => message.sender));
  const presentations = await senderPresentations(client, senderDids);
  // ponytail: one bounded detail read per inbox row; add a batch summary endpoint if a real inbox outgrows 50 rows.
  const messages = await Promise.all(inbox.map(async (message) => {
    try {
      const detail = parseMessage(await client.request(`/inbox/${encodeURIComponent(message.sender)}/${encodeURIComponent(message.messageId)}`));
       return { ...message, senderAddress: presentations.get(message.sender)?.address ?? null,
         avatar:presentations.get(message.sender)?.avatar??null,preview: messagePreview(detail), header: detail.header };
    } catch {
      return { ...message, senderAddress: presentations.get(message.sender)?.address ?? null,
        avatar:presentations.get(message.sender)?.avatar??null,preview: "Preview unavailable", header: null };
    }
  }));
  return { configured: true as const, account, messages };
}
