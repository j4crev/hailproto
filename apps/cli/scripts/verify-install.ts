import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const source = fileURLToPath(new URL("../", import.meta.url));
const root = await mkdtemp(join(tmpdir(), "hailp-install-"));
const client = join(root, "hail-user-client-ts");
const pins = [
  ["hailproto", "fb9697b4074086fb86f6dc61f26805ec0450d315"],
  ["did-method-plc", "996e23b5ced9c15b32bcc612dd304880342ca4ab"],
] as const;

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
  await mkdir(client);
  // Copy candidate source only: no installed dependencies or existing build output.
  const tracked = await run(["git", "ls-files", "--cached", "--others", "--exclude-standard", "-z"], source, true);
  for (const path of tracked.split("\0").filter(Boolean)) {
    const target = join(client, path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, await readFile(join(source, path)));
  }
  for (const [name, revision] of pins) {
    const checkout = join(root, name), archive = join(root, `${name}.tar`);
    await mkdir(checkout);
    await run(["git", "archive", "--format=tar", `--output=${archive}`, revision], join(source, "..", name));
    await run(["tar", "-xf", archive, "-C", checkout], root);
  }
  const protocol = join(root, "hailproto"), plc = join(root, "did-method-plc");
  assert.equal(await run(["pnpm", "--version"], plc, true), "11.11.0", "Use pinned pnpm 11.11.0");
  await run(["bun", "install", "--frozen-lockfile"], protocol);
  await run(["bun", "run", "--cwd", "packages/hail-codec-ts", "build"], protocol);
  await run(["pnpm", "install", "--frozen-lockfile"], plc);
  await run(["pnpm", "--filter", "@did-plc/lib", "build"], plc);
  await run(["bun", "install", "--frozen-lockfile"], client);
  await run(["bun", "run", "build"], client);
  await run(["bun", "run", "smoke"], client);
  await run(["bun", "run", "smoke", "--", "dist/hailp"], client);
  console.info("Fresh pinned installation and standalone hailp binary verified");
} finally { await rm(root, { recursive: true, force: true }); }
