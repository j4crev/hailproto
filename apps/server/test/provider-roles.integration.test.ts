import { randomBytes, randomUUID } from "node:crypto";
import { SQL } from "bun";
import { P256Keypair } from "@atproto/crypto";
import { encodeBase64Url } from "@hailproto/codec";
import { expect, it } from "vitest";
import { ProviderDatabase } from "../src/db/database.js";
import { authorizeProviderRole, providerRoleAccountId } from "../src/onboarding/provider-roles.js";
import { SignupCoordinator } from "../src/onboarding/signup.js";
import { createSignupInvitation } from "../src/onboarding/invitation.js";
import { PublicOnboarding, type AlphaMonitoringPolicy } from "../src/onboarding/public.js";
import type { SignupMonitorService } from "../src/onboarding/monitor.js";
import type { PlcDirectoryClient } from "../src/plc/client.js";
import type { HailDidResolver } from "../src/plc/resolver.js";
import type { AddressVerificationService } from "../src/onboarding/activation.js";
import { KeyEncryptor } from "../src/identity/key-encryption.js";
import { publicEdKey } from "./public-plc-fixture.js";

it.skipIf(!process.env.DATABASE_URL)("reserves provider roles across account writers without taking over existing accounts", async () => {
  const admin = new SQL(process.env.DATABASE_URL!), schema = `provider_roles_${randomUUID().replaceAll("-", "")}`;
  await admin.unsafe(`CREATE SCHEMA "${schema}"`);
  const url = new URL(process.env.DATABASE_URL!); url.searchParams.set("options", `-csearch_path=${schema}`);
  const db = new ProviderDatabase(url.toString()), origin = "https://local.example.com";
  const insert = (address: string, id: string = randomUUID()) => db.sql`INSERT INTO provider_accounts
    (id, tenant_id, canonical_address, onboarding_state) VALUES (${id}, ${randomUUID()}, ${address}, 'reserved')`;
  try {
    await db.migrate();
    const rollback = await Bun.file(new URL("../migrations/rollback/0060_provider_role_addresses.sql", import.meta.url)).text();
    const connection = await db.sql.reserve();
    try { await connection.unsafe(rollback); }
    finally { connection.release(); }
    const oldId = randomUUID();
    await insert("ops@existing.example.com", oldId);
    await insert("alice@local.example.com");
    await db.migrate();
    await db.migrate(); // Repeat startup is harmless.
    expect((await db.sql`SELECT id FROM provider_accounts WHERE canonical_address='ops@existing.example.com'`)[0].id).toBe(oldId);
    await db.sql`UPDATE provider_accounts SET updated_at=clock_timestamp(), canonical_address=canonical_address WHERE id=${oldId}`;

    const key = (await P256Keypair.create()).did(), otherKey = (await P256Keypair.create()).did();
    await expect(authorizeProviderRole(db.sql, "ops@existing.example.com", key, "https://existing.example.com"))
      .rejects.toThrow("Existing account occupies");
    await expect(authorizeProviderRole(db.sql, "ops@elsewhere.example.com", key, origin)).rejects.toThrow("belong to this provider");
    await expect(authorizeProviderRole(db.sql, "alice@local.example.com", key, origin)).rejects.toThrow("not a reserved");
    await expect(authorizeProviderRole(db.sql, "ops@local.example.com", "not-a-key", origin)).rejects.toThrow();

    const invitationKey = encodeBase64Url(randomBytes(32)), invitation = createSignupInvitation(origin, invitationKey);
    const signup = new SignupCoordinator(db.sql, {} as PublicOnboarding, {} as SignupMonitorService,
      origin, {} as AlphaMonitoringPolicy, invitationKey);
    for (const role of ["ops", "alerts", "abuse", "security", "support", "admin"]) {
      const address = `${role}@local.example.com`;
      await expect(insert(address)).rejects.toThrow("reserved for the provider operator");
      await expect(db.sql`UPDATE provider_accounts SET canonical_address=${address} WHERE canonical_address='alice@local.example.com'`)
        .rejects.toThrow("reserved for the provider operator");
      await expect(providerRoleAccountId(db.sql, address, key)).rejects.toThrow("reserved for the provider operator");
      expect(await signup.checkAddress({ address: `${role.toUpperCase()}@LOCAL.EXAMPLE.COM`, invitation }))
        .toEqual({ address, available: false });
    }
    expect(await signup.checkAddress({ address: "ordinary@local.example.com", invitation }))
      .toEqual({ address: "ordinary@local.example.com", available: true });
    expect(await providerRoleAccountId(db.sql, "ordinary@local.example.com", key)).toBeUndefined();

    const address = "ops@local.example.com", accountId = await authorizeProviderRole(db.sql, "OPS@LOCAL.EXAMPLE.COM", key, origin);
    expect(await authorizeProviderRole(db.sql, address, key, origin)).toBe(accountId);
    expect(await providerRoleAccountId(db.sql, address, key)).toBe(accountId);
    await expect(authorizeProviderRole(db.sql, address, otherKey, origin)).rejects.toThrow("another recovery key");
    await expect(providerRoleAccountId(db.sql, address, otherKey)).rejects.toThrow("reserved for the provider operator");
    expect(await db.sql`SELECT id FROM provider_accounts WHERE id=${accountId}`).toHaveLength(0);
    expect(await db.sql`SELECT account_id FROM account_keys WHERE account_id=${accountId}`).toHaveLength(0);
    await expect(insert(address)).rejects.toThrow("reserved for the provider operator");
    await insert(address, accountId);

    const identity = await publicEdKey(), monitor = await publicEdKey();
    const onboarding = new PublicOnboarding(db.sql, {} as PlcDirectoryClient, {} as HailDidResolver,
      new KeyEncryptor(encodeBase64Url(randomBytes(32))), "https://plc.directory", `${origin}/hail`, {} as AddressVerificationService);
    await authorizeProviderRole(db.sql, "alerts@local.example.com", key, origin);
    const prepare = (recovery: string) => onboarding.prepare("alerts@local.example.com", recovery, identity.didKey,
      true, "owner-controlled", "https://monitor.example.com", monitor.didKey);
    await expect(prepare(otherKey)).rejects.toThrow("reserved for the provider operator");
    const prepared = await prepare(key);
    expect(prepared.accountId).toBe(await providerRoleAccountId(db.sql, prepared.address, key));
    expect((await prepare(key)).accountId).toBe(prepared.accountId);
    expect(await db.sql`SELECT account_id FROM account_keys WHERE account_id=${prepared.accountId}`).toHaveLength(2);
    expect((await db.sql`SELECT onboarding_state FROM provider_accounts WHERE id=${prepared.accountId}`)[0].onboarding_state).toBe("reserved");

    const rollbackConnection = await db.sql.reserve();
    try { await expect(rollbackConnection.unsafe(rollback)).rejects.toThrow("Cannot roll back"); }
    finally { await rollbackConnection.unsafe("ROLLBACK"); rollbackConnection.release(); }
  } finally {
    await db.close();
    await admin.unsafe(`DROP SCHEMA "${schema}" CASCADE`);
    await admin.close();
  }
});
