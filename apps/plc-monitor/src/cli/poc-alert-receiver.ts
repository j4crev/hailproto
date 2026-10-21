import { createPublicKey, verify } from "node:crypto";
import { Database } from "bun:sqlite";
import { base58btc } from "multiformats/bases/base58";
import { decodeBase64Url } from "@hailproto/codec";
import { parseJsonWithoutDuplicateKeys } from "../strict-json.js";

// POC receipt sink only: same-host delivery does not establish independence.
export function createPocAlertReceiver(path: string, monitorDidKey: string) {
  const publicBytes = base58btc.decode(monitorDidKey.replace(/^did:key:/, ""));
  if (publicBytes.length !== 34 || publicBytes[0] !== 0xed || publicBytes[1] !== 0x01) {
    throw new Error("POC receiver requires an Ed25519 monitor did:key");
  }
  const key = createPublicKey({ format: "der", type: "spki", key: Buffer.concat([
    Buffer.from("302a300506032b6570032100", "hex"), Buffer.from(publicBytes.subarray(2)),
  ]) });
  const db = new Database(path, { create: true });
  db.run(`CREATE TABLE IF NOT EXISTS alert_receipts
    (id TEXT PRIMARY KEY, payload BLOB NOT NULL, received_at TEXT NOT NULL)`);
  return {
    close() { db.close(); },
    async fetch(request: Request): Promise<Response> {
      const url = new URL(request.url);
      if (request.method === "GET" && url.pathname === "/health/ready") {
        return Response.json({ status: "ok", profile: "private-poc", independent: false });
      }
      if (url.pathname !== "/poc/monitor-alerts" || url.search) return new Response(null, { status: 404 });
      if (request.method !== "POST") return new Response(null, { status: 405 });
      const bytes = new Uint8Array(await request.arrayBuffer());
      if (bytes.length > 16_384) return new Response(null, { status: 413 });
      try {
        if (request.headers.get("X-Hail-Monitor-Key") !== monitorDidKey) throw new Error("Unknown signer");
        const signature = decodeBase64Url(request.headers.get("X-Hail-Monitor-Signature") ?? "");
        if (signature.length !== 64 || !verify(null, Buffer.concat([
          Buffer.from("hail.plc-monitor-alert.v1\0"), Buffer.from(bytes),
        ]), key, signature)) throw new Error("Invalid signature");
      } catch { return new Response(null, { status: 401 }); }
      let id: string;
      try {
        const alert = parseJsonWithoutDuplicateKeys(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as
          { type?: string; version?: number; id?: string; did?: string; category?: string };
        if (alert.type !== "hail.plc-monitor-alert" || alert.version !== 1 ||
          typeof alert.id !== "string" || !/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/.test(alert.id) ||
          typeof alert.did !== "string" || !/^did:plc:[a-z2-7]{24}$/.test(alert.did) ||
          !["unexpected-operation", "coverage-lost", "export-gap", "invalid-operation-log"].includes(alert.category ?? "")) {
          throw new Error("Invalid alert");
        }
        id = alert.id;
      } catch { return new Response(null, { status: 400 }); }
      db.query("INSERT OR IGNORE INTO alert_receipts VALUES (?, ?, ?)").run(id, bytes, new Date().toISOString());
      const saved = db.query("SELECT payload FROM alert_receipts WHERE id = ?").get(id) as { payload: Uint8Array };
      return new Response(null, { status: Buffer.from(saved.payload).equals(Buffer.from(bytes)) ? 204 : 409 });
    },
  };
}

if (import.meta.main) {
  if (!Bun.env.POC_RECEIPT_DATABASE || !Bun.env.MONITOR_PUBLIC_DID_KEY) throw new Error("Set POC receiver environment");
  const receiver = createPocAlertReceiver(Bun.env.POC_RECEIPT_DATABASE, Bun.env.MONITOR_PUBLIC_DID_KEY);
  Bun.serve({ port: 3000, maxRequestBodySize: 16_384, fetch: receiver.fetch });
  console.info(JSON.stringify({ event: "poc-alert-receiver-started", profile: "private-poc", independent: false }));
}
