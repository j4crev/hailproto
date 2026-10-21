import { createHash } from "node:crypto";
import { open, readFile, stat, unlink } from "node:fs/promises";
import { decodeBase64Url, decodePayload, encodeBase64Url } from "@hailproto/codec";
import { unlockUserIdentity, type UserVaultFile } from "../vault.js";
import { readRecoverySecret } from "./private-input.js";

async function privateFile(path: string, limit: number): Promise<Uint8Array> {
  const info = await stat(path);
  if (!info.isFile() || info.size < 1 || info.size > limit || (info.mode & 0o077) !== 0) {
    throw new Error("Vault and Grant proposal must be bounded private mode-0600 files");
  }
  return new Uint8Array(await readFile(path));
}
const [vaultPath, proposalPath, expectedGrantorAddress, expectedAddress, outputPath] = Bun.argv.slice(2);
if (!vaultPath || !proposalPath || !expectedGrantorAddress || !expectedAddress ||
  !outputPath || Bun.argv.length !== 7) {
  throw new Error("Usage: bun run poc:sign-grant -- <private-vault> <provider-proposal.json> <reviewed-own-address> <reviewed-sender-address> <new-signed-grant.cose>");
}
const proposed: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true })
  .decode(await privateFile(proposalPath, 16_384)));
if (!proposed || typeof proposed !== "object" || Array.isArray(proposed) ||
  !("payload" in proposed) || !("granteeAddress" in proposed) ||
  !("grantorAddress" in proposed) || !("type" in proposed) || !("version" in proposed) ||
  proposed.type !== "hail.user-grant-proposal" || proposed.version !== 1 ||
  typeof proposed.payload !== "string" || typeof proposed.granteeAddress !== "string" ||
  proposed.granteeAddress !== expectedAddress || proposed.grantorAddress !== expectedGrantorAddress) {
  throw new Error("User must approve the proposal's exact own and sender addresses");
}
const payload = decodePayload("hail.grant", decodeBase64Url(proposed.payload));
if (payload.consent_context.grantee_address !== expectedAddress ||
  payload.status !== "active" || payload.revision !== 1 || payload.previous !== null ||
  payload.scope.length !== 1 || payload.expires_at !== null &&
  payload.expires_at <= Math.floor(Date.now() / 1000)) {
  throw new Error("Proposal consent, scope, or expiry no longer matches the reviewed sender");
}
const secret = decodeBase64Url((await readRecoverySecret()).trim());
try {
  const vault = JSON.parse(new TextDecoder().decode(await privateFile(vaultPath, 16_384))) as UserVaultFile;
  const user = await unlockUserIdentity(vault, secret);
  if (!vault.did || payload.grantor !== vault.did ||
    payload.key_id !== `${vault.did}#hail-identity`) {
    throw new Error("Grant proposal is not for this user's active DID");
  }
  const representation = await user.signGrant(payload);
  const file = await open(outputPath, "wx", 0o600);
  let incomplete = false;
  try { await file.writeFile(representation); }
  catch (error) { incomplete = true; throw error; }
  finally { await file.close(); if (incomplete) await unlink(outputPath); }
  console.info(JSON.stringify({ did: vault.did, grantId: payload.grant_id,
    reviewedSenderAddress: expectedAddress, scope: payload.scope,
    expiresAt: payload.expires_at,
    digest: encodeBase64Url(createHash("sha256").update(representation).digest()),
    signedFile: outputPath }));
} finally { secret.fill(0); }
