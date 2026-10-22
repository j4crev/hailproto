import { generateKeyPairSync, randomBytes, randomUUID } from "node:crypto";
import { P256Keypair } from "@atproto/crypto";
import { signOperation } from "@did-plc/lib";
import { encodeBase64Url } from "@hailproto/codec/base64url";
import { base58btc } from "multiformats/bases/base58";
import { expect, it, vi } from "vitest";
import { createMonitorEnrollmentApi, monitorEnrollmentConfig } from "../src/enrollment.js";
import { MonitorSigner } from "../src/signing.js";

it("keeps the listener off by default and validates every enrollment declaration before startup", () => {
  expect(monitorEnrollmentConfig({ MONITOR_ORIGIN: "https://monitor.example.com" })).toBeUndefined();
  const env = { MONITOR_ENROLLMENT_TOKEN: encodeBase64Url(randomBytes(32)), MONITOR_ENROLLMENT_PROVIDER: "https://provider.example.com",
    MONITOR_ENROLLMENT_ALERT_ORIGIN: "https://alerts.example.com", MONITOR_ORIGIN: "https://monitor.example.com", PLC_DIRECTORY_URL: "https://plc.directory" };
  expect(monitorEnrollmentConfig(env)).toMatchObject({ hostname: "127.0.0.1", port: 3001 });
  for (const change of [{ MONITOR_ENROLLMENT_TOKEN: undefined }, { MONITOR_ENROLLMENT_TOKEN: "bad" },
    { MONITOR_ENROLLMENT_PROVIDER: "http://provider.example.com" }, { MONITOR_ENROLLMENT_ALERT_ORIGIN: "https://alerts.example.com/path" },
    { MONITOR_ORIGIN: undefined }, { MONITOR_API_HOST: "example.com" }, { MONITOR_API_PORT: "03001" }, { MONITOR_API_PORT: "80" },
    { PLC_DIRECTORY_URL: "http://private-plc.example.com" }])
    expect(() => monitorEnrollmentConfig({ ...env, ...change })).toThrow();
});

it("authenticates and bounds requests and refuses a provider-signed genesis without owner authority", async () => {
  const signer = new MonitorSigner(generateKeyPairSync("ed25519").privateKey), enroll = vi.fn(), request = vi.fn();
  const config = { token: encodeBase64Url(randomBytes(32)), providerOrigin: "https://provider.example.com", alertOrigin: "https://alerts.example.com",
    monitorOrigin: "https://monitor.example.com", hostname: "127.0.0.1", port: 3001 };
  const api = createMonitorEnrollmentApi(config, { enroll } as never, signer, request);
  const invoke = (body: string, token = config.token) => api.fetch(new Request("https://monitor.example.com/api/v1/onboarding", {
    method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` }, body,
  }));
  expect((await invoke("{}", "wrong")).status).toBe(401);
  expect((await invoke(" ".repeat(32_769))).status).toBe(413);
  expect((await invoke("null")).status).toBe(400);
  const owner = await P256Keypair.create(), provider = await P256Keypair.create();
  const ed = () => { const raw = new Uint8Array(34); raw.set([0xed, 1]); raw.set(randomBytes(32), 2); return `did:key:${base58btc.encode(raw)}`; };
  const unsigned = { type: "plc_operation" as const, prev: null, rotationKeys: [owner.did(), provider.did()],
    verificationMethods: { "hail-identity": ed(), "hail-messaging": ed() }, alsoKnownAs: [],
    services: { hail: { type: "HailMessaging", endpoint: "https://provider.example.com/hail" } } };
  const input = { signupId: randomUUID(), signupHash: encodeBase64Url(randomBytes(32)), operation: await signOperation(unsigned, provider) };
  expect((await invoke(JSON.stringify(input))).status).toBe(400);
  expect((await invoke(JSON.stringify({ ...input, operation: await signOperation(unsigned, owner), alertUrl: "https://attacker.example.com" }))).status).toBe(400);
  expect(enroll).not.toHaveBeenCalled(); expect(request).not.toHaveBeenCalled();
});
