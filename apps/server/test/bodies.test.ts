import { createHash } from "node:crypto";
import { decodePayload, encodeBase64Url } from "@hailproto/codec";
import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import { registerBodyRoutes } from "../src/bodies/routes.js";
import { bodyDigest, bodyFromText, checkAuthorization, type BodyStore } from "../src/bodies/service.js";

const did = `did:plc:${"a".repeat(24)}`;
const recipient = `did:plc:${"b".repeat(24)}`;
const messageId = "01954144-8097-7a9d-a7a8-ef29a823eaf1";
const bytes = bodyFromText("Hello from Hail.");
const digest = bodyDigest(bytes);
const token = new Uint8Array(32).fill(7);
const path = `/hail/bodies/${encodeBase64Url(digest)}`;
const headers = { Authorization: `Bearer ${encodeBase64Url(token)}`, Accept: "application/hail-body+cbor" };

function setup(result: Awaited<ReturnType<BodyStore["retrieve"]>>) {
  const retrieve = vi.fn<BodyStore["retrieve"]>(async () => result);
  const app = new Hono();
  registerBodyRoutes(app, { retrieve } as unknown as BodyStore);
  return { app, retrieve };
}

describe("detached body", () => {
  it("encodes a validated deterministic spt-1 body and enforces the 256 KiB ceiling", () => {
    expect(decodePayload("hail.body.spt-1", bytes).blocks[0]?.children[0]?.text).toBe("Hello from Hail.");
    expect(() => bodyFromText("a".repeat(262_145))).toThrow();
  });

  it("requires a recipient, UUIDv7, 256-bit token and 30-day availability", () => {
    const input = { senderDid: did, recipientDid: recipient, messageId, digest, token,
      availableUntil: Math.floor(Date.now() / 1000) + 31 * 86400,
      expiresAt: Math.floor(Date.now() / 1000) + 31 * 86400 };
    expect(() => checkAuthorization(input)).not.toThrow();
    expect(() => checkAuthorization({ ...input, token: token.slice(1) })).toThrow();
    expect(() => checkAuthorization({ ...input, availableUntil: 1 })).toThrow();
    expect(() => checkAuthorization({ ...input, recipientDid: did })).toThrow();
  });

  it("serves exact bytes only for matching authorization and advertises the uncompressed digest", async () => {
    const { app, retrieve } = setup({ bytes, digest });
    const response = await app.request(path, { headers });
    expect(response.status).toBe(200);
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(bytes);
    expect(response.headers.get("content-type")).toBe("application/hail-body+cbor");
    expect(response.headers.get("content-digest")).toBe(`sha-256=:${Buffer.from(digest).toString("base64")}:`);
    expect(retrieve.mock.calls[0]?.[0]).toEqual(new Uint8Array(digest));
    expect(Buffer.from(retrieve.mock.calls[0]![1])).toEqual(createHash("sha256").update(token).digest());
  });

  it("uses identical 404 responses for missing, malformed, expired and mismatched credentials", async () => {
    const { app, retrieve } = setup(null);
    for (const [url, auth] of [
      [path, undefined], [path, "Bearer invalid"], [path, headers.Authorization],
      [`${path}=`, headers.Authorization], [`${path}?token=secret`, headers.Authorization],
    ] as const) {
      const response = await app.request(url, { headers: auth ? { Authorization: auth } : {} });
      expect(response.status).toBe(404);
      expect(await response.json()).toEqual({ type: "about:blank", title: "Not Found", status: 404 });
      expect(response.headers.get("www-authenticate")).toBeNull();
    }
    expect(retrieve).toHaveBeenCalledTimes(1);
  });

  it("reports valid-token missing bodies as retryable and rejects unsupported requests", async () => {
    const { app } = setup("missing-body");
    expect((await app.request(path, { headers })).status).toBe(503);
    expect((await app.request(path, { method: "POST" })).headers.get("allow")).toBe("GET");
    expect((await app.request(path, { headers: { ...headers, Accept: "application/json" } })).status).toBe(406);
  });
});
