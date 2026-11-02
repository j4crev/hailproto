import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import { encodeBase64Url, type HailEnvelope } from "@hailproto/codec";
import { describe, expect, it, vi } from "vitest";
import { bodyFromText, bodyDigest } from "../src/bodies/service.js";
import { BodyRetriever } from "../src/delivery/retriever.js";
import type { HailDidResolver, ResolvedHailDid } from "../src/plc/resolver.js";

const bytes = bodyFromText("Verified delivery");
const sender = `did:plc:${"a".repeat(24)}`;
const destination = (base: string): ResolvedHailDid => ({ did: sender,
  serviceBase: base, messagingDidKey: "", identityDidKey: "", evidence: { document: {}, data: {}, log: [] } });
const envelope: HailEnvelope = {
  type: "hail.envelope", version: 1, message_id: "01954144-8097-7a9d-a7a8-ef29a823eaf1",
  from: sender, to: `did:plc:${"b".repeat(24)}`,
  authorization: { type: "grant", grant_id: "01954144-8097-7a9d-a7a8-ef29a823eaf1" },
  category: "updates", created_at: 1_790_000_000, expires_at: 1_790_086_400,
  body: { digest: { algorithm: "sha-256", value: bodyDigest(bytes) }, size: bytes.length,
    media_type: "application/hail-body+cbor", profile: "spt-1", available_until: 1_793_000_000,
    access: { type: "bearer", token: new Uint8Array(32).fill(4), expires_at: 1_793_000_000 } },
  reply: { allowed: false },
};

function setup(responses: Response[], services = ["https://sender.example/hail"]) {
  const resolve = vi.fn(async () => destination(services[Math.min(resolve.mock.calls.length - 1, services.length - 1)]!));
  const fetch = vi.fn<(request: Request) => Promise<Response>>(async () => responses.shift()!);
  const validate = vi.fn(async () => {});
  const retriever = new BodyRetriever({ resolve } as HailDidResolver, fetch, validate);
  return { retriever, fetch, resolve, validate };
}

