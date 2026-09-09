import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

import { afterAll, describe, expect, it } from "vitest";

interface PayloadVector {
  readonly id: string;
  readonly payload_hex: string;
}

interface VectorManifest {
  readonly positive: readonly PayloadVector[];
}

const directory = mkdtempSync(join(tmpdir(), "hail-codec-cli-"));
const cli = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
const manifest = JSON.parse(
  readFileSync(new URL("../vectors/v0.json", import.meta.url), "utf8"),
) as VectorManifest;

afterAll(() => rmSync(directory, { force: true, recursive: true }));

function vectorFile(id: string): string {
  const vector = manifest.positive.find((entry) => entry.id === id);
  if (vector === undefined) throw new Error(`missing vector ${id}`);
  const path = join(directory, `${id}.cbor`);
  writeFileSync(path, Buffer.from(vector.payload_hex, "hex"));
  return path;
}

function run(...arguments_: string[]) {
  return spawnSync("bun", [cli, ...arguments_], {
    encoding: "utf8",
  });
}

describe("hail-codec CLI", () => {
  it("renders validated payload diagnostic notation", () => {
    const result = run(
      "diagnose",
      "hail.body.spt-1",
      vectorFile("body-spt-1-basic"),
    );
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('"profile": "spt-1"');
    expect(result.stderr).toBe("");
  });

  it("requires an exact opt-in before revealing bearer tokens", () => {
    const path = vectorFile("envelope-basic");
    const redacted = run("diagnose", "hail.envelope", path);
    expect(redacted.status).toBe(0);
    expect(redacted.stdout).toContain('"token": "[REDACTED]"');

    const revealed = run("diagnose", "hail.envelope", path, "--show-secrets");
    expect(revealed.status).toBe(0);
    expect(revealed.stdout).toContain(`"token": h'${"02".repeat(32)}'`);

    const trailing = run(
      "diagnose",
      "hail.envelope",
      path,
      "--show-secrets",
      "unexpected",
    );
    expect(trailing.status).toBe(2);
    expect(trailing.stdout).toBe("");
  });

  it("rejects oversized files before decoding", () => {
    const path = join(directory, "oversized.cbor");
    writeFileSync(path, new Uint8Array(262_145));
    const result = run("diagnose", "hail.body.spt-1", path);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("resource-limit: input file is too large");
  });
});
