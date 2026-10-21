import { loadConfig } from "../config.js";
import { ProviderDatabase } from "../db/database.js";
import { SafeHttpsTransport } from "../discovery/safe-fetch.js";
import { TransferInvitationDelivery } from "../migration/invitation-delivery.js";
import { createHailDidResolver } from "../plc/public-resolver.js";
import { writeTransferRecord } from "./transfer-record.js";

const [did, offerFile] = Bun.argv.slice(2);
if (!did || !offerFile || Bun.argv.length !== 4) {
  throw new Error("Usage: bun run migration:deliver-invitation -- <local-did> <new-private-offer-file>");
}
const config = loadConfig();
const database = new ProviderDatabase(config.databaseUrl);
try {
  await database.migrate();
  const transport = new SafeHttpsTransport();
  const signedOffer = await new TransferInvitationDelivery(database.sql,
    createHailDidResolver(config,database.sql),
    config.hailServiceBase, transport.fetch, transport.validateTarget).deliver(did);
  await writeTransferRecord(offerFile, signedOffer);
} finally { await database.close(); }
