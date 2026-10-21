import { open, unlink } from "node:fs/promises";
import { encodeBase64Url } from "@hailproto/codec";
import { loadConfig } from "../config.js";
import { ProviderDatabase } from "../db/database.js";
import { KeyEncryptor } from "../identity/key-encryption.js";
import { MigrationFenceService } from "../migration/fence.js";
import { MigrationTransferService, validateTransferManifest } from "../migration/transfer.js";
import { OnboardingRepository } from "../onboarding/repository.js";
import { createHailDidResolver } from "../plc/public-resolver.js";

const [did, transferId, outputFile] = Bun.argv.slice(2);
if (!did || !transferId || !outputFile || Bun.argv.length !== 5) {
  throw new Error("Usage: bun run migration:export -- <fenced-did> <transfer-id> <private-output-file>");
}
const config = loadConfig();
const database = new ProviderDatabase(config.databaseUrl);
try {
  await database.migrate();
  const resolver = createHailDidResolver(config,database.sql);
  const fence = await new MigrationFenceService(database.sql, resolver, config.hailServiceBase).get(did);
  if (!fence || fence.transferId !== transferId) throw new Error("Matching migration fence was not found");
  const snapshot = await new MigrationTransferService(database.sql, new OnboardingRepository(database.sql),
    new KeyEncryptor(config.keyEncryptionKey), resolver, config.hailServiceBase).exportFenced(fence);
  const result = JSON.stringify({ type: "hail.portable-migration-transfer", version: validateTransferManifest(snapshot.bytes).version,
    manifest: encodeBase64Url(snapshot.bytes), digest: encodeBase64Url(snapshot.digest),
    signature: encodeBase64Url(snapshot.signature), sourceMessagingPublicKey: snapshot.sourceMessagingPublicKey });
  const file = await open(outputFile, "wx", 0o600);
  let incomplete = false;
  try { await file.writeFile(result); }
  catch (error) { incomplete = true; throw error; }
  finally { await file.close(); if (incomplete) await unlink(outputFile); }
  console.info(JSON.stringify({ did, transferId, digest: encodeBase64Url(snapshot.digest),
    bytes: snapshot.bytes.length, state: "exported" }));
} finally { await database.close(); }
