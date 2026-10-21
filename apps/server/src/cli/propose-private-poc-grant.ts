import { open, unlink } from "node:fs/promises";
import { encodeBase64Url, encodeDeterministic, type HailValue } from "@hailproto/codec";
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

const [grantorAddress, granteeAddress, category, outputPath] = Bun.argv.slice(2);
if (!grantorAddress || !granteeAddress || !category || !outputPath || Bun.argv.length !== 6) {
  throw new Error("Usage: bun run poc:grant-propose -- <local-user-address> <sender-address> <offered-category> <new-private-proposal-file>");
}
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
    throw new Error("POC user Grant requires a new user-held identity");
  }
  const plc = createPlcDirectoryClient(config.plcDirectoryUrl);
  const resolver = new PlcHailDidResolver(plc);
  const transport = new SafeHttpsTransport();
  const payload = await new GrantService(accounts, new GrantRepository(database.sql),
    new KeyEncryptor(config.keyEncryptionKey), resolver,
    new AddressVerifier(plc, transport.fetch, transport.validateTarget),
    new SenderProfileVerifier(resolver, transport.fetch, transport.validateTarget, undefined, accounts),
    config.hailServiceBase).prepareUserSignedGrant(grantorAddress, granteeAddress,
      { scope: { type: "categories", values: [category] },
        expiresAt: Math.floor(Date.now() / 1000) + 7 * 86400 });
  const file = await open(outputPath, "wx", 0o600);
  let incomplete = false;
  try { await file.writeFile(JSON.stringify({ type: "hail.user-grant-proposal", version: 1,
    grantorAddress: canonicalizeHailAddress(grantorAddress),
    granteeAddress: canonicalizeHailAddress(granteeAddress),
    payload: encodeBase64Url(encodeDeterministic(payload as unknown as HailValue)) })); }
  catch (error) { incomplete = true; throw error; }
  finally { await file.close(); if (incomplete) await unlink(outputPath); }
  console.info(JSON.stringify({ grantId: payload.grant_id, grantee: payload.grantee,
    category, destination: granteeAddress, proposalFile: outputPath }));
} finally { await database.close(); }
