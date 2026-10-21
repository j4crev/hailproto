import { encodeBase64Url, type HailGrantScope } from "@hailproto/codec";
import { loadConfig } from "../config.js";
import { ProviderDatabase } from "../db/database.js";
import { SafeHttpsTransport } from "../discovery/safe-fetch.js";
import { parseJsonWithoutDuplicateKeys } from "../discovery/strict-json.js";
import { AddressVerifier } from "../discovery/verifier.js";
import { GrantRepository } from "../grants/repository.js";
import { GrantService, type GrantDefinition } from "../grants/service.js";
import { KeyEncryptor } from "../identity/key-encryption.js";
import { OnboardingRepository } from "../onboarding/repository.js";
import { createPlcDirectoryClient } from "../plc/client.js";
import { createHailDidResolver } from "../plc/public-resolver.js";
import { SenderProfileVerifier } from "../profiles/verifier.js";

function definition(value: unknown): GrantDefinition {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Grant definition must be an object");
  }
  const record = value as Record<string, unknown>;
  if (
    Object.keys(record).some((key) => !["scope", "expires_at"].includes(key)) ||
    !("scope" in record) ||
    !("expires_at" in record)
  ) {
    throw new Error("Grant definition must contain only scope and expires_at");
  }
  const rawScope = record.scope;
  if (!rawScope || typeof rawScope !== "object" || Array.isArray(rawScope)) {
    throw new Error("Grant scope must be an object");
  }
  const scopeRecord = rawScope as Record<string, unknown>;
  let scope: HailGrantScope;
  if (scopeRecord.type === "uncategorized" && Object.keys(scopeRecord).length === 1) {
    scope = { type: "uncategorized" };
  } else if (
    scopeRecord.type === "categories" &&
    Object.keys(scopeRecord).every((key) => ["type", "values"].includes(key)) &&
    Object.keys(scopeRecord).length === 2 &&
    Array.isArray(scopeRecord.values) &&
    scopeRecord.values.every((entry) => typeof entry === "string")
  ) {
    scope = { type: "categories", values: scopeRecord.values };
  } else {
    throw new Error("Grant scope is invalid");
  }
  if (
    record.expires_at !== null &&
    (typeof record.expires_at !== "number" || !Number.isSafeInteger(record.expires_at))
  ) {
    throw new Error("Grant expires_at must be null or a safe integer");
  }
  return { scope, expiresAt: record.expires_at as number | null };
}

const grantorAddress = Bun.argv[2];
const granteeAddress = Bun.argv[3];
const definitionPath = Bun.argv[4];
if (!grantorAddress || !granteeAddress || !definitionPath) {
  throw new Error(
    "Usage: bun run grant:create -- <grantor-address> <grantee-address> <grant-definition.json>",
  );
}
const input = definition(parseJsonWithoutDuplicateKeys(await Bun.file(definitionPath).text()));
const config = loadConfig();
const database = new ProviderDatabase(config.databaseUrl);

try {
  await database.migrate();
  const plc = createPlcDirectoryClient(config.plcDirectoryUrl);
  const resolver = createHailDidResolver(config,database.sql);
  const transport = new SafeHttpsTransport();
  const accounts = new OnboardingRepository(database.sql);
  const grant = await new GrantService(
    accounts,
    new GrantRepository(database.sql),
    new KeyEncryptor(config.keyEncryptionKey),
    resolver,
    new AddressVerifier(plc, transport.fetch, transport.validateTarget,undefined,resolver),
    new SenderProfileVerifier(
      resolver,
      transport.fetch,
      transport.validateTarget,
      undefined,
      accounts,
    ),
    config.hailServiceBase,
  ).createOrReuse(grantorAddress, granteeAddress, input);
  console.info(
    JSON.stringify(
      {
        grantId: grant.payload.grant_id,
        revision: grant.payload.revision,
        status: grant.payload.status,
        grantor: grant.payload.grantor,
        grantee: grant.payload.grantee,
        scope: grant.payload.scope,
        digest: encodeBase64Url(grant.digest),
      },
      null,
      2,
    ),
  );
} finally {
  await database.close();
}
