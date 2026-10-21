import { AccountApiRepository } from "../accounts/repository.js";
import { loadConfig } from "../config.js";
import { ProviderDatabase } from "../db/database.js";

const [id] = Bun.argv.slice(2);
if (!id || Bun.argv.length !== 3) throw new Error("Usage: bun run account:credential-revoke -- <credential-id>");
const db = new ProviderDatabase(loadConfig().databaseUrl);
try {
  await db.migrate();
  await new AccountApiRepository(db.sql).revoke(id);
  console.info(JSON.stringify({ credentialId: id, revoked: true }));
} finally { await db.close(); }
