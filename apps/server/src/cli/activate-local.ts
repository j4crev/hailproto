import { createApp } from "../app.js";
import { loadConfig } from "../config.js";
import { ProviderDatabase } from "../db/database.js";
import { AddressVerifier } from "../discovery/verifier.js";
import { canonicalizeHailAddress } from "../identity/address.js";
import { ActivationService } from "../onboarding/activation.js";
import { OnboardingRepository } from "../onboarding/repository.js";
import { createPlcDirectoryClient } from "../plc/client.js";

const address = Bun.argv[2];
if (!address) {
  throw new Error("Usage: bun run activate:local -- <hail-address>");
}

const config = loadConfig();
if (config.publicPlcAuthority) throw new Error("Local prototype activation cannot use strict public authority");
const database = new ProviderDatabase(config.databaseUrl);

try {
  await database.migrate();
  const plc = createPlcDirectoryClient(config.plcDirectoryUrl);
  const repository = new OnboardingRepository(database.sql);
  const app = createApp(config, {
    discoveryStore: repository,
    async checkReadiness() {
      await Promise.all([database.ping(), plc.health()]);
      return { ready: true };
    },
  });
  const verifier = new AddressVerifier(
    plc,
    async (request) => app.fetch(request),
    (url) => {
      if (url.origin !== config.publicOrigin) {
        throw new Error("Local activation only permits the configured public origin");
      }
    },
  );
  const account = await repository.getAccountByAddress(canonicalizeHailAddress(address));
  await new ActivationService(repository, verifier, config.hailServiceBase, "local").activate(
    account.id,
  );
  console.info(JSON.stringify(await repository.getAccount(account.id), null, 2));
} finally {
  await database.close();
}
