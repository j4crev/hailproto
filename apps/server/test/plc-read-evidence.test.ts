import { randomUUID } from "node:crypto";
import { cidForCbor } from "@atproto/common";
import { P256Keypair } from "@atproto/crypto";
import { didForCreateOp, signOperation, validateOperationLog, type ExportedOp, type Operation } from "@did-plc/lib";
import { expect, it, vi } from "vitest";
import { validatePlcReadEvidence } from "../src/plc/read-evidence.js";
import { signMonitorAttestation, verifyMonitorAttestation } from "../src/migration/monitor-attestation.js";
import { base58btc } from "multiformats/bases/base58";
import { createIndependentPlcObserver } from "../src/migration/cutover-gate.js";
import { encodePublicCutoverEvidence } from "../src/migration/public-cutover-evidence.js";

async function fixture() {
  const owner = await P256Keypair.create(), provider = await P256Keypair.create();
  const genesis = await signOperation({ type: "plc_operation", prev: null, rotationKeys: [owner.did(), provider.did()],
    verificationMethods: {}, services: {}, alsoKnownAs: ["at://reviewed.example.com"] }, owner);
  const did = await didForCreateOp(genesis), genesisCid = (await cidForCbor(genesis)).toString();
  const { sig, ...state } = genesis;
  const changed = await signOperation({ ...state, prev: genesisCid, alsoKnownAs: ["at://unwanted.example.com"] }, provider);
  const restored = await signOperation({ ...state, prev: genesisCid }, owner);
  const audit = async (operations: Operation[], nullified: number[] = []): Promise<ExportedOp[]> => Promise.all(operations.map(async (operation, index) => ({
    did, operation, cid: (await cidForCbor(operation)).toString(), nullified: nullified.includes(index),
    createdAt: new Date(1_800_000_000_000 + index * 1000).toISOString(),
  })));
  const read = async (log: Operation[], entries: ExportedOp[]) => validatePlcReadEvidence(did,
    { document: {}, data: (await validateOperationLog(did, log))!, log }, entries);
  return { did, genesis, changed, restored, audit, read, owner, provider };
}

it("bounds retained evidence components and the entire bundle before persistence", () => {
  expect(() => encodePublicCutoverEvidence({ bytes:new Uint8Array(1_048_577) })).toThrow();
  const text="x".repeat(1_048_576);
  expect(() => encodePublicCutoverEvidence({ witnesses:Array.from({length:9},()=>text) })).toThrow();
});

it("binds observer metadata to the actual configured read origin with bounded credential-free transport", async () => {
  const f = await fixture(), audit = await f.audit([f.genesis]);
  const transport = vi.fn(async () => new Response(JSON.stringify(audit)));
  vi.stubGlobal("fetch", transport);
  try {
    expect(() => createIndependentPlcObserver("https://mirror.example.com/", "reader-one")).toThrow();
    const first = createIndependentPlcObserver("https://mirror-one.example.com", "reader-one");
    const second = createIndependentPlcObserver("https://mirror-two.example.com", "reader-two");
    expect(await first.audit(f.did)).toEqual(audit); expect(await second.audit(f.did)).toEqual(audit);
    for (const [index, origin] of ["https://mirror-one.example.com", "https://mirror-two.example.com"].entries()) {
      const [url, init] = transport.mock.calls[index]! as unknown as [string, RequestInit];
      expect(url).toBe(`${origin}/${encodeURIComponent(f.did)}/log/audit`);
      expect(init).toMatchObject({ method: "GET", redirect: "error" });
      expect(init.signal).toBeInstanceOf(AbortSignal); expect(new Headers(init.headers).has("Authorization")).toBe(false);
    }
  } finally { vi.unstubAllGlobals(); }
});

it("validates complete canonical history and the official priority/window rules for supplied recovery audit annotations", async () => {
  const f = await fixture();
  expect((await f.read([f.genesis, f.changed], await f.audit([f.genesis, f.changed]))).operationCid).toBe((await cidForCbor(f.changed)).toString());
  const history = await f.audit([f.genesis, f.changed, f.restored], [1]);
  expect((await f.read([f.genesis, f.restored], history)).audit).toEqual(history);
  const wrongFlags = structuredClone(history); wrongFlags[1]!.nullified = false;
  await expect(f.read([f.genesis, f.restored], wrongFlags)).rejects.toThrow("nullification");
  const late = structuredClone(history); late[2]!.createdAt = new Date(Date.parse(late[1]!.createdAt) + 73 * 3600_000).toISOString();
  await expect(f.read([f.genesis, f.restored], late)).rejects.toThrow();
  const { sig, ...unsigned } = f.restored;
  const providerFork = await signOperation(unsigned, f.provider);
  await expect(f.read([f.genesis, providerFork], await f.audit([f.genesis, f.changed, providerFork], [1]))).rejects.toThrow();
});

it("rejects head-only, changed-CID, duplicated, misordered and mismatched-state audit evidence", async () => {
  const f = await fixture(), full = await f.audit([f.genesis, f.changed]);
  const variants = [full.slice(1), [...full, full[1]!], [...full].reverse(),
    full.map((entry, index) => index ? { ...entry, cid: full[0]!.cid } : entry),
    full.map(entry => ({ ...entry, did: `did:plc:${"a".repeat(24)}` })),
    full.map(entry => ({ ...entry, createdAt: "not-a-date" })),
    full.map((entry, index) => index ? { ...entry, operation: { ...entry.operation, alsoKnownAs: [] } as Operation } : entry),
  ];
  for (const audit of variants) await expect(f.read([f.genesis, f.changed], audit)).rejects.toThrow();
  await expect(validatePlcReadEvidence(f.did, { document: {}, data: {}, log: [f.genesis] }, full)).rejects.toThrow("state disagree");
  await expect(f.read([f.genesis], Array.from({ length: 1001 }, () => full[0]!))).rejects.toThrow("limit");
});

it("keeps legacy monitor verification compatible while requiring five-minute freshness for the public policy", async () => {
  const pair = await crypto.subtle.generateKey("Ed25519", true, ["sign", "verify"]);
  const key = `did:key:${base58btc.encode(new Uint8Array([0xed, 1, ...new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey))]))}`;
  const f = await fixture(), now = 1_800_000_000;
  const report = { type: "hail.plc-monitor-attestation" as const, version: 1 as const, did: f.did,
    transfer_id: randomUUID(), operation_cid: (await cidForCbor(f.genesis)).toString(), monitor_origin: "https://monitor.example.com",
    coverage_since: now - 3600, observed_at: now - 301 };
  const signed = await signMonitorAttestation(report, pair.privateKey);
  expect((await verifyMonitorAttestation(signed, key, now)).did).toBe(f.did);
  await expect(verifyMonitorAttestation(signed, key, now, 300)).rejects.toThrow("stale");
  const fresh = await signMonitorAttestation({ ...report, observed_at: now - 300 }, pair.privateKey);
  expect((await verifyMonitorAttestation(fresh, key, now, 300)).did).toBe(f.did);
  const future = await signMonitorAttestation({ ...report, observed_at: now + 301 }, pair.privateKey);
  await expect(verifyMonitorAttestation(future, key, now, 300)).rejects.toThrow("stale");
    for (const monitor_origin of ["https://monitor.example.com/", "https://127.0.0.1", "https://MONITOR.example.com", "https://monitor..example.com"]) {
    await expect(signMonitorAttestation({ ...report, monitor_origin }, pair.privateKey)).rejects.toThrow();
  }
});
