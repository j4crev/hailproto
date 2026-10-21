import { open, unlink } from "node:fs/promises";
import { AccountApiRepository, ALL_ACCOUNT_SCOPES } from "../accounts/repository.js";
import { loadConfig } from "../config.js";
import { ProviderDatabase } from "../db/database.js";

const [address, output, permission] = Bun.argv.slice(2);
if (!address || !output || permission !== undefined && !["--write-grants","--full-access"].includes(permission) || Bun.argv.length > 5) {
  throw new Error("Usage: bun run account:credential-create -- <active-local-address> <new-private-credential-file> [--write-grants | --full-access]");
}
const config = loadConfig();
const db = new ProviderDatabase(config.databaseUrl);
try {
  await db.migrate();
  const file = await open(output, "wx", 0o600);
  let issued: Awaited<ReturnType<AccountApiRepository["issue"]>> | undefined;
  let complete = false;
  const accounts = new AccountApiRepository(db.sql);
  try {
    issued = await accounts.issue(address, permission === "--write-grants",undefined,permission === "--full-access" ? [...ALL_ACCOUNT_SCOPES] : undefined);
    await file.writeFile(JSON.stringify({ type: "hailp.api-credential", version: 1,
      provider: config.publicOrigin, ...issued }));
    await file.sync();
    complete = true;
  } finally {
    await file.close();
    if (!complete) {
      if (issued) await accounts.revoke(issued.credentialId);
      await unlink(output);
    }
  }
  console.info(JSON.stringify({ credentialId: issued!.credentialId, accountId: issued!.accountId,
    scopes: issued!.scopes, expiresAt: issued!.expiresAt, credentialFile: output }));
} finally { await db.close(); }
