import { chmod, mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { expect, it } from "vitest";
import { writeTransferRecord } from "../src/cli/transfer-record.js";

it("recovers an exact private record retry without overwriting conflicts or insecure files", async () => {
  const dir = await mkdtemp(join(tmpdir(), "hail-record-"));
  const path = join(dir, "receipt.json");
  const signed = { payloadBytes: new Uint8Array([1, 2]), signature: new Uint8Array([3, 4]) };
  try {
    await writeTransferRecord(path, signed);
    const first = await readFile(path);
    await writeTransferRecord(path, signed);
    expect(await readFile(path)).toEqual(first);
    await expect(writeTransferRecord(path, { ...signed, signature: new Uint8Array([5, 6]) }))
      .rejects.toThrow("differs");
    expect(await readFile(path)).toEqual(first);
    await chmod(path, 0o644);
    await expect(writeTransferRecord(path, signed)).rejects.toThrow("mode 0600");
  } finally { await rm(dir, { recursive: true, force: true }); }
});
