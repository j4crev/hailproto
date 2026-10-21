import { unlink, stat } from "node:fs/promises";
import { dirname } from "node:path";
import { privateFile, savePrivateBytes } from "./grant-revocation.js";
import { unlockUserVault, type UserVaultFile } from "./vault.js";

async function verified(bytes: Uint8Array, secret: Uint8Array, expectedDid?: string | null) {
  if (expectedDid !== undefined && expectedDid !== null && !/^did:plc:[a-z2-7]{24}$/.test(expectedDid)) {
    throw new Error("Expected DID must be a canonical PLC DID or unbound");
  }
  const vault = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as UserVaultFile;
  const user = await unlockUserVault(vault, secret);
  if (expectedDid !== undefined && user.vault.did !== expectedDid) throw new Error("Vault does not match the reviewed DID");
  return { verified: true, did: vault.did, recoveryPublicKey: vault.recovery.publicDidKey,
    identityPublicKey: vault.identity.publicDidKey };
}

export async function verifyVaultFile(path: string, secret: Uint8Array, expectedDid?: string | null) {
  return verified(await privateFile(path, 16_384), secret, expectedDid);
}

export async function copyVerifiedVault(source: string, output: string, secret: Uint8Array, expectedDid?: string | null) {
  const bytes = await privateFile(source, 16_384);
  const result = await verified(bytes, secret, expectedDid);
  const parent = await stat(dirname(output));
  if (!parent.isDirectory() || (parent.mode & 0o077) !== 0) throw new Error("Vault destination directory must be private mode 0700");
  await savePrivateBytes(output, bytes);
  try {
    const copied = await privateFile(output, 16_384);
    if (!Buffer.from(copied).equals(Buffer.from(bytes))) throw new Error("Vault copy differs from the verified backup");
    await verified(copied, secret, expectedDid);
  } catch (error) { await unlink(output); throw error; }
  return { ...result, vaultFile: output };
}
