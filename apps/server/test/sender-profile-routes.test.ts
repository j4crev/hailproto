import { createHash } from "node:crypto";
import { encodeBase64Url, type HailSenderProfile } from "@hailproto/codec";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import type { AppConfig } from "../src/config.js";
import { COSE_SIGN1_MEDIA_TYPE } from "../src/discovery/routes.js";
import type { StoredSenderProfile } from "../src/profiles/store.js";

const did = "did:plc:aaaaaaaaaaaaaaaaaaaaaaaa";
const cose = new Uint8Array([1, 2, 3, 4]);
const digest = new Uint8Array(createHash("sha256").update(cose).digest());
const payload: HailSenderProfile = {
  type: "hail.sender-profile",
  version: 1,
  did,
  revision: 1,
  display_name: "Alice",
  offers_uncategorized: false,
  categories: [],
  updated_at: 1,
  key_id: `${did}#hail-messaging`,
};
const profile: StoredSenderProfile = {
  id: crypto.randomUUID(),
  accountId: crypto.randomUUID(),
  did,
  revision: 1,
  payload,
  cose,
  digest,
  signingPublicKey: "did:key:zMessaging",
  updatedAt: 1,
  createdAt: new Date(1_000),
};
const config: AppConfig = {
  nodeEnv: "test",
  port: 3000,
  providerId: "app",
  publicOrigin: "https://hailproto.app",
  hailServiceBase: "https://hailproto.app/hail",
  plcDirectoryUrl: "http://localhost:2582",
  databaseUrl: "postgresql://hail:secret@localhost/hail",
  keyEncryptionKey: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
  pocManagedTransfer: false,
};
const app = createApp(config, {
  async checkReadiness() {
    return { ready: true };
  },
  senderProfileStore: {
    async findCurrentByDid(requestedDid) {
      return requestedDid === did ? profile : null;
    },
  },
});

describe("Sender Profile route", () => {
  it("serves exact bytes with a strong representation ETag", async () => {
    const response = await app.request(`/hail/profiles/${did}`, {
      headers: { Accept: COSE_SIGN1_MEDIA_TYPE },
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe(COSE_SIGN1_MEDIA_TYPE);
    expect(response.headers.get("content-encoding")).toBeNull();
    expect(response.headers.get("content-length")).toBe(String(cose.length));
    expect(response.headers.get("etag")).toBe(`"${encodeBase64Url(digest)}"`);
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(cose);
  });

  it("returns a bodyless 304 for the current strong ETag", async () => {
    const response = await app.request(`/hail/profiles/${did}`, {
      headers: { "If-None-Match": `"${encodeBase64Url(digest)}"` },
    });

    expect(response.status).toBe(304);
    expect(await response.text()).toBe("");
    expect(response.headers.get("etag")).toBe(`"${encodeBase64Url(digest)}"`);
  });

  it("rejects malformed validators, unacceptable media, and other methods", async () => {
    expect(
      (await app.request(`/hail/profiles/${did}`, { headers: { "If-None-Match": "W/\"x\"" } }))
        .status,
    ).toBe(400);
    expect(
      (await app.request(`/hail/profiles/${did}`, { headers: { Accept: "application/json" } }))
        .status,
    ).toBe(406);
    const posted = await app.request(`/hail/profiles/${did}`, { method: "POST" });
    expect(posted.status).toBe(405);
    expect(posted.headers.get("allow")).toBe("GET");
  });

  it("handles equivalent media ranges and quality exclusions", async () => {
    expect(
      (
        await app.request(`/hail/profiles/${did}`, {
          headers: { Accept: "application/cose;cose-type=cose-sign1" },
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await app.request(`/hail/profiles/${did}`, {
          headers: { Accept: "*/*;q=1, application/cose;q=0" },
        })
      ).status,
    ).toBe(406);
  });

  it("uses 404 for malformed, encoded, query-bearing, and absent paths", async () => {
    for (const path of [
      "/hail/profiles/did%3Aplc%3Aaaaaaaaaaaaaaaaaaaaaaaaa",
      `/hail/profiles/${did}?probe=1`,
      "/hail/profiles/did:plc:short",
      "/hail/profiles/did:plc:bbbbbbbbbbbbbbbbbbbbbbbb",
    ]) {
      expect((await app.request(path)).status, path).toBe(404);
    }
  });
});
