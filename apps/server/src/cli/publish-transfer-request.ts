import { loadConfig } from "../config.js";
import { ProviderDatabase } from "../db/database.js";
import { SafeHttpsTransport } from "../discovery/safe-fetch.js";
import { KeyEncryptor } from "../identity/key-encryption.js";
import { TransferFinalRequestPublisher } from "../migration/final-request-publisher.js";
import { PreparedMigrationTarget } from "../migration/target-keys.js";
import { createHailDidResolver } from "../plc/public-resolver.js";

const transferId = Bun.argv[2];
if (!transferId || Bun.argv.length !== 3) {
  throw new Error("Usage: bun run migration:publish-final -- <prepared-transfer-id>");
}
const config = loadConfig();
const database = new ProviderDatabase(config.databaseUrl);
try {
  await database.migrate();
  const transport = new SafeHttpsTransport();
  await new TransferFinalRequestPublisher(database.sql,
    createHailDidResolver(config,database.sql),
    new PreparedMigrationTarget(database.sql, new KeyEncryptor(config.keyEncryptionKey), config.hailServiceBase),
    transport.fetch, transport.validateTarget).publish(transferId);
  console.info(JSON.stringify({ transferId, acknowledged: true }));
} finally { await database.close(); }
