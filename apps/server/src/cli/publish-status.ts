import { loadConfig } from "../config.js";
import { ProviderDatabase } from "../db/database.js";
import {withFreshServingGenerations} from "../db/serving.js";
import { DeliveryStatusSigner } from "../delivery/status.js";
import { TerminalStatusPublisher } from "../delivery/status-publisher.js";
import { SafeHttpsTransport } from "../discovery/safe-fetch.js";
import { KeyEncryptor } from "../identity/key-encryption.js";
import { OnboardingRepository } from "../onboarding/repository.js";
import { createHailDidResolver } from "../plc/public-resolver.js";

const config = loadConfig();
const database = new ProviderDatabase(config.databaseUrl);
try {
  await database.migrate();
  const transport = new SafeHttpsTransport();
  const resolver = createHailDidResolver(config,database.sql);
  const signer = new DeliveryStatusSigner(database.sql, new OnboardingRepository(database.sql),
    new KeyEncryptor(config.keyEncryptionKey), resolver, config.hailServiceBase);
  const result = await withFreshServingGenerations(database.sql,()=>new TerminalStatusPublisher(database.sql, signer, resolver,
    transport.fetch, transport.validateTarget).publishOne());
  console.info(JSON.stringify({ outcome: result }));
} finally { await database.close(); }
