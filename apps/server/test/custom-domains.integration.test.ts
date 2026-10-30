import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { ProviderDatabase } from "../src/db/database.js";
import { CustomDomains } from "../src/accounts/custom-domains.js";
import type { AccountApiSession } from "../src/accounts/repository.js";

const integration = process.env.DATABASE_URL ? describe : describe.skip;
integration("custom domain registration", () => {
  let db: ProviderDatabase;
  let domains: CustomDomains;
  let first: AccountApiSession, second: AccountApiSession;
  const txt = vi.fn(async (_name: string, _signal: AbortSignal): Promise<string[][]> => []);
  const discover = vi.fn(async (_domain: string, _signal: AbortSignal): Promise<string | null> => "haili.app");
  async function account(local: string): Promise<AccountApiSession> {
    const id = randomUUID(), did = `did:plc:${Array.from(randomBytes(24), b => "abcdefghijklmnopqrstuvwxyz234567"[b % 32]).join("")}`;
    await db.sql`INSERT INTO provider_accounts(id,tenant_id,canonical_address,did,onboarding_state,activated_at,activation_binding_digest,activation_verification_mode)
      VALUES(${id},${randomUUID()},${`${local}@haili.app`},${did},'active',now(),${randomBytes(32)},'public')`;
    return { account_id: id, canonical_address: `${local}@haili.app`, did, credential_id: randomUUID(),
      credential_expires_at: new Date(Date.now()+86400000), migration_state: null, scopes: ["account:read"],
      passkey_credential_id: randomUUID(), serving_generation: 1 };
  }
  async function retry(id: string) {
    await db.sql`UPDATE account_custom_domains SET next_check_at=clock_timestamp()-interval '1 second' WHERE id=${id}`;
  }
  beforeAll(async () => {
    db = new ProviderDatabase(process.env.DATABASE_URL!);
    await db.migrate(); await db.migrate(); // Retry must preserve schema and records.
    first = await account("first"); second = await account("second");
    domains = new CustomDomains(db.sql, "https://haili.app", txt, discover);
  });
  afterAll(async () => { await db?.close(); });

  it("requires proof and correct routing, stores only the token hash, and consumes the challenge", async () => {
    const registration = await domains.start(first, "J4CREV.COM");
    expect(registration.domain).toBe("j4crev.com");
    expect(registration.verificationValue).toMatch(/^hail-domain-verify=[A-Za-z0-9_-]{43}$/);
    expect(registration.delegationValue).toBe("v=hail1; provider=haili.app");
    const stored = await db.sql`SELECT to_jsonb(d) AS row FROM account_custom_domains d WHERE id=${registration.id}`;
    expect(JSON.stringify(stored)).not.toContain(registration.verificationValue!.split("=")[1]!);
    txt.mockResolvedValue([[registration.verificationValue!]]); discover.mockResolvedValue("other.example.com");
    expect(await domains.verify(first, registration.id)).toMatchObject({ ownership: true, delegation: false, status: "pending" });
    await expect(domains.verify(first, registration.id)).rejects.toMatchObject({ status: 429 });
    await retry(registration.id); discover.mockResolvedValue("haili.app");
    expect(await domains.verify(first, registration.id)).toMatchObject({ ownership: true, delegation: true, status: "verified" });
    txt.mockClear();
    expect((await domains.verify(first, registration.id)).status).toBe("verified");
    expect(txt).not.toHaveBeenCalled();
    expect(await domains.start(first, "j4crev.com")).toMatchObject({ verificationValue: null, status: "verified" });
    await expect(domains.start(second, "j4crev.com")).rejects.toMatchObject({ status: 409 });
    await expect(domains.removePending(first, registration.id)).rejects.toMatchObject({ status: 409 });
  });

  it("does not let pending claims squat domains or cross account boundaries", async () => {
    const a = await domains.start(first, "shared.example.com");
    const b = await domains.start(second, "shared.example.com");
    await expect(domains.verify(second, a.id)).rejects.toMatchObject({ status: 404 });
    await expect(domains.removePending(second, a.id)).rejects.toMatchObject({ status: 409 });
    txt.mockResolvedValue([[a.verificationValue!]]);
    expect(await domains.verify(second, b.id)).toMatchObject({ ownership: false, delegation: true, status: "pending" });
    expect((await domains.verify(first, a.id)).status).toBe("verified");
    await retry(b.id); txt.mockResolvedValue([[b.verificationValue!]]);
    await expect(domains.verify(second, b.id)).rejects.toMatchObject({ status: 409 });
    expect((await domains.list(second)).domains.some(row => row.id === a.id)).toBe(false);
    expect(await domains.removePending(second, b.id)).toEqual({ removed: true });
  });

  it("replaces expired challenges and rejects replay of their DNS values", async () => {
    const old = await domains.start(first, "expired.example.com");
    await db.sql`UPDATE account_custom_domains SET challenge_expires_at=clock_timestamp()-interval '1 second',
      challenge_created_at=clock_timestamp()-interval '2 minutes' WHERE id=${old.id}`;
    await expect(domains.verify(first, old.id)).rejects.toMatchObject({ status: 409 });
    expect((await domains.list(first)).domains.find(row => row.id === old.id)?.status).toBe("expired");
    const fresh = await domains.start(first, "expired.example.com");
    expect(fresh.id).toBe(old.id); expect(fresh.verificationValue).not.toBe(old.verificationValue);
    txt.mockResolvedValue([[old.verificationValue!]]);
    expect(await domains.verify(first, fresh.id)).toMatchObject({ ownership: false, status: "pending" });
    await expect(domains.start(first, "expired.example.com")).rejects.toMatchObject({ status: 429 });
  });

  it("keeps DNS failures pending and throttles their retries", async () => {
    const pending = await domains.start(first, "failure.example.com");
    txt.mockRejectedValueOnce(new Error("SERVFAIL"));
    await expect(domains.verify(first, pending.id)).rejects.toMatchObject({ status: 503 });
    await expect(domains.verify(first, pending.id)).rejects.toMatchObject({ status: 429 });
    expect((await domains.list(first)).domains.find(row => row.id === pending.id)?.lastVerifiedAt).toBeNull();
  });

  it("rejects challenge replacement while DNS is in flight", async () => {
    const pending = await domains.start(first, "race.example.com");
    await db.sql`UPDATE account_custom_domains SET challenge_created_at=clock_timestamp()-interval '2 minutes' WHERE id=${pending.id}`;
    txt.mockImplementationOnce(async () => {
      await domains.start(first, "race.example.com");
      return [[pending.verificationValue!]];
    });
    await expect(domains.verify(first, pending.id)).rejects.toMatchObject({ status: 409 });
  });

  it("requires a native public account and refuses fenced writers", async () => {
    await expect(domains.start({ ...first, passkey_credential_id: null }, "denied.example.com")).rejects.toMatchObject({ status: 403 });
    await expect(domains.start({ ...first, canonical_address: "first@other.example.com" }, "denied.example.com")).rejects.toMatchObject({ status: 403 });
    await expect(domains.start(first, "haili.app")).rejects.toMatchObject({ status: 400 });
    const fenced = await account("fenced");
    await db.sql`INSERT INTO provider_migration_fences(did,account_id,transfer_id,destination_service_base,state)
      VALUES(${fenced.did},${fenced.account_id},${randomUUID()},'https://other.example.com/hail','fenced')`;
    await expect(domains.start(fenced, "denied.example.com")).rejects.toThrow();
  });

  it("caps registrations per account and permits removing pending attempts", async () => {
    const owner = await account("quota");
    for (let i=0; i<10; i++) await domains.start(owner, `quota${i}.example.com`);
    await expect(domains.start(owner, "quota10.example.com")).rejects.toMatchObject({ status: 429 });
    await domains.removePending(owner, (await domains.list(owner)).domains[0]!.id);
    expect((await domains.start(owner, "quota10.example.com")).status).toBe("pending");
  });

  it("refuses destructive schema rollback with saved registrations", async () => {
    const rollback = await Bun.file(new URL("../migrations/rollback/0087_custom_domains.sql", import.meta.url)).text();
    await expect(db.sql.begin(tx => tx.unsafe(rollback))).rejects.toThrow("Export and explicitly remove");
    expect((await domains.list(first)).domains.length).toBeGreaterThan(0);
  });

  it("allows only one completed owner when valid claims race", async () => {
    const a = await domains.start(first, "competing.example.com"), b = await domains.start(second, "competing.example.com");
    txt.mockResolvedValue([[a.verificationValue!], [b.verificationValue!]]);
    const results = await Promise.allSettled([domains.verify(first, a.id), domains.verify(second, b.id)]);
    expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
    expect(results.find(result => result.status === "rejected")).toMatchObject({ reason: { status: 409 } });
  });

  it("can roll back and reapply the empty-table migration", async () => {
    const isolated = new ProviderDatabase(process.env.TRANSFER_TARGET_DATABASE_URL!);
    try {
      await isolated.migrate();
      const rollback = await Bun.file(new URL("../migrations/rollback/0087_custom_domains.sql", import.meta.url)).text();
      await isolated.sql.begin(async tx => {
        await tx.unsafe(await Bun.file(new URL("../migrations/rollback/0088_custom_address_authorizations.sql", import.meta.url)).text());
        await tx.unsafe(rollback);
        await tx`DELETE FROM schema_migrations WHERE version IN (87,88)`;
      });
      await isolated.migrate();
      expect(await isolated.sql`SELECT * FROM account_custom_domains`).toHaveLength(0);
    } finally { await isolated.close(); }
  });
});
