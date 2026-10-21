import { MonitorDatabase } from "../database.js";
import { PlcMonitor } from "../monitor.js";
import { BoundedMonitorPlcClient } from "../plc.js";
import { MonitorSigner } from "../signing.js";
import { def } from "@did-plc/lib";
import { parseJsonWithoutDuplicateKeys } from "../strict-json.js";

const [did, expectedCid, alertUrl, statePath] = Bun.argv.slice(2);
if (!did || !expectedCid || !alertUrl || ![5, 6].includes(Bun.argv.length) ||
  !Bun.env.DATABASE_URL || !Bun.env.PLC_DIRECTORY_URL || !Bun.env.MONITOR_PRIVATE_KEY_FILE) {
  throw new Error("Usage: bun run monitor:enroll -- <did> <expected-operation-cid> <https-user-alert-webhook> [reviewed-plc-data.json]; set monitor environment");
}
if (new URL(Bun.env.PLC_DIRECTORY_URL).protocol === "https:" && !statePath) throw new Error("Public monitor enrollment requires an owner-reviewed full-state checkpoint file");
const file = statePath ? Bun.file(statePath) : undefined;
if (file && (file.size < 1 || file.size > 1_048_576)) throw new Error("Reviewed PLC state file must be bounded at 1 MiB");
const reviewed = file ? def.documentData.strict().parse(parseJsonWithoutDuplicateKeys(await file.text())) : undefined;
const signer = await MonitorSigner.fromPrivateFile(Bun.env.MONITOR_PRIVATE_KEY_FILE);
const database = new MonitorDatabase(Bun.env.DATABASE_URL);
try {
  await database.migrate();
  await new PlcMonitor(database.sql, new BoundedMonitorPlcClient(Bun.env.PLC_DIRECTORY_URL))
    .enroll(did, expectedCid, alertUrl, reviewed);
  console.info(JSON.stringify({ did, expectedCid, monitorPublicKey: signer.publicDidKey, state: "enrolled",
    bootstrap: reviewed ? "reviewed-state-full-backfill-required" : "private-poc-unreviewed-state" }));
} finally { await database.close(); }
