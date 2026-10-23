import type { Handle } from "@sveltejs/kit";

export const handle: Handle = async ({ event, resolve }) => {
  const response = await resolve(event);
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
  return response;
};
