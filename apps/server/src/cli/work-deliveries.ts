import { loadConfig } from "../config.js";
import { ProviderDatabase } from "../db/database.js";
import {withFreshServingGenerations} from "../db/serving.js";
import { DeliveryRepository } from "../delivery/repository.js";
import { BodyRetriever } from "../delivery/retriever.js";
import { DeliveryWorker } from "../delivery/worker.js";
import { SafeHttpsTransport } from "../discovery/safe-fetch.js";
import { createHailDidResolver } from "../plc/public-resolver.js";

const config = loadConfig();
const database = new ProviderDatabase(config.databaseUrl);
try {
  await database.migrate();
  const transport = new SafeHttpsTransport();
  const worker = new DeliveryWorker(new DeliveryRepository(database.sql),
    new BodyRetriever(createHailDidResolver(config,database.sql),
      transport.fetchBody, transport.validateTarget));
  const outcome = await withFreshServingGenerations(database.sql,()=>worker.processOne());
  console.info(JSON.stringify({ outcome }));
} finally { await database.close(); }
