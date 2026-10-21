import { readFile, stat } from "node:fs/promises";
import { decodeBase64Url } from "@hailproto/codec";
import { loadConfig } from "../config.js";
import { ProviderDatabase } from "../db/database.js";
import { KeyEncryptor } from "../identity/key-encryption.js";
import { PrivatePocOnboarding } from "../onboarding/private-poc.js";
import { createPlcDirectoryClient } from "../plc/client.js";

const path = Bun.argv[2];
if (!path || Bun.argv.length !== 3) {
  throw new Error("Usage: bun run poc:register-portable -- <private-client-signed-onboarding-file>");
}
const info = await stat(path);
if (!info.isFile() || info.size < 1 || info.size > 32_768 || (info.mode & 0o077) !== 0) {
  throw new Error("POC onboarding ceremony file must be a bounded mode-0600 regular file");
}
const data: unknown = JSON.parse(await readFile(path, "utf8"));
if (!data || typeof data !== "object" || !("accountId" in data) || !("operation" in data) ||
  !("bindingCose" in data) || typeof data.accountId !== "string" ||
  typeof data.bindingCose !== "string") throw new Error("Invalid signed POC onboarding ceremony");
const config = loadConfig();
const database = new ProviderDatabase(config.databaseUrl);
try {
  await database.migrate();
  const result = await new PrivatePocOnboarding(database.sql,
    createPlcDirectoryClient(config.plcDirectoryUrl), new KeyEncryptor(config.keyEncryptionKey),
    config.plcDirectoryUrl, config.hailServiceBase).register(data.accountId,
      new TextEncoder().encode(JSON.stringify(data.operation)), decodeBase64Url(data.bindingCose));
  console.info(JSON.stringify({ ...result, accountId: data.accountId, profile: "private-poc" }));
} finally { await database.close(); }
