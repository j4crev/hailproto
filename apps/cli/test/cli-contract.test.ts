import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { AccountApiClient, AccountApiError } from "../src/account-api.js";
import { listPages, waitForStatus } from "../src/account-reads.js";
import { parseCommand } from "../src/cli/options.js";

const id = "019a0000-0000-7000-8000-000000000001";
const otherId = "019a0000-0000-7000-8000-000000000002";
const sender = `did:plc:${"a".repeat(24)}`;

it("proves the process contract and rejects misplaced options, duplicate flags and missing inputs before side effects", async () => {
  const child = Bun.spawn([process.execPath, "scripts/smoke.ts"], { cwd: new URL("../", import.meta.url).pathname, stdout: "pipe", stderr: "pipe" });
  const [exit, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  expect(exit, stderr).toBe(0); expect(stdout).toContain("smoke passed");
  for (const args of [
    ["grant", "create", "sender@example.com", "--output", "must-not-exist", "--category", "updates", "--scope", "account:write"],
    ["account", "create", "--provider", "https://example.com", "--address", "user@example.com", "--custody", "managed", "--vault", "x", "--state", "y", "--credentials", "z", "--backup-verified", "--wait", "2"],
    ["account", "show", "extra"], ["account", "show", "--credentials", "a", "--credentials", "b"],
    ["send", "--grant", id, "--file", "x", "--state", "y", "--category", "a", "--category", "b"],
    ["reply", id, "--file", "x", "--state", "y", "--category", "a"],
    ["message", "status", id, "--interval", "1"], ["grant", "list", "--pages", "0"],
    ["grant", "update", id, "--output", "x", "--category", "a", "--expires-at", "1.5"],
  ]) expect(() => parseCommand(args)).toThrow();
  expect(parseCommand(["grant", "update", "--help"]).help).toContain("fresh verified consent");
  expect(parseCommand(["account","managed-transfer","export","--state","state.json","--output","snapshot.json",
    "--credentials","credential.json"]).authenticated).toBe(true);
  expect(parseCommand(["account","managed-transfer","sign-cutover","--vault","vault.json","--state","state.json",
    "--snapshot","snapshot.json","--operation","operation.json","--approval","approval.json"]).authenticated).toBe(false);
  expect(parseCommand(["account","managed-transfer","complete","--state","state.json","--snapshot","snapshot.json"]).authenticated).toBe(false);
  expect(parseCommand(["grant", "create", "sender@example.com", "--category", "a", "--category", "b", "--output", "x"]).values.category).toEqual(["a", "b"]);
  expect(parseCommand(["profile","create","--file","profile.json"]).authenticated).toBe(true);
  expect(()=>parseCommand(["profile","update"])).toThrow();
},15_000);

it("binds selection before network, preserves private credentials and produces bounded actionable HTTP errors", async () => {
  const directory = await mkdtemp(join(tmpdir(), "hail-contract-"));
  const path = join(directory, "credential.json"), accountId = randomUUID(), token = `hailp_${"a".repeat(43)}`;
  const contents = JSON.stringify({ type: "hailp.api-credential", version: 1, provider: "https://source.example.com", accountId, token });
  const transport = vi.fn(async () => new Response("UNTRUSTED ERROR BODY", { status: 429, headers: { "Retry-After": "600" } }));
  vi.stubGlobal("fetch", transport);
  try {
    await writeFile(path, contents, { mode: 0o600 });
    await expect(AccountApiClient.fromCredentialFile(path, { provider: "https://target.example.com" })).rejects.toMatchObject({ code: "SELECTION_MISMATCH" });
    await expect(AccountApiClient.fromCredentialFile(path, { accountId: randomUUID() })).rejects.toMatchObject({ code: "SELECTION_MISMATCH" });
    expect(transport).not.toHaveBeenCalled();
    const client = await AccountApiClient.fromCredentialFile(path, { provider: "https://source.example.com", accountId });
    await expect(client.request("")).rejects.toMatchObject({ status: 429, retryAfterSeconds: 300 });
    const [url, init] = transport.mock.calls[0]! as unknown as [string, RequestInit];
    expect(url).toBe("https://source.example.com/api/v1/account");
    expect(init.redirect).toBe("error"); expect(new Headers(init.headers).get("Authorization")).toBe(`Bearer ${token}`);
    for (const args of [["account", "show", "--credentials", path, "--provider", "https://target.example.com"],
      ["account", "show", "--account-id", randomUUID()]]) {
      const child = Bun.spawn([process.execPath, "src/cli/hailp.ts", ...args], { cwd: new URL("../", import.meta.url).pathname,
        env: { ...process.env, HAILP_CREDENTIAL_FILE: path }, stdout: "pipe", stderr: "pipe" });
      const [exit, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
      expect(exit).toBe(1); expect(stdout).toBe(""); expect(JSON.parse(stderr).error.code).toBe("SELECTION_MISMATCH"); expect(stderr).not.toContain(token);
    }
    transport.mockImplementationOnce(async () => new Response("{invalid", { headers: { "Content-Type": "application/json" } }));
    await expect(client.request("")).rejects.toMatchObject({ code: "RESPONSE_ERROR" });
    transport.mockImplementationOnce(async () => { throw new Error(token); });
    await expect(client.request("")).rejects.toMatchObject({ code: "TRANSPORT_ERROR" });
  } finally { vi.unstubAllGlobals(); await rm(directory, { recursive: true, force: true }); }
});

it("paginates within bounds, retains next cursors and rejects malformed/cyclic pages", async () => {
  const request = vi.fn().mockResolvedValueOnce({ grants: [{ grantId: id }], next: id })
    .mockResolvedValueOnce({ grants: [{ grantId: otherId }], next: null });
  const client = { request } as unknown as AccountApiClient;
  expect(await listPages(client, "grants", undefined, 2)).toEqual({ grants: [{ grantId: id }, { grantId: otherId }], next: null });
  expect(request.mock.calls.map(call => call[0])).toEqual(["/grants", `/grants?after=${id}`]);
  request.mockResolvedValue({ grants: [{ grantId: id }], next: id });
  expect(await listPages(client, "grants")).toEqual({ grants: [{ grantId: id }], next: id });
  await expect(listPages(client, "grants", undefined, 2)).rejects.toMatchObject({ code: "RESPONSE_ERROR" });
  await expect(listPages(client, "grants", "bad")).rejects.toMatchObject({ code: "USAGE_ERROR" });
  request.mockResolvedValue({ messages: [{ messageId: id, sender }], next: "opaque_cursor" });
  expect((await listPages(client, "inbox")).next).toBe("opaque_cursor");
  request.mockResolvedValue({ credentials: [{ credentialId: randomUUID() }], next: null });
  expect((await listPages(client, "credentials")).credentials).toHaveLength(1);
  for (const value of [{ grants: [], next: id }, { grants: [], next: 42 },
    { grants: Array.from({ length: 51 }, () => ({ grantId: id })), next: null },
    { grants: [{ grantId: id, text: "x".repeat(8 * 1024 * 1024) }], next: null }]) {
    request.mockResolvedValue(value); await expect(listPages(client, "grants")).rejects.toMatchObject({ code: "RESPONSE_ERROR" });
  }
});

it("waits read-only on the same ID, honors throttling and preserves indeterminate/accepted status on deadline", async () => {
  const request = vi.fn().mockResolvedValueOnce({ messageId: id, state: "indeterminate", revision: null })
    .mockRejectedValueOnce(new AccountApiError(429, 1))
    .mockResolvedValueOnce({ messageId: id, state: "delivered", revision: 2 });
  const client = { request } as unknown as AccountApiClient;
  expect(await waitForStatus(client, id, 5, 1)).toMatchObject({ state: "delivered", wait: { completed: true, timedOut: false } });
  for (const call of request.mock.calls) { expect(call[0]).toBe(`/messages/${id}`); expect(call[1]).toBeUndefined(); expect(call[4]).toBeInstanceOf(AbortSignal); }
  for (const state of ["indeterminate", "accepted", "on-hold"]) {
    request.mockResolvedValue({ messageId: id, state, revision: state === "indeterminate" ? null : 1 });
    expect(await waitForStatus(client, id, 1, 1)).toMatchObject({ state, wait: { completed: false, timedOut: true } });
  }
  for (const state of ["failed", "cancelled"]) {
    request.mockResolvedValue({ messageId: id, state, revision: 2 });
    expect(await waitForStatus(client, id, 1, 1)).toMatchObject({ state, wait: { completed: true, timedOut: false } });
  }
  request.mockResolvedValue({ messageId: otherId, state: "delivered", revision: 2 });
  await expect(waitForStatus(client, id)).rejects.toMatchObject({ code: "RESPONSE_ERROR" });
  request.mockRejectedValue(new AccountApiError(403));
  await expect(waitForStatus(client, id, 1)).rejects.toMatchObject({ status: 403 });
  request.mockRejectedValue(new AccountApiError(503, 300));
  const start = Date.now(); await expect(waitForStatus(client, id, 1)).rejects.toMatchObject({ status: 503 });
  expect(Date.now() - start).toBeLessThan(2000);
}, 15_000);
