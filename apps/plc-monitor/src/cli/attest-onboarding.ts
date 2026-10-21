import { encodeBase64Url } from "@hailproto/codec";
import { MonitorDatabase } from "../database.js";
import { PlcMonitor } from "../monitor.js";
import { BoundedMonitorPlcClient } from "../plc.js";
import { MonitorSigner } from "../signing.js";

const [did, operationCid] = Bun.argv.slice(2);
if (!did || !operationCid || Bun.argv.length !== 4 || !Bun.env.DATABASE_URL ||
  !Bun.env.PLC_DIRECTORY_URL || !Bun.env.MONITOR_PRIVATE_KEY_FILE || !Bun.env.MONITOR_ORIGIN) {
  throw new Error("Usage: bun run monitor:attest-onboarding -- <did> <genesis-cid>; set monitor environment");
}
const signer = await MonitorSigner.fromPrivateFile(Bun.env.MONITOR_PRIVATE_KEY_FILE);
const database = new MonitorDatabase(Bun.env.DATABASE_URL);
try {
  await database.migrate();
  const attestation = await new PlcMonitor(database.sql,
    new BoundedMonitorPlcClient(Bun.env.PLC_DIRECTORY_URL))
    .attestOnboarding(did, operationCid, Bun.env.MONITOR_ORIGIN, signer);
  console.info(JSON.stringify({ monitorDidKey: signer.publicDidKey,
    payload: encodeBase64Url(attestation.payloadBytes), signature: encodeBase64Url(attestation.signature) }));
} finally { await database.close(); }
