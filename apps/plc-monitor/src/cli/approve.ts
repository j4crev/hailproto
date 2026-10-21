import { stat } from "node:fs/promises";
import { def } from "@did-plc/lib";
import { MonitorDatabase } from "../database.js";
import { PlcMonitor } from "../monitor.js";
import { BoundedMonitorPlcClient } from "../plc.js";
import { parseJsonWithoutDuplicateKeys } from "../strict-json.js";

const [did, cid, stateFile] = Bun.argv.slice(2);
if (!did || !cid || !stateFile || Bun.argv.length !== 5 ||
  !Bun.env.DATABASE_URL || !Bun.env.PLC_DIRECTORY_URL) {
  throw new Error("Usage: bun run monitor:approve -- <did> <reviewed-operation-cid> <complete-reviewed-plc-state.json>");
}
const metadata = await stat(stateFile);
if (!metadata.isFile() || metadata.size < 1 || metadata.size > 1_048_576) {
  throw new Error("Reviewed PLC state must be a bounded regular JSON file");
}
const reviewed = def.documentData.parse(parseJsonWithoutDuplicateKeys(await Bun.file(stateFile).text()));
if (reviewed.did !== did) throw new Error("Reviewed PLC state names another DID");
const database = new MonitorDatabase(Bun.env.DATABASE_URL);
try {
  await database.migrate();
  await new PlcMonitor(database.sql, new BoundedMonitorPlcClient(Bun.env.PLC_DIRECTORY_URL))
    .approveExpected(did, cid, reviewed);
  console.info(JSON.stringify({ did, expectedCid: cid, approved: true }));
} finally { await database.close(); }
