import { decodeBase64Url, encodeBase64Url } from "@hailproto/codec";
import type { Hono } from "hono";
import { COSE_SIGN1_MEDIA_TYPE } from "../discovery/routes.js";
import { acceptsCoseSign1 } from "../http/media-type.js";
import type { SenderProfileStore } from "./store.js";

const PROFILE_PATH = /^\/hail\/profiles\/(did:plc:[a-z2-7]{24})$/;
const STRONG_ETAG = /^"([A-Za-z0-9_-]{43})"$/;

function problem(status: number, title: string, headers: HeadersInit = {}): Response {
  return Response.json(
    { type: "about:blank", title, status },
    {
      status,
      headers: {
        "Cache-Control": "no-store",
        "Content-Type": "application/problem+json",
        ...headers,
      },
    },
  );
}

function parseIfNoneMatch(value: string | undefined): string | null | undefined {
  if (value === undefined) return undefined;
  const match = STRONG_ETAG.exec(value);
  if (!match?.[1]) return null;
  try {
    if (decodeBase64Url(match[1]).length !== 32) return null;
  } catch {
    return null;
  }
  return match[1];
}

export function registerSenderProfileRoutes(app: Hono, store: SenderProfileStore): void {
  app.all("/hail/profiles/*", async (context) => {
    const url = new URL(context.req.url);
    const match = PROFILE_PATH.exec(url.pathname);
    if (!match?.[1] || url.search) return problem(404, "Not Found");
    if (context.req.method !== "GET") {
      return problem(405, "Method Not Allowed", { Allow: "GET" });
    }
    if (!acceptsCoseSign1(context.req.header("Accept"))) {
      return problem(406, "Not Acceptable");
    }
    const requestedEtag = parseIfNoneMatch(context.req.header("If-None-Match"));
    if (requestedEtag === null) return problem(400, "Bad Request");

    const profile = await store.findCurrentByDid(match[1]);
    if (!profile) return problem(404, "Not Found");
    const etagValue = encodeBase64Url(profile.digest);
    const responseHeaders = {
      "Cache-Control": "public, max-age=3600",
      ETag: `"${etagValue}"`,
    };
    if (requestedEtag === etagValue) {
      return new Response(null, { status: 304, headers: responseHeaders });
    }
    return new Response(Uint8Array.from(profile.cose), {
      status: 200,
      headers: {
        ...responseHeaders,
        "Content-Length": String(profile.cose.byteLength),
        "Content-Type": COSE_SIGN1_MEDIA_TYPE,
      },
    });
  });
}
