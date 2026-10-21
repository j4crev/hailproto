import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import { GrantReceiveError, type GrantReceiver } from "../src/grants/receiver.js";
import { registerGrantRoutes } from "../src/grants/routes.js";

const grantId = "01954144-8097-7a9d-a7a8-ef29a823eaf1";
const path = `/hail/grants/${grantId}`;
const mediaType = "application/cose;cose-type=cose-sign1";

function appFor(receive = vi.fn<GrantReceiver["receive"]>()) {
  const app = new Hono();
  registerGrantRoutes(app, "https://hailproto.app/hail", { receive } as unknown as GrantReceiver);
  return { app, receive };
}

describe("Grant routes", () => {
  it("maps successful creation to a bodyless response with ETag and Location", async () => {
    const { app, receive } = appFor(
      vi.fn(async () => ({ status: 201, etag: `"${"A".repeat(43)}"`, created: true })),
    );
    const response = await app.request(path, {
      method: "PUT",
      headers: { "Content-Type": mediaType, "If-None-Match": "*" },
      body: new Uint8Array([1, 2, 3]),
    });

    expect(response.status).toBe(201);
    expect(await response.text()).toBe("");
    expect(response.headers.get("etag")).toBe(`"${"A".repeat(43)}"`);
    expect(response.headers.get("location")).toBe(
      `https://hailproto.app/hail/grants/${grantId}`,
    );
    expect(receive).toHaveBeenCalledWith(
      grantId,
      new Uint8Array([1, 2, 3]),
      { ifMatch: null, ifNoneMatch: "*" },
    );
  });

  it("omits detail for non-disclosing authentication failures", async () => {
    const { app } = appFor(
      vi.fn(async () => {
        throw new GrantReceiveError(400, "Bad Request", false);
      }),
    );
    const response = await app.request(path, {
      method: "PUT",
      headers: { "Content-Type": mediaType },
      body: new Uint8Array([1]),
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      type: "about:blank",
      title: "Bad Request",
      status: 400,
    });
  });

  it("omits detail from 421 Problem Details", async () => {
    const { app } = appFor(
      vi.fn(async () => {
        throw new GrantReceiveError(421, "Misdirected Request", false);
      }),
    );
    const response = await app.request(path, {
      method: "PUT",
      headers: { "Content-Type": mediaType },
      body: new Uint8Array([1]),
    });

    expect(response.status).toBe(421);
    expect(await response.json()).toEqual({
      type: "about:blank",
      title: "Misdirected Request",
      status: 421,
    });
  });

  it("rejects unsupported methods and advertises PUT", async () => {
    const { app, receive } = appFor();
    const response = await app.request(path, { method: "POST" });

    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe("PUT");
    expect(receive).not.toHaveBeenCalled();
  });

  it("rejects missing or invalid media types and content encodings", async () => {
    const { app, receive } = appFor();
    for (const headers of [
      {},
      { "Content-Type": "application/json" },
      { "Content-Type": "application/cose" },
      { "Content-Type": mediaType, "Content-Encoding": "gzip" },
    ]) {
      const response = await app.request(path, {
        method: "PUT",
        headers,
        body: new Uint8Array([1]),
      });
      expect(response.status, JSON.stringify(headers)).toBe(415);
    }
    expect(receive).not.toHaveBeenCalled();
  });

  it("rejects bodies over the transport limit before calling the receiver", async () => {
    const { app, receive } = appFor();
    const response = await app.request(path, {
      method: "PUT",
      headers: { "Content-Type": mediaType },
      body: new Uint8Array(262_145),
    });

    expect(response.status).toBe(413);
    expect(receive).not.toHaveBeenCalled();
  });

  it("applies the early request cap across the provider grant routes", async () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(1_790_467_200_000);
    try {
      const { app, receive } = appFor();
      for (let index = 0; index < 60; index += 1) {
        expect((await app.request(path, { method: "POST" })).status).toBe(405);
        expect((await app.request("/hail/grants", { method: "POST" })).status).toBe(405);
      }

      const response = await app.request(path, { method: "POST" });
      expect(response.status).toBe(429);
      expect(response.headers.get("retry-after")).toBe("60");
      expect(await response.json()).toEqual({
        type: "about:blank",
        title: "Too Many Requests",
        status: 429,
      });
      expect(receive).not.toHaveBeenCalled();
    } finally {
      now.mockRestore();
    }
  });
});
