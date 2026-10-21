import { MonitorDatabase } from "../database.js";
import { PlcMonitor } from "../monitor.js";
import { BoundedMonitorPlcClient } from "../plc.js";

if (!Bun.env.DATABASE_URL || !Bun.env.PLC_DIRECTORY_URL) {
  throw new Error("DATABASE_URL and PLC_DIRECTORY_URL are required");
}
const database = new MonitorDatabase(Bun.env.DATABASE_URL);
try {
  await database.migrate();
  const outcome = await new PlcMonitor(database.sql,
    new BoundedMonitorPlcClient(Bun.env.PLC_DIRECTORY_URL)).poll();
  console.info(JSON.stringify(outcome));
} finally { await database.close(); }
