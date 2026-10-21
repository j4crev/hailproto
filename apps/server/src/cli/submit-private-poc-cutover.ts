import { loadConfig } from "../config.js";
import { ProviderDatabase } from "../db/database.js";
import { PrivatePocPlcSubmission } from "../migration/poc-plc-submission.js";
import { createPlcDirectoryClient } from "../plc/client.js";

const transferId = Bun.argv[2];
if (!transferId || Bun.argv.length !== 3) {
  throw new Error("Usage: bun run poc:submit-cutover -- <staged-transfer-id>");
}
const config = loadConfig();
const database = new ProviderDatabase(config.databaseUrl);
try {
  await database.migrate();
  const cid = await new PrivatePocPlcSubmission(database.sql,
    createPlcDirectoryClient(config.plcDirectoryUrl), config.plcDirectoryUrl,
    config.hailServiceBase).submit(transferId);
  console.info(JSON.stringify({ transferId, cid, profile: "private-poc" }));
} finally { await database.close(); }
