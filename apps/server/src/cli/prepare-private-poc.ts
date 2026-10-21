import { open, unlink } from "node:fs/promises";
import { loadConfig } from "../config.js";
import { ProviderDatabase } from "../db/database.js";
import { KeyEncryptor } from "../identity/key-encryption.js";
import { PrivatePocOnboarding } from "../onboarding/private-poc.js";
import { createPlcDirectoryClient } from "../plc/client.js";

const [address, userRecoveryKey, userIdentityKey, outputPath, confirmation] = Bun.argv.slice(2);
if (!address || !userRecoveryKey || !userIdentityKey || !outputPath || confirmation !== "--backup-verified" ||
  Bun.argv.length !== 7) {
  throw new Error("Usage: bun run poc:prepare-portable -- <new-address> <user-recovery-did-key> <user-identity-did-key> <new-private-preparation-file> --backup-verified");
}
const config = loadConfig();
const database = new ProviderDatabase(config.databaseUrl);
try {
  await database.migrate();
  const prepared = await new PrivatePocOnboarding(database.sql,
    createPlcDirectoryClient(config.plcDirectoryUrl), new KeyEncryptor(config.keyEncryptionKey),
    config.plcDirectoryUrl, config.hailServiceBase).prepare(address,
      userRecoveryKey, userIdentityKey, true);
  const file = await open(outputPath, "wx", 0o600);
  let incomplete = false;
  try { await file.writeFile(JSON.stringify(prepared)); }
  catch (error) { incomplete = true; throw error; }
  finally { await file.close(); if (incomplete) await unlink(outputPath); }
  console.info(JSON.stringify({ accountId: prepared.accountId, address: prepared.address,
    preparationFile: outputPath, profile: "private-poc" }));
} finally { await database.close(); }
