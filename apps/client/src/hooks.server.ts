import {withAccountReads} from "$lib/server/account-reads.js";
import type { Handle } from "@sveltejs/kit";
import {isAccountPath,loginPath} from "$lib/auth-routing.js";
import {isConfigured} from "$lib/server/canary.js";

export const handle: Handle = async ({ event, resolve }) => {
  if (isAccountPath(event.url.pathname) && !isConfigured(event.cookies)) {
    return new Response(null,{status:303,headers:{location:loginPath(event.url),"cache-control":"no-store","referrer-policy":"no-referrer"}});
  }
  const response = await (event.request.method === "GET" ? withAccountReads(() => resolve(event)) : resolve(event));
  response.headers.set("cache-control","no-store");
  // Native same-origin POSTs need a non-null Origin for SvelteKit's CSRF check.
  response.headers.set("referrer-policy",(event.url.pathname.startsWith("/auth/") || (event.url.pathname === "/" && event.url.searchParams.has("next")))?"no-referrer":"same-origin");
  if (event.url.pathname === "/signup/recovery") {
    // Additional policy intersects SvelteKit's nonce-bearing policy. No API calls
    // or form submissions are needed while preview recovery material is unlocked.
    const policy = response.headers.get("content-security-policy");
    response.headers.set("content-security-policy", [policy, "connect-src 'none'; form-action 'none'; frame-ancestors 'none'"].filter(Boolean).join(", "));
    response.headers.set("cache-control", "no-store");
    response.headers.set("referrer-policy", "no-referrer");
  }
  if(event.url.pathname==="/signup"){
    const policy=response.headers.get("content-security-policy");
    response.headers.set("content-security-policy",[policy,"connect-src 'self'; form-action 'none'; frame-ancestors 'none'"].filter(Boolean).join(", "));
    response.headers.set("cache-control","no-store");
    response.headers.set("referrer-policy","no-referrer");
  }
  if(event.url.pathname==="/account"||event.url.pathname==="/admin"||event.url.pathname==="/permissions"||event.url.pathname==="/connect"||event.url.pathname==="/connections"||event.url.pathname==="/settings/security"){
    response.headers.set("cache-control","no-store");response.headers.set("referrer-policy","no-referrer");
  }
  return response;
};
