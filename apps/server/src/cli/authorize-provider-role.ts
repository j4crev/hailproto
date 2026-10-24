import { loadConfig } from "../config.js";
import { ProviderDatabase } from "../db/database.js";
import { authorizeProviderRole } from "../onboarding/provider-roles.js";

const [address, recoveryKey, extra] = Bun.argv.slice(2);
if (!address || !recoveryKey || extra !== undefined) {
  throw new Error("Usage: bun run account:role-authorize -- <role-address> <owner-recovery-public-did:key>");
}
const config = loadConfig(), db = new ProviderDatabase(config.databaseUrl);
try {
  await db.migrate();
  const accountId = await authorizeProviderRole(db.sql, address, recoveryKey, config.publicOrigin);
  console.info(JSON.stringify({ address, accountId, next: "Complete normal public onboarding using this recovery key; no account or credential has been created" }));
} finally { await db.close(); }
