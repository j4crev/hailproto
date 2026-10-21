import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const source = fileURLToPath(new URL("../", import.meta.url));
const root = await mkdtemp(join(tmpdir(), "hailp-install-"));
const repository = join(source, "../..");
const candidate = join(root, "hailproto");
const client = join(candidate, "apps/cli");

async function run(command: string[], cwd: string, quiet = false): Promise<string> {
  const child = Bun.spawn(command, { cwd, stdout: "pipe", stderr: "pipe" });
  const [exit, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  assert.equal(exit, 0, `${command.join(" ")} failed\n${stdout}\n${stderr}`);
  if (!quiet && stdout.trim()) console.info(stdout.trim());
  return stdout.trim();
}

try {
  assert.equal(Bun.version, "1.4.0", "Use the pinned Bun 1.4.0 toolchain");
  assert.equal(await run(["node", "--version"], source, true), "v26.7.0", "Use the verified Node 26.7.0 build toolchain");
  await mkdir(candidate);
  // Copy candidate source only: no installed dependencies or existing build output.
  const tracked = await run(["git", "ls-files", "--cached", "--others", "--exclude-standard", "-z"], repository, true);
  for (const path of tracked.split("\0").filter(Boolean)) {
    if (path === "vendor/did-method-plc") continue;
    const target = join(candidate, path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, await readFile(join(repository, path)));
  }
  const plc = join(candidate, "vendor/did-method-plc"), archive = join(root, "did-method-plc.tar");
  await mkdir(plc, { recursive: true });
  await run(["git", "archive", "--format=tar", `--output=${archive}`, "HEAD"], join(repository, "vendor/did-method-plc"));
  await run(["tar", "-xf", archive, "-C", plc], root);
  assert.equal(await run(["pnpm", "--version"], plc, true), "11.11.0", "Use pinned pnpm 11.11.0");
  await run(["pnpm", "install", "--frozen-lockfile"], plc);
  await run(["pnpm", "--filter", "@did-plc/lib", "build"], plc);
  await run(["bun", "install", "--frozen-lockfile"], candidate);
  await run(["bun", "run", "--cwd", "packages/hail-codec-ts", "build"], candidate);
  await run(["bun", "run", "build"], client);
  await run(["bun", "run", "smoke"], client);
  await run(["bun", "run", "smoke", "--", "dist/hailp"], client);
  console.info("Fresh pinned installation and standalone hailp binary verified");
} finally { await rm(root, { recursive: true, force: true }); }
