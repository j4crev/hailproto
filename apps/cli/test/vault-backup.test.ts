import { randomBytes } from "node:crypto";
import { chmod, mkdtemp, readFile, rm, stat, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { encodeBase64Url } from "@hailproto/codec";
import { expect, it } from "vitest";
import { createUserVault } from "../src/vault.js";
import { copyVerifiedVault, verifyVaultFile } from "../src/vault-backup.js";

it("verifies, backs up and imports exact private vaults offline without overwriting or accepting damaged keys", async () => {
  const generated = await createUserVault();
  const dir = await mkdtemp(join(tmpdir(), "hail-vault-backup-"));
  try {
    const source = join(dir, "source.json");
    const backup = join(dir, "backup.json");
    const imported = join(dir, "imported.json");
    const original = JSON.stringify(generated.vault);
    await writeFile(source, original, { mode: 0o600 });
    const publicResult = { verified: true, did: null, recoveryPublicKey: generated.vault.recovery.publicDidKey,
      identityPublicKey: generated.vault.identity.publicDidKey };
    expect(await verifyVaultFile(source, generated.recoverySecret, null)).toEqual(publicResult);
    await expect(copyVerifiedVault(source, backup, randomBytes(32))).rejects.toThrow();
    await expect(stat(backup)).rejects.toThrow();
    await expect(copyVerifiedVault(source, backup, generated.recoverySecret, `did:plc:${"a".repeat(24)}`)).rejects.toThrow("reviewed DID");
    await expect(stat(backup)).rejects.toThrow();
    await copyVerifiedVault(source, backup, generated.recoverySecret);
    expect(await readFile(backup, "utf8")).toBe(original);
    expect((await stat(backup)).mode & 0o777).toBe(0o600);
    await expect(copyVerifiedVault(source, backup, generated.recoverySecret)).rejects.toThrow();
    expect(await readFile(backup, "utf8")).toBe(original);
    await chmod(backup, 0o644);
    await expect(verifyVaultFile(backup, generated.recoverySecret)).rejects.toThrow("private");
    await chmod(backup, 0o600);
    const publicDir = join(dir, "public");
    await mkdir(publicDir, { mode: 0o755 });
    await expect(copyVerifiedVault(source, join(publicDir, "vault.json"), generated.recoverySecret)).rejects.toThrow("directory");
    const damaged = join(dir, "damaged.json");
    await writeFile(damaged, JSON.stringify({ ...generated.vault,
      recovery: { ...generated.vault.recovery, ciphertext: "AA" } }), { mode: 0o600 });
    await expect(copyVerifiedVault(damaged, imported, generated.recoverySecret)).rejects.toThrow();
    await expect(stat(imported)).rejects.toThrow();
    await writeFile(damaged, JSON.stringify({ ...generated.vault, token: "unexpected private material" }));
    await expect(verifyVaultFile(damaged, generated.recoverySecret)).rejects.toThrow("representation");

    const invoke = async (args: string[]) => {
      const child = Bun.spawn(["bun", "src/cli/hailp.ts", "vault", ...args], {
        cwd: new URL("..", import.meta.url).pathname, stdin: "pipe", stdout: "pipe", stderr: "pipe",
      });
      child.stdin.write(`${encodeBase64Url(generated.recoverySecret)}\n`);
      child.stdin.end();
      const stdout = await new Response(child.stdout).text();
      const stderr = await new Response(child.stderr).text();
      return { code: await child.exited, stdout, stderr };
    };
    const result = await invoke(["import", "--file", backup, "--vault", imported, "--expected-did", "unbound"]);
    expect(result.code, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ ...publicResult, vaultFile: imported, cliContractVersion: 1 });
    expect(await readFile(imported, "utf8")).toBe(original);
    expect((await stat(imported)).mode & 0o777).toBe(0o600);
    const verified = await invoke(["verify", "--vault", imported, "--expected-did", "unbound"]);
    expect(verified.code, verified.stderr).toBe(0);
    expect(JSON.parse(verified.stdout)).toEqual({ ...publicResult, cliContractVersion: 1 });
    expect((await invoke(["import", "--file", backup, "--vault", imported])).code).not.toBe(0);
    expect((await invoke(["verify", "--vault", imported, "--credentials", "unused"])).code).not.toBe(0);
    const cliBackup = join(dir, "cli-backup.json");
    const copied = await invoke(["backup", "--vault", imported, "--output", cliBackup]);
    expect(copied.code, copied.stderr).toBe(0);
    expect(await readFile(cliBackup, "utf8")).toBe(original);
    const recovery = join(dir, "recovery.txt");
    await writeFile(recovery, `${encodeBase64Url(generated.recoverySecret)}\n`, { mode: 0o600 });
    const legacyBackup = join(dir, "legacy-backup.json");
    const legacy = Bun.spawn(["bun", "src/cli/verify-private-poc-backup.ts", source, recovery, legacyBackup], {
      cwd: new URL("..", import.meta.url).pathname, stdout: "pipe", stderr: "pipe",
    });
    const legacyError = await new Response(legacy.stderr).text();
    expect(await legacy.exited, legacyError).toBe(0);
    expect(await readFile(legacyBackup, "utf8")).toBe(original);
  } finally {
    generated.recoverySecret.fill(0);
    await rm(dir, { recursive: true, force: true });
  }
}, 30_000);
