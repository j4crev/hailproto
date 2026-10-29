import {canaryAccount, isConfigured} from "$lib/server/canary.js";

export async function load({cookies, url}) {
  // Presentation only. Page loaders still validate the provider session.
  const hasAccountSession = isConfigured(cookies);
  let accountAvatar: {did: string; src: string} | null = null;
  const focused = (url.pathname === "/" && url.searchParams.has("next")) ||
    url.pathname.startsWith("/auth/") || url.pathname.startsWith("/signup");
  if (hasAccountSession && !focused) {
    try {
      const {account} = await canaryAccount(cookies, url);
      accountAvatar = {did:account.did,src:`/api/v1/account/senders/${encodeURIComponent(account.did)}/avatar/image`};
    } catch {
      // An unavailable optional avatar must not block navigation or sign-in.
    }
  }
  return {hasAccountSession, accountAvatar};
}
