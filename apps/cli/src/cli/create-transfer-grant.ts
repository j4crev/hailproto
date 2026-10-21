import { randomUUID } from "node:crypto";
import { isIP } from "node:net";
import { open, stat, unlink } from "node:fs/promises";
import { domainToASCII } from "node:url";
import { decodeBase64Url, encodeBase64Url } from "@hailproto/codec";
import { unlockUserVault, type UserVaultFile, type UserTransferGrant } from "../vault.js";
import { readRecoverySecret } from "./private-input.js";

const [vaultPath, sourceBase, destinationDomain, outputPath] = Bun.argv.slice(2);
if (!vaultPath || !sourceBase || !destinationDomain || !outputPath || Bun.argv.length !== 6) {
  throw new Error("Usage: bun run transfer:grant -- <private-vault-file> <current-service-base-from-DID> <new-provider-domain> <new-private-grant-file>");
}
const domain = domainToASCII(destinationDomain);
if (!domain || domain.endsWith(".") || isIP(domain) !== 0 ||
  !/^([a-z0-9-]+\.)+[a-z0-9-]+$/.test(domain) ||
  domain.split(".").some((part) => part.startsWith("-") || part.endsWith("-"))) {
  throw new Error("Choose a public provider DNS domain, without an HTTPS scheme, port or path");
}
const metadata = await stat(vaultPath);
if (!metadata.isFile() || metadata.size > 16384 || metadata.size < 1 || (metadata.mode & 0o077) !== 0) {
  throw new Error("Vault must be a bounded private file with mode 0600");
}
const secret = decodeBase64Url(await readRecoverySecret());
try {
  const user = await unlockUserVault(JSON.parse(await Bun.file(vaultPath).text()) as UserVaultFile, secret);
  if (!user.vault.did) throw new Error("Bind the user DID before signing a transfer grant");
  const now = Math.floor(Date.now() / 1000);
  const grant: UserTransferGrant = { type: "hail.transfer-grant", version: 1,
    did: user.vault.did, nonce: randomUUID(), source_service_base: sourceBase,
    destination_service_base: `https://${domain}/hail`, destination_domain: domain,
    issued_at: now, expires_at: now + 3600 };
  const signed = await user.signTransferGrant(grant);
  const file = await open(outputPath, "wx", 0o600);
  let incomplete = false;
  try { await file.writeFile(JSON.stringify({ payload: encodeBase64Url(signed.payloadBytes),
    signature: encodeBase64Url(signed.signature) })); }
  catch (error) { incomplete = true; throw error; }
  finally { await file.close(); if (incomplete) await unlink(outputPath); }
  console.info(JSON.stringify({ did: grant.did, destination: domain, expiresAt: grant.expires_at }));
} finally { secret.fill(0); }
