import { SQL } from "bun";
import { compactPublicEvidence } from "../plc/compact-evidence.js";

const args = process.argv.slice(2);
if (args.length > 1 || args.length === 1 && args[0] !== "--apply")
  throw new Error("Usage: bun src/cli/compact-plc-evidence.ts [--apply] (default: read-only estimate)");
if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required");
const sql = new SQL(process.env.DATABASE_URL, { max: 1 });
try { console.info(JSON.stringify(await compactPublicEvidence(sql, args[0] === "--apply"), null, 2)); }
finally { await sql.close(); }
