import type { Hono } from "hono";
import { isCoseSign1MediaType } from "../http/media-type.js";
import type { EnvelopeReceiver } from "./receiver.js";
import { inspectSignedPayload } from "@hailproto/codec";
import { COSE_SIGN1_MEDIA_TYPE } from "../discovery/routes.js";
import type { DeliveryStatusSigner } from "../delivery/status.js";
import { ProtectedResponseSchedule } from "../http/protected-schedule.js";

const MAX_BYTES = 16_384;

function problem(status: number, title: string, extra: Record<string, string> = {}): Response {
  return Response.json({ type: "about:blank", title, status }, {
    status, headers: { "Content-Type": "application/problem+json", "Cache-Control": "no-store", ...extra },
  });
}

async function requestBytes(request: Request): Promise<Uint8Array | null> {
  const length = request.headers.get("content-length");
  if (length !== null && (!/^\d+$/.test(length) || Number(length) > MAX_BYTES)) return null;
  if (!request.body) return new Uint8Array();
  const reader = request.body.getReader();
  const parts: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > MAX_BYTES) { await reader.cancel(); return null; }
    parts.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const part of parts) { bytes.set(part, offset); offset += part.length; }
  return bytes;
}

export function registerEnvelopeRoutes(app: Hono, receiver: Pick<EnvelopeReceiver, "receive">,
  signer?: Pick<DeliveryStatusSigner, "signCurrent">,
  schedule = new ProtectedResponseSchedule()): void {
  let started = Date.now();
  let count = 0;
  app.all("/hail/envelopes", async (context) => {
    const now = Date.now();
    if (now - started >= 60_000) { started = now; count = 0; }
    if (++count > 120) return problem(429, "Too Many Requests", { "Retry-After": String(Math.max(1, Math.ceil((60_000 - (now - started)) / 1000))) });
    if (context.req.method !== "POST") return problem(405, "Method Not Allowed", { Allow: "POST" });
    if (!isCoseSign1MediaType(context.req.header("Content-Type") ?? null) || context.req.header("Content-Encoding") !== undefined) {
      return problem(415, "Unsupported Media Type");
    }
    let bytes: Uint8Array | null;
    try { bytes = await requestBytes(context.req.raw); }
    catch { return problem(400, "Bad Request"); }
    if (!bytes) return problem(413, "Content Too Large");
    const result = await schedule.run(async (signal) => {
      const outcome = await receiver.receive(bytes, signal);
      if (!signer || !["accepted", "duplicate"].includes(outcome)) return null;
      signal.throwIfAborted();
      const envelope = inspectSignedPayload("hail.envelope", bytes).payload;
      const snapshot = await signer.signCurrent(envelope.from, envelope.message_id);
      signal.throwIfAborted();
      return snapshot;
    });
    if (result.kind === "busy") return problem(429, "Too Many Requests", { "Retry-After": "1" });
    if (result.kind === "detailed") return new Response(Uint8Array.from(result.value), { status: 200,
      headers: { "Content-Type": COSE_SIGN1_MEDIA_TYPE, "Cache-Control": "no-store" } });
    return new Response('{"outcome":"received"}', {
      status: 202,
      headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
    });
  });
}
