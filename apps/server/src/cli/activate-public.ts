import { loadConfig } from "../config.js";
import { ProviderDatabase } from "../db/database.js";
import { SafeHttpsTransport } from "../discovery/safe-fetch.js";
import { AddressVerifier } from "../discovery/verifier.js";
import { canonicalizeHailAddress } from "../identity/address.js";
import { ActivationService } from "../onboarding/activation.js";
import { OnboardingRepository } from "../onboarding/repository.js";
import { createPlcDirectoryClient } from "../plc/client.js";

const address = Bun.argv[2];
if (!address) {
  throw new Error("Usage: bun run activate:public -- <hail-address>");
}

const config = loadConfig();
if (config.publicPlcAuthority) throw new Error("Strict public activation requires the owner-key/monitor ceremony; prototype activation cannot supply it");
if (config.nodeEnv !== "production") {
  throw new Error("Public activation requires NODE_ENV=production");
}
const database = new ProviderDatabase(config.databaseUrl);

try {
  await database.migrate();
  const plc = createPlcDirectoryClient(config.plcDirectoryUrl);
  const repository = new OnboardingRepository(database.sql);
  const transport = new SafeHttpsTransport();
  const verifier = new AddressVerifier(plc, transport.fetch, transport.validateTarget);
  const account = await repository.getAccountByAddress(canonicalizeHailAddress(address));
  await new ActivationService(repository, verifier, config.hailServiceBase, "public").activate(
    account.id,
  );
  console.info(JSON.stringify(await repository.getAccount(account.id), null, 2));
} finally {
  await database.close();
}
