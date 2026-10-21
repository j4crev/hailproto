import { open, unlink } from "node:fs/promises";
import { encodeBase64Url } from "@hailproto/codec";
import { createUserVault } from "../vault.js";

const [vaultPath, recoveryPath] = Bun.argv.slice(2);
if (!vaultPath || !recoveryPath || vaultPath === recoveryPath || Bun.argv.length !== 4) {
  throw new Error("Usage: bun run poc:create-disposable-vault -- <new-private-vault-file> <new-private-recovery-secret-file>");
}
const generated = await createUserVault();
let vaultCreated = false;
let recoveryCreated = false;
try {
  const vault = await open(vaultPath, "wx", 0o600);
  vaultCreated = true;
  try { await vault.writeFile(JSON.stringify(generated.vault)); }
  finally { await vault.close(); }
  const recovery = await open(recoveryPath, "wx", 0o600);
  recoveryCreated = true;
  try { await recovery.writeFile(`${encodeBase64Url(generated.recoverySecret)}\n`); }
  finally { await recovery.close(); }
  console.info(JSON.stringify({ profile: "disposable-private-poc", vaultPath, recoveryPath,
    recoveryPublicKey: generated.vault.recovery.publicDidKey,
    identityPublicKey: generated.vault.identity.publicDidKey }));
} catch (error) {
  if (vaultCreated) await unlink(vaultPath).catch(() => {});
  if (recoveryCreated) await unlink(recoveryPath).catch(() => {});
  throw error;
} finally { generated.recoverySecret.fill(0); }
