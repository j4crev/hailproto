import { loadConfig } from "../config.js";
import { ProviderDatabase } from "../db/database.js";
import { KeyEncryptor } from "../identity/key-encryption.js";
import { PreparedMigrationTarget } from "../migration/target-keys.js";

const did = Bun.argv[2];
if (!did || Bun.argv.length !== 3) {
  throw new Error("Usage: bun run migration:prepare-target -- <migrating-did>");
}
const config = loadConfig();
const database = new ProviderDatabase(config.databaseUrl);
try {
  await database.migrate();
  const result = await new PreparedMigrationTarget(database.sql,
    new KeyEncryptor(config.keyEncryptionKey), config.hailServiceBase).prepare(did);
  console.info(JSON.stringify(result, null, 2));
} finally { await database.close(); }
