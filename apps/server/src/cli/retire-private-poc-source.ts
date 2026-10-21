import { loadConfig } from "../config.js";
import { ProviderDatabase } from "../db/database.js";
import { MigrationFenceService } from "../migration/fence.js";
import { createPlcDirectoryClient } from "../plc/client.js";
import { PlcHailDidResolver } from "../plc/resolver.js";
import { readTransferRecord } from "./transfer-record.js";
import { assertPrivatePocRegistry } from "../migration/poc-profile.js";

const [did, transferId, receiptFile] = Bun.argv.slice(2);
if (!did || !transferId || !receiptFile || Bun.argv.length !== 5) {
  throw new Error("Usage: bun run poc:retire-source -- <old-provider-did> <transfer-id> <signed-activation-receipt-file>");
}
const config = loadConfig();
assertPrivatePocRegistry(config.plcDirectoryUrl, config.hailServiceBase);
const database = new ProviderDatabase(config.databaseUrl);
try {
  await database.migrate();
  await new MigrationFenceService(database.sql,
    new PlcHailDidResolver(createPlcDirectoryClient(config.plcDirectoryUrl)),
    config.hailServiceBase).retire(did, transferId, await readTransferRecord(receiptFile));
  console.info(JSON.stringify({ did, transferId, state: "retired", profile: "private-poc" }));
} finally { await database.close(); }
