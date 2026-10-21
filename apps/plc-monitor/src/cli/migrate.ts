import { MonitorDatabase } from "../database.js";

if (!Bun.env.DATABASE_URL) throw new Error("DATABASE_URL is required");
const database = new MonitorDatabase(Bun.env.DATABASE_URL);
try { await database.migrate(); console.info("Monitor database migrations are current"); }
finally { await database.close(); }
