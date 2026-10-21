import { lookup as dnsLookup } from "node:dns/promises";
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";
import ipaddr from "ipaddr.js";
import type { SQL } from "bun";
import { encodeBase64Url } from "@hailproto/codec";
import { assertWebhookUrl } from "./monitor.js";
import type { MonitorSigner } from "./signing.js";

export interface AlertTransport {
  send(url: string, bytes: Uint8Array, signature: Uint8Array, signer: string): Promise<number>;
}

type DnsResolver = (hostname: string, options: { all: true; verbatim: true }) =>
  Promise<readonly { address: string; family: number }[]>;

export function publicAddress(value: string): boolean {
  let parsed: ipaddr.IPv4 | ipaddr.IPv6;
  try { parsed = ipaddr.parse(value); } catch { return false; }
  if (parsed.kind() === "ipv6") {
    const ipv6 = parsed as ipaddr.IPv6;
    if (ipv6.isIPv4MappedAddress()) parsed = ipv6.toIPv4Address();
    else if (!ipv6.match(ipaddr.parse("2000::"), 3)) return false;
  }
  return parsed.range() === "unicast";
}

export class PinnedHttpsAlertTransport implements AlertTransport {
  constructor(private readonly resolve: DnsResolver = dnsLookup) {}

  async send(rawUrl: string, bytes: Uint8Array, signature: Uint8Array, signer: string): Promise<number> {
    const url = assertWebhookUrl(rawUrl);
    let timeout!: ReturnType<typeof setTimeout>;
    const addresses = await Promise.race([
      this.resolve(url.hostname, { all: true, verbatim: true }),
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error("Alert DNS lookup timed out")), 5000);
      }),
    ]).finally(() => clearTimeout(timeout));
    if (!addresses.length || addresses.some((address) => !publicAddress(address.address) ||
      (address.family !== 4 && address.family !== 6) || isIP(address.address) !== address.family)) {
      throw new Error("Alert webhook DNS is not exclusively public");
    }
    const selected = addresses[0]!;
    return new Promise<number>((resolve, reject) => {
      const outgoing = httpsRequest({ protocol: "https:", hostname: url.hostname,
        port: url.port ? Number(url.port) : 443, method: "POST", path: url.pathname,
        servername: url.hostname, agent: false, family: selected.family,
        lookup: (_host, _opts, callback) => callback(null, selected.address, selected.family),
        headers: { "Content-Type": "application/json", "Content-Length": String(bytes.length),
          "X-Hail-Monitor-Key": signer, "X-Hail-Monitor-Signature": encodeBase64Url(signature) },
      }, (response) => {
        let length = 0;
        response.on("data", (chunk: Buffer) => {
          length += chunk.length;
          if (length > 4096) outgoing.destroy(new Error("Alert response exceeds its limit"));
        });
        response.on("end", () => { clearTimeout(timer); resolve(response.statusCode ?? 500); });
        response.on("error", reject);
      });
      const timer = setTimeout(() => outgoing.destroy(new Error("Alert webhook timed out")), 10_000);
      outgoing.on("error", (error) => { clearTimeout(timer); reject(error); });
      outgoing.end(bytes);
    });
  }
}

interface AlertRow {
  id: string;
  did: string;
  category: string;
  detail: unknown;
  created_at: Date;
  alert_webhook_url: string;
  attempt_count: number;
}

export class MonitorNotifier {
  constructor(private readonly sql: SQL, private readonly signer: MonitorSigner,
    private readonly transport: AlertTransport,
    private readonly now: () => Date = () => new Date()) {}

  async sendOne(): Promise<"idle" | "sent" | "retry"> {
    const token = crypto.randomUUID();
    const claim = await this.sql.begin(async (tx) => {
      const rows = await tx<AlertRow[]>`
        SELECT alert.id, alert.did, alert.category, alert.detail, alert.created_at,
          account.alert_webhook_url, alert.attempt_count
        FROM monitor_alerts alert JOIN monitored_dids account ON account.did = alert.did
        WHERE alert.sent_at IS NULL AND alert.next_attempt_at <= now()
          AND (alert.lease_expires_at IS NULL OR alert.lease_expires_at <= now())
        ORDER BY alert.next_attempt_at FOR UPDATE OF alert SKIP LOCKED LIMIT 1
      `;
      if (!rows[0]) return null;
      await tx`UPDATE monitor_alerts SET lease_token = ${token},
        lease_expires_at = now() + interval '30 seconds', attempt_count = attempt_count + 1
        WHERE id = ${rows[0].id}`;
      return rows[0];
    });
    if (!claim) return "idle";
    const detail = typeof claim.detail === "string" ? JSON.parse(claim.detail) as unknown : claim.detail;
    const payload = JSON.stringify({ type: "hail.plc-monitor-alert", version: 1, id: claim.id,
      did: claim.did, category: claim.category, detail,
      occurred_at: claim.created_at.toISOString() });
    const bytes = new TextEncoder().encode(payload);
    try {
      const status = await this.transport.send(claim.alert_webhook_url, bytes,
        this.signer.signAlert(bytes), this.signer.publicDidKey);
      if (status >= 200 && status < 300) {
        await this.sql`UPDATE monitor_alerts SET sent_at = ${this.now()}, lease_token = NULL,
          lease_expires_at = NULL WHERE id = ${claim.id} AND lease_token = ${token}`;
        return "sent";
      }
    } catch { /* Persist responsibility and retry on network failure. */ }
    const delay = Math.min(3600, 30 * 2 ** Math.min(claim.attempt_count, 7));
    await this.sql`UPDATE monitor_alerts SET next_attempt_at = ${new Date(this.now().getTime() + delay * 1000)},
      lease_token = NULL, lease_expires_at = NULL WHERE id = ${claim.id} AND lease_token = ${token}`;
    return "retry";
  }
}
