import type { Hono } from "hono";
import { isCoseSign1MediaType } from "../http/media-type.js";
import type { DeliveryStatusReceiver } from "./status-receiver.js";
import { ProtectedResponseSchedule } from "../http/protected-schedule.js";

const DIGEST_PATH = /^\/hail\/deliveries\/([A-Za-z0-9_-]{43})$/;

function problem(status: number, title: string, extra: Record<string, string> = {}): Response {
  return Response.json({ type: "about:blank", title, status }, {
    status, headers: { "Content-Type": "application/problem+json", "Cache-Control": "no-store", ...extra },
  });
}

function generic(): Response {
  return new Response('{"outcome":"received"}', { status: 202,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });
}

export function registerDeliveryStatusRoutes(app: Hono, receiver: Pick<DeliveryStatusReceiver, "receive">,
  schedule = new ProtectedResponseSchedule()): void {
  let windowStart = Date.now();
  let count = 0;
  app.all("/hail/deliveries/*", async (context) => {
    const now = Date.now();
    if (now - windowStart >= 60_000) { windowStart = now; count = 0; }
    if (++count > 120) return problem(429, "Too Many Requests", { "Retry-After": "60" });
    if (context.req.method !== "PUT") return problem(405, "Method Not Allowed", { Allow: "PUT" });
    if (!isCoseSign1MediaType(context.req.header("Content-Type") ?? null) || context.req.header("Content-Encoding") !== undefined) {
      return problem(415, "Unsupported Media Type");
    }
    const match = DIGEST_PATH.exec(new URL(context.req.url).pathname);
    if (!match?.[1] || new URL(context.req.url).search || !/^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/.test(match[1])) {
      return problem(400, "Bad Request");
    }
    const declared = context.req.header("Content-Length");
    if (declared !== undefined && (!/^\d+$/.test(declared) || Number(declared) > 16_384)) {
      return problem(413, "Content Too Large");
    }
    let bytes: Uint8Array;
    try {
      const reader = context.req.raw.body?.getReader();
      const chunks: Uint8Array[] = [];
      let length = 0;
      if (reader) while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        length += value.length;
        if (length > 16_384) { await reader.cancel(); return problem(413, "Content Too Large"); }
        chunks.push(value);
      }
      bytes = new Uint8Array(length);
      let offset = 0;
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
    } catch { return problem(400, "Bad Request"); }
    const result = await schedule.run((signal) => receiver.receive(match[1]!, bytes, signal));
    if (result.kind === "busy") return problem(429, "Too Many Requests", { "Retry-After": "1" });
    if (result.kind === "detailed") {
      if (result.value === "acknowledged") return new Response(null, { status: 204, headers: { "Cache-Control": "no-store" } });
      if (result.value === "conflict") return problem(409, "Conflict");
      if (result.value === "bad-request") return problem(400, "Bad Request");
    }
    return generic();
  });
}
