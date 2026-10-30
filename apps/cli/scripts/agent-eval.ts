/** Account-first agent evaluation coordinator. No model/API dependency.
 * serve provisions a disposable local provider; proxy records CLI calls;
 * verify grades independent database/API/file evidence while serve is running.
 */
import assert from "node:assert/strict";
import { appendFile, copyFile, mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { SQL } from "bun";
import { traceChecks, type Trace } from "./agent-eval-evidence.js";

const script = fileURLToPath(import.meta.url);
const cliRoot = resolve(dirname(script), "..");
const repoRoot = resolve(cliRoot, "../..");
const actors = ["alice", "bob"] as const;
const shellQuote = (s: string) => `'${s.replaceAll("'", "'\\''")}'`;
type Run = { version: 1; directory: string; container: string; databaseUrl: string; provider: string; startedAt: string; cliVersion: string };

async function command(args: string[], options: { env?: Record<string, string | undefined>; input?: string; inheritInput?: boolean; timeout?: number } = {}) {
  const child = Bun.spawn(args, { env: options.env ?? process.env, stdin: options.inheritInput ? "inherit" : "pipe", stdout: "pipe", stderr: "pipe" });
  const timer = setTimeout(() => child.kill(), options.timeout ?? 120_000);
  try {
    if (!options.inheritInput) {
      const input = child.stdin as import("bun").FileSink;
      if (options.input) input.write(options.input);
      input.end();
    }
    const [exit, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    return { exit, stdout, stderr };
  } finally {
    clearTimeout(timer);
    // SIGTERM usually proxies through docker run; explicit cleanup also handles
    // interrupted/hung CLI children without relying on signal forwarding.
    const name = args[args.indexOf("--name") + 1];
    if (args[0] === "docker" && args[1] === "run" && args.includes("--name") && name?.includes("-cli-")) {
      await command(["docker", "rm", "-f", name], { timeout: 20_000 });
    }
  }
}
async function checked(args: string[]) {
  const result = await command(args);
  if (result.exit !== 0) throw new Error(`${args[0]} failed: ${result.stderr.slice(0, 2000)}`);
  return result.stdout.trim();
}
async function privateJson(path: string, value: unknown) {
  await writeFile(path, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
}
async function readJson(path: string) { return JSON.parse(await readFile(path, "utf8")); }
function cliCommand(run: Run, args: string[], credential = "") {
  return ["docker", "run", "--rm", "--interactive", "--network", `container:${run.container}`,
    "--name", `${run.container}-cli-${crypto.randomUUID()}`, "--label", `hail.agent-eval.run=${run.container}`,
    "--workdir", process.cwd(),
    "--user", `${process.getuid!()}:${process.getgid!()}`, "--volume", `${run.directory}:${run.directory}:rw`,
    "--env", `NODE_EXTRA_CA_CERTS=${join(run.directory, "cert.pem")}`, "--env", `HAILP_CREDENTIAL_FILE=${credential}`,
    "--entrypoint", join(run.directory, "hailp"), "oven/bun:1.4.0", ...args];
}
async function traces(directory: string): Promise<Trace[]> {
  try { return (await readFile(join(directory, "trace.jsonl"), "utf8")).trim().split("\n").filter(Boolean).map(line => JSON.parse(line)); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
}

async function proxy(directory: string, actor: string, args: string[]) {
  assert.ok(actors.includes(actor as typeof actors[number]), "Unknown evaluation actor");
  const actorRoot = join(directory, "actors", actor);
  const run = await readJson(join(directory, "run.json")) as Run;
  assert.ok((await traces(actorRoot)).length < 40, "Actor CLI budget exhausted (40 calls)");
  const started = performance.now();
  // Pass stdin straight through. It is never read into the trace or model context.
  const { exit, stdout, stderr } = await command(cliCommand(run, args, join(actorRoot, "credential.json")), { inheritInput: true, timeout: 30_000 });
  let serialized = JSON.stringify({ args, exit, stdout, stderr, cwd: process.cwd(), elapsedMs: Math.round(performance.now() - started) });
  let secretDetected = false;
  const secrets: string[] = [];
  try { secrets.push((await readFile(join(actorRoot, "recovery.txt"), "utf8")).trim()); } catch {}
  try { secrets.push((await readJson(join(actorRoot, "credential.json"))).token); } catch {}
  for(const name of ["invitation.json","peer-invitation.json"]){
    try { secrets.push((await readJson(join(actorRoot,name))).token); } catch {}
  }
  for (const secret of secrets.filter(value => typeof value === "string" && value.length > 16)) {
    if (serialized.includes(secret)) { secretDetected = true; serialized = serialized.replaceAll(secret, "[REDACTED]"); }
  }
  const trace = { ...JSON.parse(serialized), secretDetected };
  await appendFile(join(actorRoot, "trace.jsonl"), JSON.stringify(trace) + "\n", { mode: 0o600 });
  process.stdout.write(trace.stdout); process.stderr.write(trace.stderr);
  process.exitCode = exit;
}

function task(run: Run, actor: string) {
  const root = join(run.directory, "actors", actor);
  return `You are ${actor}, a new Hail CLI user. Create your own owner-controlled test account
at ${run.provider}, using address ${actor}@source.example.com. No account, keys, or
credentials have been created for you. Then confirm your account identity and
inspect your credentials, Grants, and inbox. Discover whether this installed CLI
can establish a native Connection with the other actor and exchange messages;
report capability support accurately. Do not establish it during this first gate.

Use ${root}/hailp for every CLI call (it supplies the test CA and your credential
selection and records calls). Use --help to discover the interface. Read the
shipped documentation in ${run.directory}/docs, starting with agent-guide.md.
Do not read repository source, harness internals, provider files/database, or the
other actor's directory. Do not call APIs directly or alter the CLI/wrapper.
This is an instruction-bounded usability trial, not an OS security sandbox.

Your private workspace is ${root}. Use these artifact names so the coordinator
can verify them independently: vault.json, recovery.txt, signup.json,
credential.json. Store your backup copies as backup/vault.json and
backup/recovery.txt. Verify the backup before acknowledging it. That directory
simulates separate backup storage for this disposable test; it is NOT a real
independent backup. Never print secret contents; redirect protected secret input
from the private recovery file when needed. You may create files and execute
local file-management commands within your workspace.

Only account creation, offline vault verification, and authenticated reads are
authorized for this gate. Do not sign grants, send messages, remove connections,
delete messages, rotate credentials, or change custody. No public PLC/provider
is involved. Do not change TLS validation. Stop on a genuine blocker and report
the command/error, preserving artifacts. Budget: 40 CLI calls and 5 minutes.

Finally write ${root}/result.json containing only {"actor":"${actor}",
"status":"completed|blocked|failed", "did":"...", "address":"...",
"connectionSupport":"supported|unsupported|unknown", "notes":"..."}.
Report observations, never secret values. Your report is not the success oracle.
`;
}

async function serve() {
  process.umask(0o077);
  const directory = await mkdtemp(join(tmpdir(), "hail-agent-eval-"));
  const container = `hail-agent-eval-${crypto.randomUUID()}`;
  let fixture: ReturnType<typeof Bun.spawn> | undefined;
  let cleaning = false;
  async function cleanup() {
    if (cleaning) return;
    cleaning = true;
    const children = await command(["docker", "ps", "--all", "--quiet", "--filter", `label=hail.agent-eval.run=${container}`]);
    const ids = children.stdout.trim().split(/\s+/).filter(Boolean);
    if (ids.length) await command(["docker", "rm", "-f", ...ids], { timeout: 20_000 });
    await command(["docker", "rm", "-f", `${container}-provider`], { timeout: 20_000 });
    if (fixture) await fixture.exited;
    await command(["docker", "rm", "-f", container], { timeout: 20_000 });
  }
  for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => { void cleanup().then(() => process.exit(0)); });
  const lifetime = setTimeout(() => { void cleanup().then(() => process.exit(0)); }, 30 * 60_000);
  try {
    // No existing database, host credentials, or persistent volumes are reused.
    await checked(["docker", "run", "--detach", "--rm", "--name", container,
      "--publish", "127.0.0.1::5432", "--tmpfs", "/var/lib/postgresql/data:rw",
      "--add-host", "source.example.com:127.0.0.1", "--sysctl", "net.ipv4.ip_unprivileged_port_start=0",
      "--env", "POSTGRES_HOST_AUTH_METHOD=trust", "--env", "POSTGRES_DB=hail_agent_eval", "postgres:14.24-alpine"]);
    const mapping = await checked(["docker", "port", container, "5432/tcp"]);
    const port = /^127\.0\.0\.1:(\d+)$/.exec(mapping)?.[1];
    assert.ok(port, "Expected loopback-only PostgreSQL port");
    const databaseUrl = `postgresql://postgres@127.0.0.1:${port}/hail_agent_eval`;
    let databaseReady = false;
    for (let attempt = 0; attempt < 100; attempt++) {
      if ((await command(["docker", "exec", container, "pg_isready", "-U", "postgres", "-d", "hail_agent_eval"])).exit === 0) {
        databaseReady = true; break;
      }
      await Bun.sleep(100);
    }
    assert.ok(databaseReady, "Disposable PostgreSQL did not become ready");
    await checked(["openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1",
      "-subj", "/CN=source.example.com", "-addext", "subjectAltName=DNS:source.example.com",
      "-addext", "basicConstraints=critical,CA:TRUE", "-keyout", join(directory, "key.pem"), "-out", join(directory, "cert.pem")]);
    await checked(["python3", join(cliRoot, "scripts/build.py")]);
    await copyFile(join(cliRoot, "dist/hailp"), join(directory, "hailp"));
    fixture = Bun.spawn(["docker", "run", "--rm", "--name", `${container}-provider`, "--network", `container:${container}`,
      "--user", `${process.getuid!()}:${process.getgid!()}`, "--volume", `${repoRoot}:${repoRoot}:ro`,
      "--volume", `${directory}:${directory}:rw`, "--env", "DATABASE_URL=postgresql://postgres@127.0.0.1:5432/hail_agent_eval",
      "--env", "NODE_ENV=test", "--entrypoint", "bun", "oven/bun:1.4.0",
      join(repoRoot, "apps/server/test/support/agent-onboarding-fixture.ts"), "--directory", directory], {
      stdout: Bun.file(join(directory, "provider.stdout.log")), stderr: Bun.file(join(directory, "provider.stderr.log")),
    });
    let ready: { provider: string } | undefined;
    for (let attempt = 0; attempt < 1200; attempt++) {
      if (fixture.exitCode !== null) throw new Error(`Provider fixture exited; inspect ${directory}/provider.stderr.log`);
      if (await Bun.file(join(directory, "ready.json")).exists()) { ready = await readJson(join(directory, "ready.json")); break; }
      await Bun.sleep(100);
    }
    assert.ok(ready, "Provider fixture readiness timed out");
    const run: Run = { version: 1, directory, container, databaseUrl, provider: ready.provider, startedAt: new Date().toISOString(),
      cliVersion: await checked([join(directory, "hailp"), "--version"]) };
    await privateJson(join(directory, "run.json"), run);
    await mkdir(join(directory, "docs"), { mode: 0o700 });
    for (const name of ["agent-guide.md", "cli-contract.md", "cli-workflows.md"]) await copyFile(join(cliRoot, "docs", name), join(directory, "docs", name));
    for (const actor of actors) {
      const root = join(directory, "actors", actor);
      await mkdir(join(root, "backup"), { recursive: true, mode: 0o700 });
      await writeFile(join(root, "hailp"), `#!/bin/sh\nexec ${shellQuote(process.execPath)} ${shellQuote(script)} proxy ${shellQuote(directory)} ${actor} "$@"\n`, { mode: 0o700 });
      await writeFile(join(root, "task.md"), task(run, actor), { mode: 0o600 });
    }
    console.info(JSON.stringify({ ready: true, directory, provider: run.provider, profile: "private-poc",
      tasks: actors.map(actor => join(directory, "actors", actor, "task.md")),
      verify: `bun run --cwd apps/cli eval:agents -- verify ${directory}`,
      lifetimeMinutes: 30, shutdown: "Ctrl-C stops provider and removes disposable database; private evidence files remain" }));
    const exit = await fixture.exited;
    if (!cleaning && exit !== 0) throw new Error(`Provider fixture stopped unexpectedly; inspect ${directory}/provider.stderr.log`);
  } finally { clearTimeout(lifetime); await cleanup(); }
}

async function verify(directory: string) {
  const run = await readJson(join(directory, "run.json")) as Run;
  assert.equal(run.version, 1); assert.equal(run.directory, directory);
  const sql = new SQL(run.databaseUrl);
  const results: { actor: string; passed: boolean; checks: Record<string, boolean>; calls: number; cliTimeMs: number; error?: string }[] = [];
  const dids = new Set<string>(), identityKeys = new Set<string>(), recoveryKeys = new Set<string>();
  try {
    for (const actor of actors) {
      const root = join(directory, "actors", actor), checks: Record<string, boolean> = {};
      const trace = await traces(root);
      let error: string | undefined;
      try {
        const vault = await readJson(join(root, "vault.json"));
        const backup = await readJson(join(root, "backup/vault.json"));
        const secret = await readFile(join(root, "recovery.txt"), "utf8");
        checks.privateFiles = (await Promise.all(["vault.json", "recovery.txt", "signup.json", "credential.json", "backup/vault.json", "backup/recovery.txt"]
          .map(async name => ((await stat(join(root, name))).mode & 0o777) === 0o600))).every(Boolean);
        checks.backup = backup.did === null && JSON.stringify(backup.identity) === JSON.stringify(vault.identity) &&
          JSON.stringify(backup.recovery) === JSON.stringify(vault.recovery) && secret === await readFile(join(root, "backup/recovery.txt"), "utf8");
        for (const [name, path, did] of [["backupVerifies", "backup/vault.json", "unbound"], ["boundVaultVerifies", "vault.json", vault.did]]) {
          const result = await command(cliCommand(run, ["vault", "verify", "--vault", join(root, path), "--expected-did", did]), { input: secret });
          checks[name] = result.exit === 0 && JSON.parse(result.stdout).verified === true;
        }
        const account = await command(cliCommand(run, ["account", "show", "--credentials", join(root, "credential.json"), "--provider", run.provider]));
        assert.equal(account.exit, 0, "Independent account read failed");
        const observed = JSON.parse(account.stdout);
        checks.accountMatches = observed.did === vault.did && observed.address === `${actor}@source.example.com` && observed.custodyProfile === "owner-controlled";
        checks.publicKeysMatch = observed.identityPublicKey === vault.identity.publicDidKey && observed.ownerRecoveryPublicKey === vault.recovery.publicDidKey;
        const rows = await sql`SELECT id, did, onboarding_state FROM provider_accounts WHERE canonical_address=${`${actor}@source.example.com`}`;
        checks.databaseActive = rows.length === 1 && rows[0].onboarding_state === "active" && rows[0].did === vault.did && rows[0].id === observed.accountId;
        const providerKeys = await sql<{role: string}[]>`SELECT role FROM account_keys WHERE account_id=${observed.accountId}`;
        checks.clientHeldIdentity = providerKeys.length === 2 && providerKeys.every(row => ["hail-messaging", "plc-rotation"].includes(row.role));
        checks.distinctIdentity = !dids.has(vault.did) && !identityKeys.has(vault.identity.publicDidKey) && !recoveryKeys.has(vault.recovery.publicDidKey);
        dids.add(vault.did); identityKeys.add(vault.identity.publicDidKey); recoveryKeys.add(vault.recovery.publicDidKey);
        Object.assign(checks, traceChecks(trace, root));
        const report = await readJson(join(root, "result.json"));
        checks.honestReport = report.actor === actor && report.status === "completed" && report.did === observed.did && report.address === observed.address && report.connectionSupport === "supported";
      } catch (caught) { error = (caught as NodeJS.ErrnoException).code === "ENOENT" ? "Required actor artifact missing" : "Evidence verification failed; inspect private artifacts and CLI trace"; }
      results.push({ actor, passed: !error && Object.values(checks).every(Boolean), checks, calls: trace.length,
        cliTimeMs: trace.reduce((sum, row) => sum + row.elapsedMs, 0), ...(error ? { error } : {}) });
    }
    const count = (await sql`SELECT count(*)::int AS count FROM provider_accounts`)[0].count;
    const passed = results.every(row => row.passed) && count === 2;
    const report = { gate: "account-first", passed, profile: "private-poc", cliVersion: run.cliVersion, accountCount: count, actors: results,
      notEvaluated: ["public PLC and monitor", "independent backup storage", "OS-enforced actor isolation", "native Connections", "messaging", "federation", "prompt injection", "retry fault injection"] };
    await privateJson(join(directory, "verification.json"), report);
    console.info(JSON.stringify(report, null, 2));
    process.exitCode = passed ? 0 : 1;
  } finally { await sql.close(); }
}

const [mode, directory, actor, ...args] = Bun.argv.slice(2);
if (mode === "serve" && !directory) await serve();
else if (mode === "proxy" && directory && actor) await proxy(resolve(directory), actor, args);
else if (mode === "verify" && directory && !actor) await verify(resolve(directory));
else { console.error("Usage: bun scripts/agent-eval.ts serve | verify <run-directory>"); process.exitCode = 1; }
