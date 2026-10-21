import { generateKeyPairSync, randomUUID } from "node:crypto";
import { encodeBase64Url } from "@hailproto/codec";
import { expect, it } from "vitest";
import { createPocAlertReceiver } from "../src/cli/poc-alert-receiver.js";
import { MonitorSigner } from "../src/signing.js";

it("retains only authenticated alerts and accepts exact retries without overwriting conflicts", async () => {
  const signer = new MonitorSigner(generateKeyPairSync("ed25519").privateKey);
  const receiver = createPocAlertReceiver(":memory:", signer.publicDidKey);
  const alert = { type: "hail.plc-monitor-alert", version: 1, id: randomUUID(),
    did: `did:plc:${"a".repeat(24)}`, category: "unexpected-operation" };
  const bytes = new TextEncoder().encode(JSON.stringify(alert));
  const request = (body: Uint8Array, signature = signer.signAlert(body)) => new Request(
    "https://hailproto.app/poc/monitor-alerts", { method: "POST", body: Uint8Array.from(body),
      headers: { "X-Hail-Monitor-Key": signer.publicDidKey,
        "X-Hail-Monitor-Signature": encodeBase64Url(signature) } });
  try {
    expect((await receiver.fetch(request(bytes, new Uint8Array(64)))).status).toBe(401);
    expect((await receiver.fetch(request(bytes))).status).toBe(204);
    expect((await receiver.fetch(request(bytes))).status).toBe(204);
    const conflict = new TextEncoder().encode(JSON.stringify({ ...alert, category: "coverage-lost" }));
    expect((await receiver.fetch(request(conflict))).status).toBe(409);
    expect((await receiver.fetch(request(bytes))).status).toBe(204);
    expect((await receiver.fetch(request(new Uint8Array(16_385)))).status).toBe(413);
  } finally { receiver.close(); }
});
