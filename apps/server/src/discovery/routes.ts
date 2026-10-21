import { encodeBase64Url } from "@hailproto/codec";
import type { Hono } from "hono";
import { canonicalizeHailAddress } from "../identity/address.js";
import type { DiscoveryStore } from "./store.js";

export const ADDRESS_BINDING_REL = "https://hailproto.com/rel/address-binding";
export const COSE_SIGN1_MEDIA_TYPE = 'application/cose; cose-type="cose-sign1"';

function notFound(): Response {
  return Response.json(
    { type: "about:blank", title: "Not Found", status: 404 },
    {
      status: 404,
      headers: { "Cache-Control": "no-store", "Content-Type": "application/problem+json" },
    },
  );
}

export function registerDiscoveryRoutes(
  app: Hono,
  publicOrigin: string,
  store: DiscoveryStore,
): void {
  app.get("/.well-known/webfinger", async (context) => {
    const resource = context.req.query("resource");
    const relation = context.req.query("rel");
    if (!resource?.startsWith("acct:") || relation !== ADDRESS_BINDING_REL) {
      return notFound();
    }

    let address: string;
    try {
      address = canonicalizeHailAddress(resource.slice("acct:".length));
    } catch {
      return notFound();
    }
    const binding = await store.findPublishedByAddress(address);
    if (!binding) return notFound();
    const maxAge = Math.max(
      0,
      Math.min(300, Math.floor((binding.expiresAt.getTime() - Date.now()) / 1_000)),
    );
    const body = JSON.stringify({
      subject: `acct:${address}`,
      links: [
        {
          rel: ADDRESS_BINDING_REL,
          type: COSE_SIGN1_MEDIA_TYPE,
          href: `${publicOrigin}/.well-known/hail/addresses/${binding.id}`,
        },
      ],
    });
    return new Response(body, {
      status: 200,
      headers: {
        "Cache-Control": `public, max-age=${maxAge}`,
        "Content-Type": "application/jrd+json",
      },
    });
  });

  app.get("/.well-known/hail/addresses/:bindingId", async (context) => {
    const bindingId = context.req.param("bindingId");
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(bindingId)) {
      return notFound();
    }
    const binding = await store.findPublishedById(bindingId);
    if (!binding) return notFound();
    const maxAge = Math.max(
      0,
      Math.min(300, Math.floor((binding.expiresAt.getTime() - Date.now()) / 1_000)),
    );
    return new Response(Uint8Array.from(binding.cose), {
      status: 200,
      headers: {
        "Cache-Control": `public, max-age=${maxAge}`,
        "Content-Type": COSE_SIGN1_MEDIA_TYPE,
        ETag: `"${encodeBase64Url(binding.digest)}"`,
      },
    });
  });
}
