import { encodeBase64Url } from "@hailproto/codec";
import { loadConfig } from "../config.js";
import { ProviderDatabase } from "../db/database.js";
import { parseJsonWithoutDuplicateKeys } from "../discovery/strict-json.js";
import { KeyEncryptor } from "../identity/key-encryption.js";
import { OnboardingRepository } from "../onboarding/repository.js";
import { createHailDidResolver } from "../plc/public-resolver.js";
import {
  parseSenderProfileDefinition,
  SenderProfileService,
} from "../profiles/service.js";

const address = Bun.argv[2];
const definitionPath = Bun.argv[3];
if (!address || !definitionPath) {
  throw new Error("Usage: bun run profile:create -- <hail-address> <profile-definition.json>");
}
const definition = parseSenderProfileDefinition(
  parseJsonWithoutDuplicateKeys(await Bun.file(definitionPath).text()),
);
const config = loadConfig();
const database = new ProviderDatabase(config.databaseUrl);

try {
  await database.migrate();
  const repository = new OnboardingRepository(database.sql);
  const profile = await new SenderProfileService(
    repository,
    new KeyEncryptor(config.keyEncryptionKey),
    createHailDidResolver(config,database.sql),
    config.hailServiceBase,
  ).createOrReuse(address, definition);
  console.info(
    JSON.stringify(
      {
        did: profile.did,
        revision: profile.revision,
        digest: encodeBase64Url(profile.digest),
        displayName: profile.payload.display_name,
        categories: profile.payload.categories.map((category) => category.id),
      },
      null,
      2,
    ),
  );
} finally {
  await database.close();
}