describe("authenticated detached body retrieval", () => {
  it("pins the sender endpoint, passes the signed token in a header, and verifies exact bytes", async () => {
    const { retriever, fetch, validate } = setup([new Response(Uint8Array.from(bytes), {
      headers: { "Content-Type": "application/hail-body+cbor",
        "Content-Digest": `sha-256=:${createHash("sha256").update(bytes).digest("base64")}:` },
    })]);
    expect(await retriever.retrieve(envelope)).toEqual({ kind: "success", bytes });
    const request = fetch.mock.calls[0]![0] as Request;
    expect(request.url).toBe(`https://sender.example/hail/bodies/${encodeBase64Url(envelope.body.digest.value)}`);
    expect(request.headers.get("authorization")).toBe(`Bearer ${encodeBase64Url(envelope.body.access.token)}`);
    expect(validate).toHaveBeenCalledOnce();
  });

  it("bounds gzip output and verifies coded Content-Digest against coded bytes", async () => {
    const coded = gzipSync(bytes);
    const response = new Response(coded, { headers: {
      "Content-Type": "application/hail-body+cbor", "Content-Encoding": "gzip",
      "Content-Digest": `sha-256=:${createHash("sha256").update(coded).digest("base64")}:`,
    } });
    expect(await setup([response]).retriever.retrieve(envelope)).toEqual({ kind: "success", bytes });
    const invalid = new Response(gzipSync(bodyFromText("different")), { headers: {
      "Content-Type": "application/hail-body+cbor", "Content-Encoding": "gzip" } });
    expect(await setup([invalid]).retriever.retrieve(envelope)).toEqual({ kind: "fail", reason: "body-integrity-failed" });
  });

  it("refreshes PLC after 404 and retries only if the authenticated endpoint changed", async () => {
    const { retriever, fetch, resolve } = setup([
      new Response(null, { status: 404 }),
      new Response(Uint8Array.from(bytes), { headers: { "Content-Type": "application/hail-body+cbor" } }),
    ], ["https://old.example/hail", "https://new.example/hail"]);
    expect(await retriever.retrieve(envelope)).toEqual({ kind: "success", bytes });
    expect(resolve).toHaveBeenCalledTimes(2);
    expect((fetch.mock.calls[1]![0] as Request).url).toContain("new.example");
    expect(await setup([new Response(null, { status: 404 })]).retriever.retrieve(envelope))
      .toEqual({ kind: "fail", reason: "body-authorization-failed" });
  });

  it("accepts gzip at the body ceiling and rejects output one byte beyond the signed size", async () => {
    // The CBOR framing is constant for text lengths in this range.
    const framing = bodyFromText("x".repeat(260_000)).length - 260_000;
    const maximum = bodyFromText("x".repeat(1_048_576 - framing));
    expect(maximum.length).toBe(1_048_576);
    const descriptor = { ...envelope, body: { ...envelope.body, size: maximum.length,
      digest: { algorithm: "sha-256" as const, value: bodyDigest(maximum) } } };
    const response = (data: Uint8Array) => new Response(gzipSync(data), { headers: {
      "Content-Type": "application/hail-body+cbor", "Content-Encoding": "gzip" } });
    const result = await setup([response(maximum)]).retriever.retrieve(descriptor);
    expect(result.kind).toBe("success");
    if (result.kind !== "success") throw new Error("Expected successful maximum-sized body retrieval");
    // Compare exact bytes natively; deep equality walks a million array properties
    // and can exhaust the test timeout on shared CI runners.
    expect(Buffer.from(result.bytes).equals(Buffer.from(maximum))).toBe(true);
    const oversized = new Uint8Array(maximum.length + 1);
    oversized.set(maximum);
    expect(await setup([response(oversized)]).retriever.retrieve(descriptor)).toEqual({ kind: "fail", reason: "body-integrity-failed" });
  });

  it("rejects concatenated gzip members whose aggregate output exceeds the signed size", async () => {
    const wire = Buffer.concat([gzipSync(bytes), gzipSync(new Uint8Array([0]))]);
    const response = new Response(wire, { headers: { "Content-Type": "application/hail-body+cbor", "Content-Encoding": "gzip" } });
    expect(await setup([response]).retriever.retrieve(envelope)).toEqual({ kind: "fail", reason: "body-integrity-failed" });
  });

  it("bounds compressed input without trusting Content-Length and rejects invalid declared body sizes before fetching", async () => {
    const response = new Response(new Uint8Array(2_097_153), { headers: { "Content-Type": "application/hail-body+cbor", "Content-Encoding": "gzip" } });
    expect(await setup([response]).retriever.retrieve(envelope)).toEqual({ kind: "fail", reason: "body-integrity-failed" });
    for (const size of [0, -1, 1_048_577, NaN, 1.5]) {
      const { retriever, fetch } = setup([]);
      expect(await retriever.retrieve({ ...envelope, body: { ...envelope.body, size } })).toEqual({ kind: "fail", reason: "body-integrity-failed" });
      expect(fetch).not.toHaveBeenCalled();
    }
  });

  it("keeps truncated gzip retryable but rejects corrupt gzip", async () => {
    const coded = gzipSync(bytes);
    const response = (wire: Uint8Array) => new Response(Uint8Array.from(wire), { headers: {
      "Content-Type": "application/hail-body+cbor", "Content-Encoding": "gzip" } });
    expect(await setup([response(coded.subarray(0, coded.length - 4))]).retriever.retrieve(envelope))
      .toEqual({ kind: "retry", reason: "body-transfer-interrupted", retryAfter: null });
    const corrupt = Uint8Array.from(coded); corrupt[corrupt.length - 8]! ^= 1;
    expect(await setup([response(corrupt)]).retriever.retrieve(envelope)).toEqual({ kind: "fail", reason: "body-integrity-failed" });
  });

  it("classifies transient responses separately from integrity and schema failures", async () => {
    expect(await setup([new Response(null, { status: 503 })]).retriever.retrieve(envelope))
      .toEqual({ kind: "retry", reason: "body-temporarily-unavailable", retryAfter: null });
    expect(await setup([new Response(null, { status: 429 })]).retriever.retrieve(envelope))
      .toEqual({ kind: "retry", reason: "sender-rate-limited", retryAfter: null });
    expect(await setup([new Response(new Uint8Array([1, 2]), {
      headers: { "Content-Type": "application/hail-body+cbor" } })]).retriever.retrieve(envelope))
      .toEqual({ kind: "fail", reason: "body-integrity-failed" });
    expect(await setup([new Response(new Uint8Array([1, 2]), {
      headers: { "Content-Type": "application/hail-body+cbor", "Content-Length": "3" } })]).retriever.retrieve(envelope))
      .toEqual({ kind: "retry", reason: "body-transfer-interrupted", retryAfter: null });
  });
});
