import {env} from "$env/dynamic/private";
import {brandingFromEnvironment} from "$lib/branding.js";
import {canaryAccount, isConfigured} from "$lib/server/canary.js";

export async function load({cookies, url, depends}) {
  depends("hail:mailbox");
  let unreadCounts: {subscriptions: number; connections: number} | null = null;
  // Presentation only. Page loaders still validate the provider session.
  const hasAccountSession = isConfigured(cookies);
  let accountAvatar: {did: string; src: string} | null = null;
  const focused = (url.pathname === "/" && url.searchParams.has("next")) ||
    url.pathname.startsWith("/auth/") || url.pathname.startsWith("/signup");
  if (hasAccountSession && !focused) {
    try {
      const {account, client} = await canaryAccount(cookies, url);
      accountAvatar = {did:account.did,src:`/api/v1/account/senders/${encodeURIComponent(account.did)}/avatar/image`};
      const counts = await client.request("/unread-counts");
      if (typeof counts.subscriptions === "number" && typeof counts.connections === "number" && Number.isSafeInteger(counts.subscriptions) && counts.subscriptions >= 0 && Number.isSafeInteger(counts.connections) && counts.connections >= 0) unreadCounts = {subscriptions:counts.subscriptions,connections:counts.connections};
    } catch {
      // Optional navigation data must not block navigation or sign-in.
    }
  }
  return {hasAccountSession, accountAvatar, unreadCounts, branding: brandingFromEnvironment(env)};
}
