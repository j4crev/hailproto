import { stat } from "node:fs/promises";
import { decodeBase64Url, encodeBase64Url } from "@hailproto/codec";
import { loadConfig } from "../config.js";
import { ProviderDatabase } from "../db/database.js";
import { parseJsonWithoutDuplicateKeys } from "../discovery/strict-json.js";
import { KeyEncryptor } from "../identity/key-encryption.js";
import { MigrationTransferService, validateTransferManifest } from "../migration/transfer.js";
import { OnboardingRepository } from "../onboarding/repository.js";
import { createHailDidResolver } from "../plc/public-resolver.js";

const [inputFile, consentFile, plcOperationFile, addressBindingFile] = Bun.argv.slice(2);
if (!inputFile || !consentFile || !plcOperationFile || !addressBindingFile || Bun.argv.length !== 6) {
  throw new Error("Usage: bun run migration:stage -- <private-signed-export-file> <user-signed-consent-file> <user-signed-plc-operation.json> <user-signed-address-binding.cose>");
}
for (const file of [inputFile, consentFile, plcOperationFile, addressBindingFile]) {
  const metadata = await stat(file);
  if (!metadata.isFile() || metadata.size > 100_000_000 || metadata.size < 1 || (metadata.mode & 0o077) !== 0) {
    throw new Error("Migration import files must be nonempty private regular files under 100 MB");
  }
}
const parsed = parseJsonWithoutDuplicateKeys(await Bun.file(inputFile).text());
if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) ||
  Object.keys(parsed).sort().join(",") !== "digest,manifest,signature,sourceMessagingPublicKey,type,version") {
  throw new Error("Invalid migration import container");
}
const envelope = parsed as Record<string, unknown>;
if (envelope.type !== "hail.portable-migration-transfer" || ![2,3].includes(envelope.version as number) ||
  !["manifest", "digest", "signature", "sourceMessagingPublicKey"].every((key) => typeof envelope[key] === "string")) {
  throw new Error("Unsupported migration import container");
}
const parsedConsent = parseJsonWithoutDuplicateKeys(await Bun.file(consentFile).text());
if (!parsedConsent || typeof parsedConsent !== "object" || Array.isArray(parsedConsent) ||
  Object.keys(parsedConsent).sort().join(",") !== "payload,signature,type,version") {
  throw new Error("Invalid portable migration consent container");
}
const consent = parsedConsent as Record<string, unknown>;
if (consent.type !== "hail.portable-migration-consent" || consent.version !== 1 ||
  typeof consent.payload !== "string" || typeof consent.signature !== "string") {
  throw new Error("Unsupported portable migration consent container");
}
const decode = (value: string) => {
  const bytes = decodeBase64Url(value);
  if (encodeBase64Url(bytes) !== value) throw new Error("Noncanonical migration import bytes");
  return bytes;
};
const manifestBytes=decode(envelope.manifest as string);
if(validateTransferManifest(manifestBytes).version!==envelope.version)throw new Error("Migration container and manifest versions differ");
const config = loadConfig();
const database = new ProviderDatabase(config.databaseUrl);
try {
  await database.migrate();
  const manifest = await new MigrationTransferService(database.sql, new OnboardingRepository(database.sql),
    new KeyEncryptor(config.keyEncryptionKey),
    createHailDidResolver(config,database.sql), config.hailServiceBase)
    .stageImport({ bytes: manifestBytes, digest: decode(envelope.digest as string),
      signature: decode(envelope.signature as string), sourceMessagingPublicKey: envelope.sourceMessagingPublicKey as string },
      { payloadBytes: decode(consent.payload), signature: decode(consent.signature) },
      new Uint8Array(await Bun.file(plcOperationFile).arrayBuffer()),
      new Uint8Array(await Bun.file(addressBindingFile).arrayBuffer()));
  console.info(JSON.stringify({ did: manifest.did, transferId: manifest.transferId,
    digest: envelope.digest, state: "staged-inactive" }));
} finally { await database.close(); }
