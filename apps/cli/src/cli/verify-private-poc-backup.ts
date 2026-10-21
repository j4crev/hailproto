import { decodeBase64Url } from "@hailproto/codec";
import { privateFile } from "../grant-revocation.js";
import { copyVerifiedVault } from "../vault-backup.js";

const [vaultPath, recoveryPath, backupPath] = Bun.argv.slice(2);
if (!vaultPath || !recoveryPath || !backupPath ||
  new Set([vaultPath, recoveryPath, backupPath]).size !== 3 || Bun.argv.length !== 5) {
  throw new Error("Usage: bun run poc:verify-vault-copy -- <private-vault-file> <private-recovery-secret-file> <new-private-backup-vault-file>");
}
const secret = decodeBase64Url(new TextDecoder("utf-8", { fatal: true }).decode(await privateFile(recoveryPath, 16_384)).trim());
try {
  const copied = await copyVerifiedVault(vaultPath, backupPath, secret);
  console.info(JSON.stringify({ profile: "disposable-private-poc", backupVerified: true,
    vaultPath, backupPath, did: copied.did }));
} finally { secret.fill(0); }
