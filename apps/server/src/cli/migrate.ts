import { loadConfig } from "../config.js";
import { ProviderDatabase } from "../db/database.js";

const config = loadConfig();
const database = new ProviderDatabase(config.databaseUrl);

try {
  await database.migrate();
  console.info("Provider database migrations are current");
} finally {
  await database.close();
}
