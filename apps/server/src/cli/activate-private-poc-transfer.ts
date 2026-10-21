import { loadConfig } from "../config.js";
import { ProviderDatabase } from "../db/database.js";
import { SafeHttpsTransport } from "../discovery/safe-fetch.js";
import { AddressVerifier } from "../discovery/verifier.js";
import { KeyEncryptor } from "../identity/key-encryption.js";
import { PortableMigrationActivation } from "../migration/activation.js";
import { PrivatePocCutoverGate } from "../migration/poc-cutover-gate.js";
import { createPlcDirectoryClient } from "../plc/client.js";
import { PlcHailDidResolver } from "../plc/resolver.js";
import { writeTransferRecord } from "./transfer-record.js";

const [transferId, receiptFile] = Bun.argv.slice(2);
if (!transferId || !receiptFile || Bun.argv.length !== 4) {
  throw new Error("Usage: bun run poc:activate-transfer -- <staged-transfer-id> <new-private-receipt-file>");
}
const config = loadConfig();
const database = new ProviderDatabase(config.databaseUrl);
try {
  await database.migrate();
  const plc = createPlcDirectoryClient(config.plcDirectoryUrl);
  const resolver = new PlcHailDidResolver(plc);
  const gate = new PrivatePocCutoverGate(database.sql, { origin: config.plcDirectoryUrl,
    resolver, audit: (did) => plc.getAuditableLog(did) }, config.plcDirectoryUrl,
  config.hailServiceBase);
  const transport = new SafeHttpsTransport();
  const service = new PortableMigrationActivation(database.sql,
    new KeyEncryptor(config.keyEncryptionKey), resolver, gate,
    new AddressVerifier(plc, transport.fetch, transport.validateTarget),
    config.hailServiceBase, config.plcDirectoryUrl, undefined, "private-poc");
  const result = await service.activate(transferId);
  const receipt = await service.issueReceipt(transferId);
  await writeTransferRecord(receiptFile, receipt);
  console.info(JSON.stringify({ ...result, transferId, profile: "private-poc" }));
} finally { await database.close(); }
