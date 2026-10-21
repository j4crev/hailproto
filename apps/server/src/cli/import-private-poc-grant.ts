import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { encodeBase64Url } from "@hailproto/codec";
import { loadConfig } from "../config.js";
import { ProviderDatabase } from "../db/database.js";
import { SafeHttpsTransport } from "../discovery/safe-fetch.js";
import { AddressVerifier } from "../discovery/verifier.js";
import { GrantRepository } from "../grants/repository.js";
import { GrantService } from "../grants/service.js";
import { canonicalizeHailAddress } from "../identity/address.js";
import { KeyEncryptor } from "../identity/key-encryption.js";
import { assertPrivatePocRegistry } from "../migration/poc-profile.js";
import { OnboardingRepository } from "../onboarding/repository.js";
import { createPlcDirectoryClient } from "../plc/client.js";
import { PlcHailDidResolver } from "../plc/resolver.js";
import { SenderProfileVerifier } from "../profiles/verifier.js";

const [grantorAddress, granteeAddress, filePath] = Bun.argv.slice(2);
if (!grantorAddress || !granteeAddress || !filePath || Bun.argv.length !== 5) {
  throw new Error("Usage: bun run poc:grant-import -- <local-user-address> <sender-address> <user-signed-grant.cose>");
}
const metadata = await stat(filePath);
if (!metadata.isFile() || metadata.size < 1 || metadata.size > 262_144 ||
  (metadata.mode & 0o077) !== 0) throw new Error("Signed Grant must be a bounded mode-0600 private file");
const signed = new Uint8Array(await readFile(filePath));
const config = loadConfig();
assertPrivatePocRegistry(config.plcDirectoryUrl, config.hailServiceBase);
const database = new ProviderDatabase(config.databaseUrl);
try {
  await database.migrate();
  const accounts = new OnboardingRepository(database.sql);
  const account = await accounts.getAccountByAddress(canonicalizeHailAddress(grantorAddress));
  const custody = await database.sql<{ monitor_verification_mode: string }[]>`
    SELECT monitor_verification_mode FROM portable_custody_evidence WHERE account_id = ${account.id}`;
  if (custody[0]?.monitor_verification_mode !== "poc-local") {
    throw new Error("POC Grant import requires a new user-held identity");
  }
  const plc = createPlcDirectoryClient(config.plcDirectoryUrl);
  const resolver = new PlcHailDidResolver(plc);
  const transport = new SafeHttpsTransport();
  const grant = await new GrantService(accounts, new GrantRepository(database.sql),
    new KeyEncryptor(config.keyEncryptionKey), resolver,
    new AddressVerifier(plc, transport.fetch, transport.validateTarget),
    new SenderProfileVerifier(resolver, transport.fetch, transport.validateTarget, undefined, accounts),
    config.hailServiceBase).acceptUserSignedGrant(grantorAddress, granteeAddress, signed);
  console.info(JSON.stringify({ grantId: grant.payload.grant_id,
    revision: grant.payload.revision, status: grant.payload.status, grantor: grant.payload.grantor,
    grantee: grant.payload.grantee,
    digest: encodeBase64Url(createHash("sha256").update(signed).digest()),
    state: "signed-authoritative-pending-publication" }));
} finally { await database.close(); }
