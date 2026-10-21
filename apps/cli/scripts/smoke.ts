import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import packageInfo from "../package.json" with { type: "json" };

// A supplied executable is tested without Bun as its launcher.
const command = Bun.argv[2] ? [resolve(Bun.argv[2])] : [process.execPath, new URL("../src/cli/hailp.ts", import.meta.url).pathname];
async function run(args: string[], input = "") {
  const child = Bun.spawn([...command, ...args], {
    env: { ...process.env, HAILP_CREDENTIAL_FILE: "" }, stdin: "pipe", stdout: "pipe", stderr: "pipe",
  });
  if (input) child.stdin.write(input);
  child.stdin.end();
  const [exit, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  return { exit, stdout, stderr };
}
const version = await run(["--version"]);
assert.deepEqual(version, { exit: 0, stdout: `${packageInfo.version}\n`, stderr: "" });
for (const name of [[], ["account"], ["account", "transfer"], ["message", "status"], ["grant", "update"], ["vault", "verify"]]) {
  const result = await run([...name, "--help"]);
  assert.equal(result.exit, 0); assert.equal(result.stderr, "");
  assert.match(result.stdout, /hailp/);
}
for (const args of [["--unknown"], ["account", "show", "--category", "irrelevant"],
  ["vault", "create", "--grant", "not-authority"], ["inbox", "list", "--pages", "101"],
  ["message", "status", "--interval", "1"], ["--version", "--help"]]) {
  const result = await run(args);
  assert.equal(result.exit, 1); assert.equal(result.stdout, "");
  const error = JSON.parse(result.stderr);
  assert.equal(error.cliContractVersion, 1); assert.equal(error.error.code, "USAGE_ERROR");
}
const missing = await run(["account", "show"]);
assert.equal(missing.exit, 1); assert.equal(missing.stdout, "");
assert.equal(JSON.parse(missing.stderr).error.code, "CLIENT_ERROR");
const directory = await mkdtemp(join(tmpdir(), "hailp-smoke-"));
try {
  const vault = join(directory, "vault.json"), recovery = join(directory, "secret.txt");
  const created = await run(["vault", "create", "--vault", vault, "--recovery-file", recovery]);
  assert.equal(created.exit, 0, created.stderr);
  assert.equal(JSON.parse(created.stdout).cliContractVersion, 1);
  for (const path of [vault, recovery]) assert.equal((await stat(path)).mode & 0o777, 0o600);
  const secret = await readFile(recovery, "utf8");
  const verified = await run(["vault", "verify", "--vault", vault, "--expected-did", "unbound"], secret);
  assert.equal(verified.exit, 0, verified.stderr);
  assert.equal(JSON.parse(verified.stdout).verified, true);
  assert.equal(verified.stderr, "");
  assert.ok(!(created.stdout + created.stderr + verified.stdout + verified.stderr).includes(secret.trim()));
} finally { await rm(directory, { recursive: true, force: true }); }
console.info(`hailp ${packageInfo.version} smoke passed (${Bun.argv[2] ? "compiled binary" : "Bun source"})`);
