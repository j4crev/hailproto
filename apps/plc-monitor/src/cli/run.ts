import { MonitorDatabase } from "../database.js";
import { PlcMonitor } from "../monitor.js";
import { MonitorNotifier, PinnedHttpsAlertTransport } from "../notifier.js";
import { BoundedMonitorPlcClient } from "../plc.js";
import { MonitorSigner } from "../signing.js";

if (!Bun.env.DATABASE_URL || !Bun.env.PLC_DIRECTORY_URL || !Bun.env.MONITOR_PRIVATE_KEY_FILE) {
  throw new Error("DATABASE_URL, PLC_DIRECTORY_URL and MONITOR_PRIVATE_KEY_FILE are required");
}
const database = new MonitorDatabase(Bun.env.DATABASE_URL);
await database.migrate();
const signer = await MonitorSigner.fromPrivateFile(Bun.env.MONITOR_PRIVATE_KEY_FILE);
const monitor = new PlcMonitor(database.sql, new BoundedMonitorPlcClient(Bun.env.PLC_DIRECTORY_URL));
const notifier = new MonitorNotifier(database.sql, signer, new PinnedHttpsAlertTransport());
console.info(JSON.stringify({ event: "monitor-started", monitorDidKey: signer.publicDidKey,
  deploymentProfile: Bun.env.MONITOR_DEPLOYMENT_PROFILE ?? "unspecified" }));

let polling = false;
let notifying = false;
async function poll() {
  if (polling) return;
  polling = true;
  try {
    const result = await monitor.poll();
    if (result.state !== "current" || result.alerts) console.info(JSON.stringify({ event: "monitor-poll", ...result }));
  } catch (error) {
    console.error(JSON.stringify({ event: "monitor-poll-error", error: error instanceof Error ? error.message : "unknown" }));
  } finally { polling = false; }
}
async function notify() {
  if (notifying) return;
  notifying = true;
  try {
    const outcome = await notifier.sendOne();
    if (outcome !== "idle") console.info(JSON.stringify({ event: "monitor-notify", outcome }));
  } catch (error) {
    console.error(JSON.stringify({ event: "monitor-notify-error", error: error instanceof Error ? error.message : "unknown" }));
  } finally { notifying = false; }
}
await poll();
await notify();
setInterval(() => { void poll(); }, 240_000);
setInterval(() => { void notify(); }, 5_000);
