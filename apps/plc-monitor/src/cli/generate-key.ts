import { generateKeyPairSync } from "node:crypto";
import { open, unlink } from "node:fs/promises";
import { MonitorSigner } from "../signing.js";

const path = Bun.argv[2];
if (!path || Bun.argv.length !== 3) {
  throw new Error("Usage: bun run monitor:keygen -- <private-pkcs8-output-file>");
}
const pair = generateKeyPairSync("ed25519");
const privateBytes = pair.privateKey.export({ format: "der", type: "pkcs8" });
const file = await open(path, "wx", 0o600);
let incomplete = false;
try { await file.writeFile(privateBytes); }
catch (error) { incomplete = true; throw error; }
finally { privateBytes.fill(0); await file.close(); if (incomplete) await unlink(path); }
console.info(JSON.stringify({ monitorDidKey: new MonitorSigner(pair.privateKey).publicDidKey,
  stored: true, permissions: "0600" }));
