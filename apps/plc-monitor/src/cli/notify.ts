import { MonitorDatabase } from "../database.js";
import { MonitorNotifier, PinnedHttpsAlertTransport } from "../notifier.js";
import { MonitorSigner } from "../signing.js";

if (!Bun.env.DATABASE_URL || !Bun.env.MONITOR_PRIVATE_KEY_FILE) {
  throw new Error("DATABASE_URL and MONITOR_PRIVATE_KEY_FILE are required");
}
const signer = await MonitorSigner.fromPrivateFile(Bun.env.MONITOR_PRIVATE_KEY_FILE);
const database = new MonitorDatabase(Bun.env.DATABASE_URL);
try {
  await database.migrate();
  const result = await new MonitorNotifier(database.sql, signer, new PinnedHttpsAlertTransport()).sendOne();
  console.info(JSON.stringify({ outcome: result }));
} finally { await database.close(); }
