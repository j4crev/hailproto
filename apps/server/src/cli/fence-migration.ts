import { loadConfig } from "../config.js";
import { ProviderDatabase } from "../db/database.js";
import { MigrationFenceService } from "../migration/fence.js";
import { createHailDidResolver } from "../plc/public-resolver.js";
import { readTransferRecord } from "./transfer-record.js";

const [requestFile, selectionFile, reservationFile] = Bun.argv.slice(2);
if (!requestFile || !selectionFile || !reservationFile || Bun.argv.length !== 5) {
  throw new Error("Usage: bun run migration:fence -- <signed-request-file> <user-signed-selection-file> <target-signed-reservation-file>");
}
const config = loadConfig();
const database = new ProviderDatabase(config.databaseUrl);
try {
  await database.migrate();
  const fence = await new MigrationFenceService(database.sql,
    createHailDidResolver(config,database.sql),
    config.hailServiceBase).begin(await readTransferRecord(requestFile),
      await readTransferRecord(selectionFile), await readTransferRecord(reservationFile));
  console.info(JSON.stringify({ did: fence.did, transferId: fence.transferId,
    destination: fence.destinationServiceBase, state: fence.state }));
} finally { await database.close(); }
