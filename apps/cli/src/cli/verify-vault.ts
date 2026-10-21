import { decodeBase64Url } from "@hailproto/codec";
import { verifyVaultFile } from "../vault-backup.js";
import { readRecoverySecret } from "./private-input.js";

const filePath = Bun.argv[2];
if (!filePath || Bun.argv.length !== 3) throw new Error("Usage: bun run vault:verify -- <private-vault-file>");
const source = await readRecoverySecret();
const secret = decodeBase64Url(source);
try {
  console.info(JSON.stringify(await verifyVaultFile(filePath, secret)));
} finally { secret.fill(0); }
