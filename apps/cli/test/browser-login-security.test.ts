import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { expect, it } from "vitest";
import { browserLogin } from "../src/browser-login.js";

it("cancels an oversized authorization response before buffering the whole body", async () => {
  const directory = await mkdtemp(join(tmpdir(), "hail-login-security-"));
  let chunks = 0, cancelled = false;
  try {
    const transport = async () => new Response(new ReadableStream<Uint8Array>({
      pull(controller) {
        if (chunks === 256) { controller.close(); return; }
        chunks++;
        controller.enqueue(new Uint8Array(4096));
      },
      cancel() { cancelled = true; },
    }), { headers: { "Content-Type": "application/json" } });
    await expect(browserLogin("https://example.com", [], join(directory, "state.json"),
      join(directory, "credential.json"), async () => {}, transport)).rejects.toThrow("too large");
    expect({ bounded: chunks <= 18, cancelled }).toEqual({ bounded: true, cancelled: true });
  } finally { await rm(directory, { recursive: true, force: true }); }
});
