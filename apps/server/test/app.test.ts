import { describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import type { AppConfig } from "../src/config.js";
import { ADDRESS_BINDING_REL, COSE_SIGN1_MEDIA_TYPE } from "../src/discovery/routes.js";
import type { DiscoveryStore, PublishedAddressBinding } from "../src/discovery/store.js";

const config: AppConfig = {
  nodeEnv: "test",
  port: 3000,
  providerId: "app",
  publicOrigin: "https://hailproto.app",
  hailServiceBase: "https://hailproto.app/hail",
  plcDirectoryUrl: "http://localhost:2582",
  databaseUrl: "postgresql://hail:secret@localhost:5432/hail_app",
  keyEncryptionKey: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
  pocManagedTransfer: false,
};

const binding: PublishedAddressBinding = {
  id: "11111111-1111-4111-8111-111111111111",
  accountId: "22222222-2222-4222-8222-222222222222",
  canonicalAddress: "alice@hailproto.app",
  did: "did:plc:aaaaaaaaaaaaaaaaaaaaaaaa",
  cose: new Uint8Array([1, 2, 3]),
  digest: new Uint8Array(32).fill(7),
  issuedAt: new Date("2026-09-27T00:00:00Z"),
  expiresAt: new Date("2026-12-26T00:00:00Z"),
  publishedAt: new Date("2026-09-27T00:00:01Z"),
};

const discoveryStore: DiscoveryStore = {
  async findPublishedByAddress(address) {
    return address === binding.canonicalAddress ? binding : null;
  },
  async findPublishedById(id) {
    return id === binding.id ? binding : null;
  },
};

describe("health endpoints", () => {
  it("reports process liveness", async () => {
    const response = await createApp(config).request("/health/live");

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      status: "ok",
      service: "hail-server",
      provider: "app",
    });
  });

  it("reports failed dependency readiness without exposing details", async () => {
    const app = createApp(config, {
      async checkReadiness() {
        throw new Error("postgresql://user:secret@internal/database");
      },
    });

    const response = await app.request("/health/ready");

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      status: "unavailable",
      service: "hail-server",
      provider: "app",
    });
  });

  it("reports successful dependency readiness", async () => {
    const app = createApp(config, {
      async checkReadiness() {
        return { ready: true };
      },
    });

    const response = await app.request("/health/ready");

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      status: "ok",
      service: "hail-server",
      provider: "app",
    });
  });
});

describe("unknown routes", () => {
  it("returns disclosure-safe Problem Details", async () => {
    const response = await createApp(config).request("/missing");

    expect(response.status).toBe(404);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({
      type: "about:blank",
      title: "Not Found",
      status: 404,
    });
  });
});

describe("address discovery", () => {
  const app = createApp(config, {
    discoveryStore,
    async checkReadiness() {
      return { ready: true };
    },
  });

  it("publishes the selected Address Binding through WebFinger", async () => {
    const query = new URLSearchParams({
      resource: "acct:alice@hailproto.app",
      rel: ADDRESS_BINDING_REL,
    });
    const response = await app.request(`/.well-known/webfinger?${query}`);

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/jrd+json");
    expect(await response.json()).toEqual({
      subject: "acct:alice@hailproto.app",
      links: [
        {
          rel: ADDRESS_BINDING_REL,
          type: COSE_SIGN1_MEDIA_TYPE,
          href: `https://hailproto.app/.well-known/hail/addresses/${binding.id}`,
        },
      ],
    });
  });

  it("serves the exact immutable COSE representation", async () => {
    const response = await app.request(`/.well-known/hail/addresses/${binding.id}`);

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe(COSE_SIGN1_MEDIA_TYPE);
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(binding.cose);
  });

  it("does not disclose absent address state", async () => {
    const query = new URLSearchParams({
      resource: "acct:nobody@hailproto.app",
      rel: ADDRESS_BINDING_REL,
    });
    const response = await app.request(`/.well-known/webfinger?${query}`);

    expect(response.status).toBe(404);
    expect(response.headers.get("cache-control")).toBe("no-store");
  });
});
