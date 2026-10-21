import { loadConfig } from "../config.js";
import { ProviderDatabase } from "../db/database.js";
import { PrivatePocAddressPublication } from "../migration/poc-address-publication.js";
import { PrivatePocCutoverGate } from "../migration/poc-cutover-gate.js";
import { createPlcDirectoryClient } from "../plc/client.js";
import { PlcHailDidResolver } from "../plc/resolver.js";

const transferId = Bun.argv[2];
if (!transferId || Bun.argv.length !== 3) {
  throw new Error("Usage: bun run poc:publish-address -- <staged-transfer-id>");
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
  const id = await new PrivatePocAddressPublication(database.sql, resolver, gate,
    config.plcDirectoryUrl, config.hailServiceBase).publish(transferId);
  console.info(JSON.stringify({ transferId, bindingId: id, profile: "private-poc" }));
} finally { await database.close(); }
