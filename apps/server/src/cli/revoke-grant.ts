import { encodeBase64Url } from "@hailproto/codec";
import { loadConfig } from "../config.js";
import { ProviderDatabase } from "../db/database.js";
import { GrantRepository } from "../grants/repository.js";
import { GrantService } from "../grants/service.js";
import { KeyEncryptor } from "../identity/key-encryption.js";
import { OnboardingRepository } from "../onboarding/repository.js";
import { createHailDidResolver } from "../plc/public-resolver.js";

const grantorAddress = Bun.argv[2];
const grantId = Bun.argv[3];
if (!grantorAddress || !grantId) {
  throw new Error("Usage: bun run grant:revoke -- <grantor-address> <grant-id>");
}
const config = loadConfig();
const database = new ProviderDatabase(config.databaseUrl);

try {
  await database.migrate();
  const accounts = new OnboardingRepository(database.sql);
  const grant = await new GrantService(
    accounts,
    new GrantRepository(database.sql),
    new KeyEncryptor(config.keyEncryptionKey),
    createHailDidResolver(config,database.sql),
    { verify: async () => Promise.reject(new Error("Address verification is not used for revocation")) },
    { verify: async () => Promise.reject(new Error("Profile verification is not used for revocation")) },
    config.hailServiceBase,
  ).revoke(grantorAddress, grantId);
  console.info(
    JSON.stringify(
      {
        grantId: grant.payload.grant_id,
        revision: grant.payload.revision,
        status: grant.payload.status,
        digest: encodeBase64Url(grant.digest),
      },
      null,
      2,
    ),
  );
} finally {
  await database.close();
}
