import { randomBytes } from "node:crypto";
import { Hono } from "hono";
import { encodeBase64Url } from "@hailproto/codec/base64url";
import { expect, it, vi } from "vitest";
import { SignupEmailClient, registerSignupEmailRoutes } from "../src/onboarding/email.js";
import { tokenHash } from "../src/accounts/repository.js";

function fixture() {
  const secret = encodeBase64Url(randomBytes(32)), token = `hailp_${encodeBase64Url(randomBytes(32))}`, signupId = crypto.randomUUID();
  const transport = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => Response.json({ verified: false, expiresAt: Date.now() + 600_000 }));
  const client = new SignupEmailClient({ origin: "https://alerts.plcmonitor.us", token: secret }, transport as unknown as typeof fetch);
  const sql = vi.fn(async (_parts: TemplateStringsArray, ..._values: unknown[]) => [] as { did: string; operation_cid: string; signup_token_hash: Uint8Array }[]);
  const app = new Hono(); registerSignupEmailRoutes(app, sql as never, client, "https://haili.app");
  const post = (step: string, input: unknown, headers: Record<string, string> = {}) => app.request(`https://haili.app/api/v1/signup-email/${step}`, {
    method: "POST", headers: { "Content-Type": "application/json", Origin: "https://haili.app", Authorization: `Bearer ${token}`, ...headers }, body: JSON.stringify(input),
  });
  return { secret, token, signupId, transport, client, sql, app, post };
}

it("proxies same-origin signup emails with a server-only secret and a hashed, scoped signup capability", async () => {
  const f = fixture(), input = { signupId: f.signupId, email: "alice@example.com" };
  expect((await f.post("start", input, { Origin: "https://attacker.example.com" })).status).toBe(403);
  expect((await f.post("start", input, { Authorization: "Bearer wrong" })).status).toBe(401);
  expect((await f.post("start", { ...input, html: "arbitrary relay content" })).status).toBe(400);
  expect(f.transport).not.toHaveBeenCalled();
  const response = await f.post("start", input);
  expect(response.status).toBe(200); expect(response.headers.get("Cache-Control")).toBe("no-store");
  const [url, init] = f.transport.mock.calls[0]!;
  expect(url).toBe("https://alerts.plcmonitor.us/signup-email");
  expect(init).toMatchObject({ redirect: "error", headers: { Authorization: `Bearer ${f.secret}` } });
  expect(JSON.parse(init!.body as string)).toEqual({ ...input, signupHash: encodeBase64Url(tokenHash(f.token)) });
  const text = await response.text(); expect(text).not.toContain(f.secret); expect(text).not.toContain(f.token);
  expect(f.sql).not.toHaveBeenCalled();
});

it("binds only the alpha genesis retained for the same signup capability, never browser-selected identity data", async () => {
  const f = fixture(), accountId = crypto.randomUUID(), input = { signupId: f.signupId, accountId };
  expect((await f.post("bind", { ...input, did: `did:plc:${"a".repeat(24)}` })).status).toBe(400);
  expect((await f.post("bind", input)).status).toBe(403); expect(f.transport).not.toHaveBeenCalled();
  const row = { did: `did:plc:${"a".repeat(24)}`, operation_cid: "bafyreifixture", signup_token_hash: tokenHash(f.token) };
  f.sql.mockResolvedValue([row]);
  expect((await f.post("bind", input, { Authorization: `Bearer hailp_${encodeBase64Url(randomBytes(32))}` })).status).toBe(403);
  f.transport.mockResolvedValue(Response.json({ bound: true, did: row.did, operationCid: row.operation_cid }));
  expect((await f.post("bind", input)).status).toBe(200);
  expect(JSON.parse(f.transport.mock.calls[0]![1]!.body as string)).toEqual({
    signupId: f.signupId, signupHash: encodeBase64Url(tokenHash(f.token)), did: row.did, operationCid: row.operation_cid,
  });
  const query = f.sql.mock.calls[0]![0] as unknown as TemplateStringsArray;
  expect(query.join("?")).toContain("preparation.monitor_assurance='reduced-assurance-alpha-v1'");
});

it("bounds requests, throttles callers and redacts upstream failures or unexpected responses", async () => {
  const f = fixture();
  f.transport.mockResolvedValueOnce(new Response("vendor recipient and secret", { status: 503, headers: { "Retry-After": "60" } }));
  const response = await f.post("verify", { signupId: f.signupId, code: "12345678" });
  expect(response.status).toBe(503); expect(response.headers.get("Retry-After")).toBe("60");
  expect(await response.text()).not.toContain("vendor");
  f.transport.mockResolvedValueOnce(Response.json({ verified: true, expiresAt: Date.now() + 60_000, code: "12345678" }));
  expect((await f.post("verify", { signupId: f.signupId, code: "12345678" })).status).toBe(503);
  expect((await f.post("start", { signupId: f.signupId, email: "a".repeat(5000) })).status).toBe(413);
  for (let index = 0; index < 8; index++) await f.post("verify", { signupId: f.signupId, code: "12345678" });
  expect((await f.post("verify", { signupId: f.signupId, code: "12345678" })).status).toBe(429);
});

it("rejects unsafe Worker configuration before sending anything", () => {
  const token = encodeBase64Url(randomBytes(32));
  for (const origin of ["http://alerts.example.com", "https://alerts.example.com/path", "https://user@alerts.example.com"])
    expect(() => new SignupEmailClient({ origin, token })).toThrow();
  expect(() => new SignupEmailClient({ origin: "https://alerts.example.com", token: "bad" })).toThrow();
});
