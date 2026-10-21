import { canaryAccount, isConfigured, senderAddresses } from "$lib/server/canary.js";
import { messagePreview, parseInbox, parseMessage } from "$lib/messages.js";

export async function load() {
  if (!isConfigured()) return { configured: false as const };
  const { account, client } = await canaryAccount();
  const inbox = parseInbox(await client.request("/inbox"));
  const senderDids = new Set(inbox.map((message) => message.sender));
  const addresses = await senderAddresses(client, senderDids);
  // ponytail: one bounded detail read per inbox row; add a batch summary endpoint if a real inbox outgrows 50 rows.
  const messages = await Promise.all(inbox.map(async (message) => {
    try {
      const detail = parseMessage(await client.request(`/inbox/${encodeURIComponent(message.sender)}/${encodeURIComponent(message.messageId)}`));
      return { ...message, senderAddress: addresses.get(message.sender) ?? null, preview: messagePreview(detail) };
    } catch {
      return { ...message, senderAddress: addresses.get(message.sender) ?? null, preview: "Preview unavailable" };
    }
  }));
  return { configured: true as const, account, messages };
}
