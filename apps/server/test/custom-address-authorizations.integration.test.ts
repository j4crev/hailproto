import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ProviderDatabase } from "../src/db/database.js";
import { CustomDomains } from "../src/accounts/custom-domains.js";
import { tokenHash, type AccountApiSession } from "../src/accounts/repository.js";
import { withServingGeneration } from "../src/db/serving.js";

const integration = process.env.DATABASE_URL ? describe : describe.skip;
integration("exact custom-address signup authorization", () => {
  let db: ProviderDatabase, domains: CustomDomains;
  const txt = vi.fn(async (): Promise<string[][]> => []);
  const discover = vi.fn(async (): Promise<string | null> => "haili.app");
  const intent = () => ({ id: randomUUID(), setup: randomBytes(32), digest: randomBytes(32) });
  async function owner(): Promise<AccountApiSession> {
    const id = randomUUID(), address = `owner-${id}@haili.app`;
    const did = `did:plc:${Array.from(randomBytes(24), b => "abcdefghijklmnopqrstuvwxyz234567"[b % 32]).join("")}`;
    await db.sql`INSERT INTO provider_accounts(id,tenant_id,canonical_address,did,onboarding_state,activated_at,activation_binding_digest,activation_verification_mode)
      VALUES(${id},${randomUUID()},${address},${did},'active',now(),${randomBytes(32)},'public')`;
    return { account_id: id, canonical_address: address, did, credential_id: randomUUID(),
      credential_expires_at: new Date(Date.now()+86400000), migration_state: null, scopes: ["account:read"],
      passkey_credential_id: randomUUID(), serving_generation: 1 };
  }
  async function ready() {
    const session = await owner(), domain = `domain-${randomUUID()}.com`;
    const registration = await domains.start(session, domain);
    txt.mockResolvedValue([[registration.verificationValue!]]);
    await domains.verify(session, registration.id);
    discover.mockClear();
    return { session, domain, domainId: registration.id, address: `alice@${domain}` };
  }
  const consume = (token: string, address: string, request = intent()) => db.sql.begin(tx =>
    domains.consumeAddressAuthorization(tx, token, address, request.id, request.setup, request.digest));
  beforeAll(async () => {
    db = new ProviderDatabase(process.env.DATABASE_URL!); await db.migrate(); await db.migrate();
    domains = new CustomDomains(db.sql, "https://haili.app", txt, discover);
  });
  beforeEach(() => { discover.mockReset().mockResolvedValue("haili.app"); });
  afterAll(async () => { await db?.close(); });

  it("issues a hashed, expiring exact-address token after fresh DNS verification", async () => {
    const f = await ready();
    const issued = await domains.authorizeAddress(f.session, f.domainId, f.address.toUpperCase());
    expect(issued.address).toBe(f.address); expect(issued.token).toMatch(/^haild_[A-Za-z0-9_-]{43}$/);
    expect(Date.parse(issued.expiresAt)-Date.now()).toBeGreaterThan(14*60_000);
    expect(Date.parse(issued.expiresAt)-Date.now()).toBeLessThanOrEqual(15*60_000);
    expect(discover).toHaveBeenCalledOnce();
    const saved = (await db.sql`SELECT * FROM custom_address_authorizations WHERE id=${issued.authorizationId}`)[0]!;
    expect(new Uint8Array(saved.token_hash)).toEqual(tokenHash(issued.token));
    expect(JSON.stringify(saved)).not.toContain(issued.token);
    expect(saved.consumed_at).toBeNull();
    // Issuance does not itself create an account or reserve the address.
    expect(await db.sql`SELECT id FROM provider_accounts WHERE canonical_address=${f.address}`).toHaveLength(0);
  });

  it("requires the owning passkey account and exact verified domain", async () => {
    const f = await ready(), other = await owner();
    await expect(domains.authorizeAddress(f.session, f.domainId, `admin@${f.domain}`)).rejects.toMatchObject({status:409});
    await expect(domains.authorizeAddress(other, f.domainId, f.address)).rejects.toMatchObject({ status: 403 });
    await expect(domains.authorizeAddress(f.session, f.domainId, "alice@haili.app")).rejects.toMatchObject({ status: 403 });
    await expect(domains.authorizeAddress(f.session, f.domainId, `alice@sub.${f.domain}`)).rejects.toMatchObject({ status: 403 });
    await expect(domains.authorizeAddress({ ...f.session, passkey_credential_id: null }, f.domainId, f.address)).rejects.toMatchObject({ status: 403 });
    const pending = await domains.start(f.session, `pending-${randomUUID()}.com`);
    await expect(domains.authorizeAddress(f.session, pending.id, `alice@${pending.domain}`)).rejects.toMatchObject({ status: 403 });
    expect(discover).not.toHaveBeenCalled();
  });

  it("rejects changed/missing delegation and DNS errors without issuing authority", async () => {
    const f = await ready();
    discover.mockResolvedValueOnce(null).mockResolvedValueOnce("other.example.com").mockRejectedValueOnce(new Error("SERVFAIL"));
    await expect(domains.authorizeAddress(f.session, f.domainId, f.address)).rejects.toMatchObject({ status: 409 });
    await expect(domains.authorizeAddress(f.session, f.domainId, f.address)).rejects.toMatchObject({ status: 409 });
    await expect(domains.authorizeAddress(f.session, f.domainId, f.address)).rejects.toMatchObject({ status: 503 });
    expect(await db.sql`SELECT id FROM custom_address_authorizations WHERE canonical_address=${f.address}`).toHaveLength(0);
  });

  it("rechecks domain authorization after issuance DNS", async () => {
    const f = await ready();
    discover.mockImplementationOnce(async () => {
      await db.sql`UPDATE account_custom_domains SET verified_at=NULL WHERE id=${f.domainId}`;
      return "haili.app";
    });
    await expect(domains.authorizeAddress(f.session, f.domainId, f.address)).rejects.toMatchObject({ status: 403 });
  });

  it("consumes once, retaining exact retries and rejecting changed signup intent", async () => {
    const f = await ready(), issued = await domains.authorizeAddress(f.session, f.domainId, f.address), request = intent();
    const result = await consume(issued.token, f.address, request);
    expect(result.address).toBe(f.address);
    expect(await consume(issued.token, f.address.toUpperCase(), request)).toEqual(result);
    await expect(consume(issued.token, f.address)).rejects.toMatchObject({ status: 409 });
    await expect(consume(issued.token, f.address, { ...request, setup: randomBytes(32) })).rejects.toMatchObject({ status: 409 });
    await expect(consume(issued.token, f.address, { ...request, digest: randomBytes(32) })).rejects.toMatchObject({ status: 409 });
    await expect(domains.authorizeAddress(f.session, f.domainId, f.address)).rejects.toMatchObject({ status: 409 });
  });

  it("cannot be used at another provider, for another address, or with a forged token", async () => {
    const f = await ready(), issued = await domains.authorizeAddress(f.session, f.domainId, f.address), request = intent();
    const other = new CustomDomains(db.sql, "https://other.example.com", txt, discover);
    await expect(db.sql.begin(tx => other.consumeAddressAuthorization(tx, issued.token, f.address, request.id, request.setup, request.digest)))
      .rejects.toMatchObject({ status: 403 });
    await expect(consume(issued.token, `bob@${f.domain}`)).rejects.toMatchObject({ status: 403 });
    await expect(consume(`haild_${randomBytes(32).toString("base64url")}`, f.address)).rejects.toMatchObject({ status: 403 });
  });

  it("expires new consumption and invalidates replaced tokens", async () => {
    const f = await ready(), old = await domains.authorizeAddress(f.session, f.domainId, f.address);
    await expect(domains.authorizeAddress(f.session, f.domainId, f.address)).rejects.toMatchObject({ status: 429 });
    await db.sql`UPDATE custom_address_authorizations SET issued_at=statement_timestamp()-interval '16 minutes',
      expires_at=statement_timestamp()-interval '1 minute' WHERE id=${old.authorizationId}`;
    await expect(consume(old.token, f.address)).rejects.toMatchObject({ status: 409 });
    const fresh = await domains.authorizeAddress(f.session, f.domainId, f.address);
    expect(fresh.token).not.toBe(old.token);
    await expect(consume(old.token, f.address)).rejects.toMatchObject({ status: 403 });
    expect((await consume(fresh.token, f.address)).address).toBe(f.address);
  });

  it("rolls consumption back with failed account reservation and supports persisted retries", async () => {
    const f = await ready(), issued = await domains.authorizeAddress(f.session, f.domainId, f.address), request = intent();
    await expect(db.sql.begin(async tx => {
      await domains.consumeAddressAuthorization(tx, issued.token, f.address, request.id, request.setup, request.digest);
      throw new Error("reservation failed");
    })).rejects.toThrow("reservation failed");
    expect((await db.sql`SELECT consumed_at FROM custom_address_authorizations WHERE id=${issued.authorizationId}`)[0]!.consumed_at).toBeNull();
    await db.sql.begin(async tx => {
      await domains.consumeAddressAuthorization(tx, issued.token, f.address, request.id, request.setup, request.digest);
      await tx`INSERT INTO provider_accounts(id,tenant_id,canonical_address,onboarding_state)
        VALUES(${randomUUID()},${randomUUID()},${f.address},'reserved')`;
    });
    await db.sql`UPDATE custom_address_authorizations SET issued_at=statement_timestamp()-interval '16 minutes',
      expires_at=statement_timestamp()-interval '1 minute' WHERE id=${issued.authorizationId}`;
    expect((await consume(issued.token, f.address, request)).address).toBe(f.address);
  });

  it("permits only one distinct signup when token consumption races", async () => {
    const f = await ready(), issued = await domains.authorizeAddress(f.session, f.domainId, f.address);
    const results = await Promise.allSettled([consume(issued.token, f.address), consume(issued.token, f.address)]);
    expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
    expect(results.find(result => result.status === "rejected")).toMatchObject({ reason: { status: 409 } });
  });

  it("rechecks delegation during first consumption and rejects stale owner authority", async () => {
    const f = await ready(), issued = await domains.authorizeAddress(f.session, f.domainId, f.address);
    discover.mockResolvedValueOnce(null);
    await expect(consume(issued.token, f.address)).rejects.toMatchObject({ status: 409 });
    await db.sql`UPDATE account_custom_domains SET verified_at=NULL WHERE id=${f.domainId}`;
    await expect(consume(issued.token, f.address)).rejects.toMatchObject({ status: 403 });
    await db.sql`UPDATE account_custom_domains SET verified_at=clock_timestamp() WHERE id=${f.domainId}`;
    await db.sql`INSERT INTO provider_migration_fences(did,account_id,transfer_id,destination_service_base,state)
      VALUES(${f.session.did},${f.session.account_id},${randomUUID()},'https://other.example.com/hail','fenced')`;
    await expect(consume(issued.token, f.address)).rejects.toThrow();
  });

  it("rejects an address reserved between issuance and consumption", async () => {
    const f = await ready(), issued = await domains.authorizeAddress(f.session, f.domainId, f.address);
    await db.sql`INSERT INTO provider_accounts(id,tenant_id,canonical_address,onboarding_state)
      VALUES(${randomUUID()},${randomUUID()},${f.address},'reserved')`;
    await expect(consume(issued.token, f.address)).rejects.toMatchObject({ status: 409 });
    await expect(domains.authorizeAddress(f.session, f.domainId, f.address)).rejects.toMatchObject({ status: 409 });
  });

  it("binds authorization to the administrator generation without overriding stale admission", async () => {
    const f = await ready(), old = await domains.authorizeAddress(f.session, f.domainId, f.address);
    await db.sql.begin(async tx => {
      await tx`SELECT set_config('hail.custody_transition',${f.session.account_id},true)`;
      await tx`UPDATE account_serving_generations SET generation=2 WHERE account_id=${f.session.account_id}`;
    });
    await expect(consume(old.token, f.address)).rejects.toThrow();
    const address = `new@${f.domain}`;
    const fresh = await withServingGeneration(f.session.account_id, 2, () =>
      domains.authorizeAddress({ ...f.session, serving_generation: 2 }, f.domainId, address));
    await expect(withServingGeneration(f.session.account_id, 1, () => consume(fresh.token, address))).rejects.toThrow();
    expect((await consume(fresh.token, address)).address).toBe(address);
  });

  it("limits outstanding authorizations, including reissuing expired entries", async () => {
    const f = await ready(), old = await domains.authorizeAddress(f.session, f.domainId, f.address);
    await db.sql`UPDATE custom_address_authorizations SET issued_at=statement_timestamp()-interval '16 minutes',
      expires_at=statement_timestamp()-interval '1 minute' WHERE id=${old.authorizationId}`;
    for (let i=0; i<20; i++) await domains.authorizeAddress(f.session, f.domainId, `person${i}@${f.domain}`);
    await expect(domains.authorizeAddress(f.session, f.domainId, `extra@${f.domain}`)).rejects.toMatchObject({ status: 429 });
    await expect(domains.authorizeAddress(f.session, f.domainId, f.address)).rejects.toMatchObject({ status: 429 });
  });

  it("refuses destructive rollback while issued authorizations exist", async () => {
    const source = await Bun.file(new URL("../migrations/rollback/0088_custom_address_authorizations.sql", import.meta.url)).text();
    await expect(db.sql.begin(tx => tx.unsafe(source))).rejects.toThrow("Export and explicitly remove");
  });
});
