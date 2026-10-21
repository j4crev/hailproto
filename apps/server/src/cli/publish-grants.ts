import { loadConfig } from "../config.js";
import { ProviderDatabase } from "../db/database.js";
import {withFreshServingGenerations} from "../db/serving.js";
import { SafeHttpsTransport } from "../discovery/safe-fetch.js";
import { GrantPublisher } from "../grants/publisher.js";
import { GrantRepository } from "../grants/repository.js";
import { createHailDidResolver } from "../plc/public-resolver.js";

if (Bun.argv[2] !== undefined && Bun.argv[2] !== "--once") {
  throw new Error("Usage: bun run grant:publish -- [--once]");
}
const config = loadConfig();
const database = new ProviderDatabase(config.databaseUrl);
try {
  await database.migrate();
  const transport = new SafeHttpsTransport();
  const outcome = await withFreshServingGenerations(database.sql,()=>new GrantPublisher(
    new GrantRepository(database.sql),
    createHailDidResolver(config,database.sql),
    transport.fetch,
    transport.validateTarget,
  ).publishOne());
  console.info(JSON.stringify({ outcome }));
} finally {
  await database.close();
}
