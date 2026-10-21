import { createHash } from "node:crypto";
import { decodeBase64Url, encodeBase64Url } from "@hailproto/codec";
import type { Hono } from "hono";
import { BODY_MEDIA_TYPE, type BodyStore } from "./service.js";

const PATH = /^\/hail\/bodies\/([A-Za-z0-9_-]{43})$/;
const BEARER = /^Bearer ([A-Za-z0-9_-]{43})$/i;
const WAIT_MS = 150;

function problem(status: number, title: string, headers: Record<string, string> = {}): Response {
  return Response.json({ type: "about:blank", title, status }, {
    status,
    headers: { "Content-Type": "application/problem+json", "Cache-Control": "no-store", ...headers },
  });
}

function canonical32(value: string): Uint8Array | null {
  try {
    const bytes = decodeBase64Url(value);
    return bytes.length === 32 && encodeBase64Url(bytes) === value ? bytes : null;
  } catch {
    return null;
  }
}

function acceptsBody(value: string | undefined): boolean {
  if (value === undefined) return true;
  return value.split(",").some((part) => {
    const [type, ...params] = part.trim().split(";");
    if (params.some((param) => !/^q=(?:0(?:\.\d{1,3})?|1(?:\.0{1,3})?)$/.test(param.trim()))) return false;
    const quality = params.length ? Number(params[0]!.trim().slice(2)) : 1;
    return quality > 0 && [BODY_MEDIA_TYPE, "application/*", "*/*"].includes(type!.trim().toLowerCase());
  });
}

export function registerBodyRoutes(app: Hono, store: BodyStore): void {
  let windowStart = Date.now();
  let count = 0;
  app.all("/hail/bodies/*", async (context) => {
    const started = Date.now();
    const now = Date.now();
    if (now - windowStart >= 60_000) { windowStart = now; count = 0; }
    if (++count > 120) return problem(429, "Too Many Requests", { "Retry-After": String(Math.max(1, Math.ceil((60_000 - (now - windowStart)) / 1000))) });
    if (context.req.method !== "GET") return problem(405, "Method Not Allowed", { Allow: "GET" });
    const notFound = async () => {
      const remaining = WAIT_MS - (Date.now() - started);
      if (remaining > 0) await new Promise((resolve) => setTimeout(resolve, remaining));
      return problem(404, "Not Found");
    };
    const url = new URL(context.req.url);
    const match = PATH.exec(url.pathname);
    const authorization = context.req.header("Authorization");
    const credential = authorization === undefined ? null : BEARER.exec(authorization)?.[1];
    const digest = match?.[1] ? canonical32(match[1]) : null;
    const token = credential ? canonical32(credential) : null;
    if (url.search || !digest || !token) return notFound();
    if (!acceptsBody(context.req.header("Accept"))) return problem(406, "Not Acceptable");
    try {
      const tokenHash = createHash("sha256").update(token).digest();
      const body = await store.retrieve(digest, tokenHash, Math.floor(Date.now() / 1000));
      if (body === null) return notFound();
      if (body === "missing-body") return problem(503, "Service Unavailable", { "Retry-After": "30" });
      return new Response(Uint8Array.from(body.bytes), {
        status: 200,
        headers: {
          "Content-Type": BODY_MEDIA_TYPE,
          "Content-Length": String(body.bytes.length),
          "Cache-Control": "private, no-store",
          "Content-Digest": `sha-256=:${Buffer.from(digest).toString("base64")}:`,
        },
      });
    } catch {
      return problem(503, "Service Unavailable", { "Retry-After": "30" });
    }
  });
  app.all("/hail/bodies", () => problem(404, "Not Found"));
}
