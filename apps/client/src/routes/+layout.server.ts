import {canaryAccount, isConfigured} from "$lib/server/canary.js";
import {avatarSource} from "$lib/avatar.js";
import {editableProfile} from "$lib/sender-profile.js";

export async function load({cookies, url}) {
  // Presentation only. Page loaders still validate the provider session.
  const hasAccountSession = isConfigured(cookies);
  let accountAvatar: {did: string; src: string} | null = null;
  const focused = (url.pathname === "/" && url.searchParams.has("next")) ||
    url.pathname.startsWith("/auth/") || url.pathname.startsWith("/signup");
  if (hasAccountSession && !focused) {
    try {
      const {account, client} = await canaryAccount(cookies, url);
      const {payload} = await client.profile();
      if (payload.did === account.did) {
        const src = avatarSource(editableProfile(payload).avatar);
        if (src) accountAvatar = {did: account.did, src};
      }
    } catch {
      // An unavailable optional avatar must not block navigation or sign-in.
    }
  }
  return {hasAccountSession, accountAvatar};
}
