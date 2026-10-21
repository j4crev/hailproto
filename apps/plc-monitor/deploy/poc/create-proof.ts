import { open } from "node:fs/promises";
import { P256Keypair } from "@atproto/crypto";
import { cidForCbor } from "@atproto/common";
import { didForCreateOp, signOperation, validateOperationLog } from "@did-plc/lib";
import { base58btc } from "multiformats/bases/base58";

// Run on the user device. Only these signed disposable operations go to PLC;
// the ephemeral rotation/identity private keys are never exported to the VPS.
const [output] = Bun.argv.slice(2);
if (!output || Bun.argv.length !== 3) throw new Error("Usage: bun deploy/poc/create-proof.ts <new-artifact-file>");
async function publicEd25519Key(): Promise<string> {
  const pair = await crypto.subtle.generateKey("Ed25519", true, ["sign", "verify"]);
  const bytes = new Uint8Array(34);
  bytes.set([0xed, 0x01]);
  bytes.set(new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey)), 2);
  return `did:key:${base58btc.encode(bytes)}`;
}
const rotation = await P256Keypair.create();
const genesis = await signOperation({ type: "plc_operation", prev: null,
  rotationKeys: [rotation.did()], alsoKnownAs: [],
  verificationMethods: { "hail-identity": await publicEd25519Key(), "hail-messaging": await publicEd25519Key() },
  services: { hail: { type: "HailMessaging", endpoint: "https://hailproto.app/hail" } },
}, rotation);
const did = await didForCreateOp(genesis);
const genesisCid = (await cidForCbor(genesis)).toString();
const { sig: genesisSignature, ...genesisPayload } = genesis;
const approved = await signOperation({ ...genesisPayload, prev: genesisCid,
  verificationMethods: { ...genesis.verificationMethods, "hail-messaging": await publicEd25519Key() },
  services: { hail: { type: "HailMessaging", endpoint: "https://hailproto.dev/hail" } },
}, rotation);
const approvedCid = (await cidForCbor(approved)).toString();
const { sig: approvedSignature, ...approvedPayload } = approved;
const unexpected = await signOperation({ ...approvedPayload, prev: approvedCid,
  alsoKnownAs: ["https://hailproto.app/poc/unexpected-monitor-change"],
}, rotation);
const unexpectedCid = (await cidForCbor(unexpected)).toString();
const approvedState = await validateOperationLog(did, [genesis, approved]);
if (!approvedState || !await validateOperationLog(did, [genesis, approved, unexpected])) {
  throw new Error("Invalid disposable proof operation chain");
}
const file = await open(output, "wx", 0o600);
try { await file.writeFile(JSON.stringify({ profile: "private-poc", did, genesisCid, approvedCid,
  unexpectedCid, genesis, approved, unexpected, approvedState })); }
finally { await file.close(); }
console.info(JSON.stringify({ profile: "private-poc", did, genesisCid, approvedCid, unexpectedCid }));
