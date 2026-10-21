import { loadConfig } from "../config.js";
import { ProviderDatabase } from "../db/database.js";
import { KeyEncryptor } from "../identity/key-encryption.js";
import { importEd25519PrivateKey } from "../identity/keys.js";
import { TransferInvitationService } from "../migration/handshake.js";
import { OnboardingRepository } from "../onboarding/repository.js";
import { createHailDidResolver } from "../plc/public-resolver.js";
import { readTransferRecord, writeTransferRecord } from "./transfer-record.js";
import { decodeDeterministic } from "@hailproto/codec";
import { SafeHttpsTransport } from "../discovery/safe-fetch.js";
import { TransferInvitationDelivery } from "../migration/invitation-delivery.js";

const [grantFile, invitationFile, offerFile] = Bun.argv.slice(2);
if (!grantFile || !invitationFile || !offerFile || Bun.argv.length !== 5) {
  throw new Error("Usage: bun run migration:invite -- <user-signed-grant-file> <new-invitation-file> <new-private-offer-file>");
}
const config = loadConfig();
const database = new ProviderDatabase(config.databaseUrl);
try {
  await database.migrate();
  const grant = await readTransferRecord(grantFile);
  const row: unknown = decodeDeterministic(grant.payloadBytes);
  if (!row || typeof row !== "object" || !("did" in row) || typeof row.did !== "string") {
    throw new Error("Transfer grant has no DID");
  }
  const account = await database.sql<{ id: string }[]>`
    SELECT id FROM provider_accounts WHERE did = ${row.did}`;
  if (!account[0]) throw new Error("No source account");
  const key = await new OnboardingRepository(database.sql).getKey(account[0].id, "hail-messaging");
  const bytes = await new KeyEncryptor(config.keyEncryptionKey).decrypt(account[0].id,
    key.role, key.algorithm, key.publicKey, key);
  try {
    const resolver = createHailDidResolver(config,database.sql);
    const invitation = await new TransferInvitationService(database.sql, resolver,
      config.hailServiceBase).issue(grant, await importEd25519PrivateKey(bytes));
    await writeTransferRecord(invitationFile, invitation);
    const transport = new SafeHttpsTransport();
    const signedOffer = await new TransferInvitationDelivery(database.sql, resolver,
      config.hailServiceBase, transport.fetch, transport.validateTarget).deliver(row.did);
    await writeTransferRecord(offerFile, signedOffer);
  } finally { bytes.fill(0); }
} finally { await database.close(); }
