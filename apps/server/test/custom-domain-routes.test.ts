import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import { registerCustomDomainRoutes } from "../src/accounts/custom-domain-routes.js";
import { canonicalDomain, type CustomDomains } from "../src/accounts/custom-domains.js";
import type { AccountApiRepository, AccountApiSession } from "../src/accounts/repository.js";

const origin = "https://haili.app";
const session = { account_id: "a", passkey_credential_id: "passkey", serving_generation: 1, migration_state: null } as AccountApiSession;
function fixture(authenticated: AccountApiSession | null = session) {
  const domains = { closeAccount:vi.fn(async()=>({closed:true})),withdraw:vi.fn(async()=>({withdrawn:true})), start: vi.fn(async () => ({ status: "pending" })), list: vi.fn(async () => ({ domains: [] })),
    verify: vi.fn(async () => ({ status: "verified" })), removePending: vi.fn(async () => ({ removed: true })),
    authorizeAddress: vi.fn(async () => ({ token: "test-only", address: "j4@j4crev.com" })) };
  const accounts = { authenticate: vi.fn(async () => authenticated) };
  const app = new Hono();
  registerCustomDomainRoutes(app, domains as unknown as CustomDomains, accounts as unknown as AccountApiRepository, origin);
  return { app, domains, accounts };
}
const headers = { Origin: origin, "Content-Type": "application/json", Cookie: "hail_session=session" };

describe("custom domain HTTP boundaries", () => {
  it("requires exact deletion intent and dispatches withdrawal separately from pending removal",async()=>{
    const {app,domains}=fixture(),id="11111111-1111-4111-8111-111111111111";
    const url=origin+"/api/v1/account/delete";
    expect((await app.request(url,{method:"POST",headers,body:JSON.stringify({address:"a@example.com",eraseInbox:true})})).status).toBe(200);
    expect(domains.closeAccount).toHaveBeenCalledWith(session,"a@example.com");
    for(const body of [{address:"a@example.com"},{address:"a@example.com",eraseInbox:false},{address:"a@example.com",eraseInbox:true,extra:true}])
      expect((await app.request(url,{method:"POST",headers,body:JSON.stringify(body)})).status).toBe(400);
    expect((await app.request(url,{headers})).status).toBe(405);
    expect((await app.request(url,{method:"POST",headers:{...headers,Authorization:"Bearer hailp_fake"},body:'{}'})).status).toBe(403);
    expect((await app.request(origin+`/api/v1/account/custom-domains/${id}/withdraw`,{method:"POST",headers,body:JSON.stringify({domain:"example.com"})})).status).toBe(200);
    expect(domains.withdraw).toHaveBeenCalledWith(session,id,"example.com");expect(domains.removePending).not.toHaveBeenCalled();
  });
  it("issues exact-address authorization only through the authenticated mutation surface", async () => {
    const { app, domains } = fixture(), id = "11111111-1111-4111-8111-111111111111";
    const url = `${origin}/api/v1/account/custom-domains/${id}/authorize-address`;
    const response = await app.request(url, { method: "POST", headers, body: '{"address":"j4@j4crev.com"}' });
    expect(response.status).toBe(200); expect(response.headers.get("cache-control")).toBe("no-store");
    expect(domains.authorizeAddress).toHaveBeenCalledWith(session, id, "j4@j4crev.com");
    for (const body of ['{}', '{"address":"a@example.com","domain":"example.com"}', '{"address":42}']) {
      expect((await app.request(url, { method: "POST", headers, body })).status).toBe(400);
    }
    expect((await app.request(url, { method: "POST", headers: { ...headers, Origin: "https://other.example.com" }, body: '{"address":"j4@j4crev.com"}' })).status).toBe(403);
    expect((await app.request(url, { headers })).status).toBe(405);
    expect(domains.authorizeAddress).toHaveBeenCalledOnce();
  });
  it("accepts same-origin passkey sessions and returns private responses", async () => {
    const { app, domains, accounts } = fixture();
    const response = await app.request(`${origin}/api/v1/account/custom-domains`, { method: "POST", headers, body: '{"domain":"j4crev.com"}' });
    expect(response.status).toBe(200); expect(response.headers.get("cache-control")).toBe("no-store");
    expect(accounts.authenticate).toHaveBeenCalledWith(undefined, "session");
    expect(domains.start).toHaveBeenCalledWith(session, "j4crev.com");
    expect((await app.request(`${origin}/api/v1/account/custom-domains`, { headers: { Cookie: "hail_session=session" } })).status).toBe(200);
  });
  it("rejects cross-origin, bearer, unauthenticated, and non-passkey calls", async () => {
    for (const bad of [{ ...headers, Origin: "https://evil.example.com" }, { ...headers, Authorization: "Bearer token" }, { "Content-Type": "application/json" }]) {
      const { app, domains } = fixture();
      expect((await app.request(`${origin}/api/v1/account/custom-domains`, { method: "POST", headers: bad, body: '{"domain":"j4crev.com"}' })).status).toBe(403);
      expect(domains.start).not.toHaveBeenCalled();
    }
    for (const auth of [null, { ...session, passkey_credential_id: null }]) {
      expect((await fixture(auth).app.request(`${origin}/api/v1/account/custom-domains`, { headers })).status).toBe(401);
    }
  });
  it("rejects duplicate keys, extra fields, oversized input, and unexpected queries", async () => {
    for (const body of ['{"domain":"a.com","domain":"b.com"}', '{"domain":"a.com","owner":"other"}', '[]', 'null']) {
      expect((await fixture().app.request(`${origin}/api/v1/account/custom-domains`, { method: "POST", headers, body })).status).toBe(400);
    }
    expect((await fixture().app.request(`${origin}/api/v1/account/custom-domains`, { method: "POST", headers, body: " ".repeat(2049) })).status).toBe(413);
    expect((await fixture().app.request(`${origin}/api/v1/account/custom-domains?owner=other`, { headers })).status).toBe(400);
  });
  it("requires an exact UUID, POST, and empty verification body", async () => {
    const id = "11111111-1111-4111-8111-111111111111", { app, domains } = fixture();
    expect((await app.request(`${origin}/api/v1/account/custom-domains/${id}/verify`, { method: "POST", headers, body: "{}" })).status).toBe(200);
    expect(domains.verify).toHaveBeenCalledWith(session, id);
    expect((await app.request(`${origin}/api/v1/account/custom-domains/${id}/verify`, { headers })).status).toBe(405);
    expect((await app.request(`${origin}/api/v1/account/custom-domains/not-an-id/verify`, { method: "POST", headers, body: "{}" })).status).toBe(404);
  });
});

describe("custom domain canonicalization", () => {
  it("normalizes case and Unicode domains", () => {
    expect(canonicalDomain("J4CREV.COM")).toBe("j4crev.com");
    expect(canonicalDomain("bücher.de")).toBe("xn--bcher-kva.de");
  });
  it.each(["", "https://example.com", "example.com/path", "example.com?x", "example.com#x", "example.com:443", "example.com\\path",
    "example.com.", "%65xample.com", "user@example.com", "localhost", "127.0.0.1", "com", " example.com", "example.com\n"])("rejects %j", input => {
    expect(() => canonicalDomain(input)).toThrow();
  });
});
