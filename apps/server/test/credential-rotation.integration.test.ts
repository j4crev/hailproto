import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, stat, writeFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Hono } from "hono";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ProviderDatabase } from "../src/db/database.js";
import { AccountApiRepository, ALL_ACCOUNT_SCOPES } from "../src/accounts/repository.js";
import { registerAccountApiRoutes } from "../src/accounts/routes.js";
import { GrantRepository } from "../src/grants/repository.js";
import type { GrantService } from "../src/grants/service.js";

const integration = process.env.DATABASE_URL ? describe : describe.skip;
integration("resumable credential rotation over real HTTPS", () => {
  let db: ProviderDatabase, accounts: AccountApiRepository, directory: string, origin: string;
  let server: ReturnType<typeof Bun.serve>;
  let loseIssuance = false, loseRevocation = false, rejectIssuance = false;
  let omitMetadata = false;
  const id = randomUUID(), otherId = randomUUID();
  const address = `rotation-${id}@example.com`, otherAddress = `rotation-${otherId}@example.com`;
  const record = (credential: unknown) => ({ type: "hailp.api-credential", version: 1, provider: origin, ...credential as object });
  const save = (name: string, value: unknown) => writeFile(join(directory, name), JSON.stringify(value), { mode: 0o600 });
  const rotate = async (source: string, output: string) => {
    const child = Bun.spawn(["bun", "src/cli/hailp.ts", "credential", "rotate", "--credentials", join(directory, source), "--output", join(directory, output)], {
      cwd: new URL("../../hail-user-client-ts/", import.meta.url).pathname,
      env: { ...Bun.env, NODE_EXTRA_CA_CERTS: join(directory, "cert.pem") }, stdout: "pipe", stderr: "pipe",
    });
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    for (const name of [source, output, `${output}.rotation.json`]) {
      try { const saved = JSON.parse(await readFile(join(directory, name), "utf8")); expect(stdout + stderr).not.toContain(saved.token); }
      catch (error) { if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error; }
    }
    return { code, stdout, stderr };
  };
  beforeAll(async () => {
    db = new ProviderDatabase(process.env.DATABASE_URL!); await db.migrate(); accounts = new AccountApiRepository(db.sql);
    directory = await mkdtemp(join(tmpdir(), "hail-rotation-"));
    const certificate = Bun.spawn(["openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1",
      "-subj", "/CN=localhost", "-addext", "subjectAltName=DNS:localhost", "-addext", "basicConstraints=critical,CA:TRUE",
      "-keyout", join(directory, "key.pem"), "-out", join(directory, "cert.pem")], { stdout: "pipe", stderr: "pipe" });
    if (await certificate.exited !== 0) throw new Error(await new Response(certificate.stderr).text());
    const app = new Hono();
    server = Bun.serve({ hostname: "localhost", port: 0, tls: { cert: Bun.file(join(directory, "cert.pem")), key: Bun.file(join(directory, "key.pem")) },
      async fetch(request) {
        const posted = request.method === "POST" ? await request.clone().json() : null;
        if (posted && !posted.revoke && rejectIssuance) { rejectIssuance = false; return new Response(null, { status: 503 }); }
        const response = await app.fetch(request);
        if (omitMetadata && request.method === "GET" && new URL(request.url).pathname === "/api/v1/account" && response.ok) {
          const body = await response.json(); delete body.credential;
          return new Response(JSON.stringify(body), { headers: { "Content-Type": "application/json" } });
        }
        if (response.ok && posted && (posted.revoke ? loseRevocation : loseIssuance)) {
          if (posted.revoke) loseRevocation = false; else loseIssuance = false;
          return new Response(null, { status: 503 });
        }
        return response;
      } });
    origin = `https://localhost:${server.port}`;
    registerAccountApiRoutes(app, accounts, new GrantRepository(db.sql), {} as GrantService, origin);
    for (const [accountId, accountAddress, letter] of [[id, address, "a"], [otherId, otherAddress, "b"]]) {
      await db.sql`INSERT INTO provider_accounts (id,tenant_id,canonical_address,did,onboarding_state,activated_at,activation_binding_digest,activation_verification_mode)
        VALUES (${accountId!},${randomUUID()},${accountAddress!},${`did:plc:${letter!.repeat(24)}`},'active',now(),${new Uint8Array(32)},'public')`;
    }
  });
  afterAll(async () => {
    server?.stop(true);
    if (db) {
      await db.sql`DELETE FROM provider_migration_fences WHERE account_id IN (${id},${otherId})`;
      await db.sql`DELETE FROM account_api_credentials WHERE account_id IN (${id},${otherId})`;
      await db.sql`DELETE FROM provider_accounts WHERE id IN (${id},${otherId})`; await db.close();
    }
    if (directory) await rm(directory, { recursive: true, force: true });
  });
  it("recovers issuance and revocation response loss in fresh CLI processes without new tokens or widened scopes", async () => {
    for (const [name, scopes, stage] of [["before-issuance", ["account:read", "credentials:write"], "before-issuance"],
      ["issuance", ["account:read", "credentials:write"], "issuance"],
      ["revocation", [...ALL_ACCOUNT_SCOPES], "revocation"]] as const) {
      const parent = await accounts.issue(address, false, undefined, [...scopes]);
      const source = `${name}.json`, output = `${name}.next.json`;
      await save(source, record(parent));
      const before = await readFile(join(directory, source));
      if (stage === "before-issuance") rejectIssuance = true; else if (stage === "issuance") loseIssuance = true; else loseRevocation = true;
      const failed = await rotate(source, output);
      expect(failed.code).toBe(1); expect(failed.stderr).toContain("HTTP_503");
      const pending = JSON.parse(await readFile(join(directory, output), "utf8"));
      const state = JSON.parse(await readFile(join(directory, `${output}.rotation.json`), "utf8"));
      expect(pending.token).toBe(state.token); expect(pending.scopes).toEqual(scopes);
      if (stage === "issuance") {
        await save(`${output}.rotation.json`, { ...state, scopes: ["account:read"] });
        expect((await rotate(source, output)).stderr).toContain("Rotation state does not match");
        expect(await accounts.authenticate(`Bearer ${parent.token}`)).not.toBeNull();
        await save(`${output}.rotation.json`, state);
      }
      expect(await accounts.authenticate(`Bearer ${parent.token}`) !== null).toBe(stage !== "revocation");
      const replacementSession = await accounts.authenticate(`Bearer ${pending.token}`);
      if (stage === "before-issuance") {
        expect(replacementSession).toBeNull();
        await unlink(join(directory, output)); // Resume even if only the pre-issuance sidecar survived.
      } else expect(replacementSession).not.toBeNull();
      if (stage === "issuance") {
        await db.sql`UPDATE account_api_credentials SET created_at=now()-interval '2 days', expires_at=now()-interval '1 day' WHERE id=${parent.credentialId}`;
        expect(await accounts.authenticate(`Bearer ${parent.token}`)).toBeNull();
      }
      const recovered = await rotate(source, output);
      expect(recovered.code, recovered.stderr).toBe(0);
      const result = JSON.parse(recovered.stdout);
      const session = await accounts.authenticate(`Bearer ${pending.token}`);
      expect(result).toMatchObject({ credentialId: session!.credential_id, rotatedFrom: parent.credentialId, revoked: true, scopes: [...scopes] });
      expect(result.expiresAt).toBe(session!.credential_expires_at.toISOString());
      if (replacementSession) expect(result.credentialId).toBe(replacementSession.credential_id);
      expect(await accounts.authenticate(`Bearer ${parent.token}`)).toBeNull();
      const completed = await readFile(join(directory, output));
      expect((await rotate(source, output)).code).toBe(0);
      expect(await readFile(join(directory, output))).toEqual(completed);
      expect(await readFile(join(directory, source))).toEqual(before);
      for (const path of [output, `${output}.rotation.json`]) expect((await stat(join(directory, path))).mode & 0o777).toBe(0o600);
      await db.sql`UPDATE account_api_credentials SET created_at=now()-interval '2 days', expires_at=now()-interval '1 day' WHERE id=${result.credentialId}`;
      expect((await rotate(source, output)).code).toBe(1);
      expect(await accounts.authenticate(`Bearer ${pending.token}`)).toBeNull();
    }
  }, 30_000);
  it("does not revive a revoked replacement or revoke the source after a migration fence", async () => {
    for (const scenario of ["revoked", "fenced"] as const) {
      const parent = await accounts.issue(address, false, undefined, [...ALL_ACCOUNT_SCOPES]);
      const source = `${scenario}.json`, output = `${scenario}.next.json`;
      await save(source, record(parent)); loseIssuance = true;
      expect((await rotate(source, output)).code).toBe(1);
      const pending = JSON.parse(await readFile(join(directory, output), "utf8"));
      const replacement = await accounts.authenticate(`Bearer ${pending.token}`);
      expect(replacement).not.toBeNull();
      if (scenario === "revoked") await accounts.revoke(replacement!.credential_id);
      else await db.sql`INSERT INTO provider_migration_fences (did,account_id,transfer_id,destination_service_base,state)
        VALUES (${`did:plc:${"a".repeat(24)}`},${id},${randomUUID()},'https://target.example.com/hail','fenced')`;
      expect((await rotate(source, output)).code).toBe(1);
      expect(await accounts.authenticate(`Bearer ${parent.token}`)).not.toBeNull();
      if (scenario === "revoked") expect(await accounts.authenticate(`Bearer ${pending.token}`)).toBeNull();
      else await db.sql`DELETE FROM provider_migration_fences WHERE account_id=${id}`;
      const count = await db.sql<{count:number}[]>`SELECT count(*)::integer AS count FROM account_api_credentials WHERE account_id=${id} AND id IN (${parent.credentialId},${replacement!.credential_id})`;
      expect(count[0]!.count).toBe(2);
    }
  });
  it("rejects read-only/expired sources, conflicting outputs and cross-account retries without revocation", async () => {
    const readOnly = await accounts.issue(address);
    await save("readonly.json", record(readOnly));
    expect((await rotate("readonly.json", "readonly.next.json")).code).toBe(1);
    await expect(stat(join(directory, "readonly.next.json.rotation.json"))).rejects.toThrow();
    const parent = await accounts.issue(address, false, undefined, [...ALL_ACCOUNT_SCOPES]);
    await save("parent.json", record(parent));
    omitMetadata = true;
    try {
      const refused = await rotate("parent.json", "unsupported.next.json");
      expect(refused.stderr).toContain("current credential metadata");
      await expect(stat(join(directory, "unsupported.next.json.rotation.json"))).rejects.toThrow();
    } finally { omitMetadata = false; }
    expect((await rotate("parent.json", "parent.json")).code).toBe(1);
    await save("conflict.json", record(readOnly));
    expect((await rotate("parent.json", "conflict.json")).code).toBe(1);
    const foreign = await accounts.issue(otherAddress, false, undefined, [...ALL_ACCOUNT_SCOPES]);
    await save("foreign.json", record(foreign));
    expect((await rotate("foreign.json", "issuance.next.json")).code).toBe(1);
    expect(await accounts.authenticate(`Bearer ${foreign.token}`)).not.toBeNull();
    expect(await accounts.authenticate(`Bearer ${parent.token}`)).not.toBeNull();
    await db.sql`UPDATE account_api_credentials SET created_at=now()-interval '2 days', expires_at=now()-interval '1 day' WHERE id=${parent.credentialId}`;
    expect((await rotate("parent.json", "expired.next.json")).code).toBe(1);
    await expect(stat(join(directory, "expired.next.json.rotation.json"))).rejects.toThrow();
  });
});
