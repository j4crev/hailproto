import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import { describe, expect, it, vi } from "vitest";

const { httpsRequest } = vi.hoisted(() => ({ httpsRequest: vi.fn() }));

vi.mock("node:https", () => ({ request: httpsRequest }));

import { isPublicAddress, SafeHttpsTransport } from "../src/discovery/safe-fetch.js";

describe("isPublicAddress", () => {
  it("accepts globally routable IPv4 and IPv6 addresses", () => {
    expect(isPublicAddress("1.1.1.1")).toBe(true);
    expect(isPublicAddress("2606:4700:4700::1111")).toBe(true);
  });

  it("rejects private, loopback, link-local, documentation, and mapped addresses", () => {
    for (const address of [
      "127.0.0.1",
      "10.0.0.1",
      "169.254.1.1",
      "192.0.2.1",
      "::1",
      "fc00::1",
      "fe80::1",
      "fec0::1",
      "64:ff9b:1::7f00:1",
      "::ffff:127.0.0.1",
    ]) {
      expect(isPublicAddress(address), address).toBe(false);
    }
  });
});

describe("SafeHttpsTransport", () => {
  it("forwards an allowed PUT and its body to the pinned HTTPS connection", async () => {
    let options: Record<string, unknown> | undefined;
    let sentBody: Uint8Array | undefined;
    httpsRequest.mockImplementationOnce((requestOptions, callback) => {
      options = requestOptions as Record<string, unknown>;
      const outgoing = new EventEmitter() as EventEmitter & {
        end(body?: Uint8Array): void;
        destroy(error?: Error): void;
      };
      outgoing.end = (body?: Uint8Array) => {
        sentBody = body;
        outgoing.emit("socket", { once: (_event: string, listener: () => void) => listener() });
        const incoming = Readable.from([]) as Readable & {
          rawHeaders: string[];
          statusCode: number;
          statusMessage: string;
        };
        incoming.rawHeaders = ["ETag", "\"result\""];
        incoming.statusCode = 204;
        incoming.statusMessage = "No Content";
        callback(incoming);
      };
      outgoing.destroy = (error?: Error) => {
        if (error) outgoing.emit("error", error);
      };
      return outgoing;
    });
    const transport = new SafeHttpsTransport({
      async lookup() {
        return [{ address: "1.1.1.1", family: 4 }];
      },
    });
    const body = new Uint8Array([1, 2, 3]);

    const result = await transport.fetch(
      new Request("https://example.com/hail/grants/id", {
        method: "PUT",
        headers: {
          "Content-Type": "application/cose;cose-type=cose-sign1",
          "If-None-Match": "*",
          "Cache-Control": "no-store",
        },
        body,
      }),
    );

    expect(result.status).toBe(204);
    expect(result.headers.get("etag")).toBe('"result"');
    expect(options).toMatchObject({
      hostname: "example.com",
      path: "/hail/grants/id",
      method: "PUT",
      family: 4,
      servername: "example.com",
      headers: expect.objectContaining({
        "Content-Length": "3",
        "content-type": "application/cose;cose-type=cose-sign1",
        "if-none-match": "*",
      }),
    });
    expect(sentBody).toEqual(body);
  });

  it("rejects a hostname if any DNS answer is non-public before connecting", async () => {
    const transport = new SafeHttpsTransport({
      async lookup() {
        return [
          { address: "1.1.1.1", family: 4 },
          { address: "127.0.0.1", family: 4 },
        ];
      },
    });

    await expect(transport.fetch(new Request("https://example.com/test"))).rejects.toThrow(
      "exclusively to public addresses",
    );
  });

  it("rejects IP hostnames and ambient credentials", async () => {
    const transport = new SafeHttpsTransport({
      async lookup() {
        return [{ address: "1.1.1.1", family: 4 }];
      },
    });

    await expect(transport.fetch(new Request("https://127.0.0.1/test"))).rejects.toThrow(
      "canonical HTTPS DNS URL",
    );
    await expect(
      transport.fetch(
        new Request("https://example.com/test", { headers: { Authorization: "secret" } }),
      ),
    ).rejects.toThrow("must not send authorization");
  });

  it("applies the request deadline while DNS is unresolved", async () => {
    const transport = new SafeHttpsTransport({
      lookup() {
        return new Promise(() => undefined);
      },
    });

    await expect(
      transport.fetch(
        new Request("https://example.com/test", { signal: AbortSignal.timeout(10) }),
      ),
    ).rejects.toThrow();
  });

  it("permits bearer credentials only on pinned canonical body GET requests", async () => {
    let options: Record<string, unknown> | undefined;
    httpsRequest.mockImplementationOnce((requestOptions, callback) => {
      options = requestOptions as Record<string, unknown>;
      const outgoing = new EventEmitter() as EventEmitter & { end(): void; destroy(error?: Error): void };
      outgoing.end = () => {
        const incoming = Readable.from([]) as Readable & { rawHeaders: string[]; statusCode: number };
        incoming.rawHeaders = [];
        incoming.statusCode = 404;
        callback(incoming);
      };
      outgoing.destroy = (error?: Error) => { if (error) outgoing.emit("error", error); };
      return outgoing;
    });
    const transport = new SafeHttpsTransport({ async lookup() { return [{ address: "1.1.1.1", family: 4 }]; } });
    const path = `https://example.com/hail/bodies/${"A".repeat(43)}`;
    const headers = { Authorization: `Bearer ${"B".repeat(43)}` };
    expect((await transport.fetchBody(new Request(path, { headers }))).status).toBe(404);
    expect(options).toMatchObject({ hostname: "example.com", path: `/hail/bodies/${"A".repeat(43)}`,
      method: "GET", headers: expect.objectContaining({ authorization: headers.Authorization }) });
    await expect(transport.fetchBody(new Request(`${path}?token=secret`, { headers }))).rejects.toThrow();
    await expect(transport.fetchBody(new Request("https://example.com/other", { headers }))).rejects.toThrow();
    await expect(transport.fetchBody(new Request(path, { headers: { Authorization: "Bearer bad" } }))).rejects.toThrow();
    await expect(transport.fetch(new Request(path, { headers }))).rejects.toThrow("must not send authorization");
  });
});
