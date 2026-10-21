import { open, unlink } from "node:fs/promises";
import { encodeBase64Url } from "@hailproto/codec";
import { createUserVault } from "../vault.js";

const filePath = Bun.argv[2];
if (!filePath || Bun.argv.length !== 3) throw new Error("Usage: bun run vault:create -- <private-vault-file>");
const generated = await createUserVault();
const file = await open(filePath, "wx", 0o600);
let incomplete = false;
try { await file.writeFile(JSON.stringify(generated.vault)); }
catch (error) { incomplete = true; throw error; }
finally { await file.close(); if (incomplete) await unlink(filePath); }
try {
  console.info(JSON.stringify({ recoveryPublicKey: generated.vault.recovery.publicDidKey,
    identityPublicKey: generated.vault.identity.publicDidKey,
    recoverySecret: encodeBase64Url(generated.recoverySecret),
    action: "Store this uniformly generated recovery secret separately and verify recovery from another installation" }, null, 2));
} finally { generated.recoverySecret.fill(0); }
