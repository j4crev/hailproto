import { cidForCbor } from "@atproto/common";
import { generateKeyPairSync, randomUUID } from "node:crypto";
import { P256Keypair } from "@atproto/crypto";
import { didForCreateOp, signOperation, validateOperationLog, type CompatibleOpOrTombstone,
  type ExportedOpWithSeq } from "@did-plc/lib";
import { base58btc } from "multiformats/bases/base58";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MonitorDatabase } from "../src/database.js";
import { PlcMonitor } from "../src/monitor.js";
import { MonitorNotifier, type AlertTransport } from "../src/notifier.js";
import type { MonitorPlcClient } from "../src/plc.js";
import { MonitorSigner } from "../src/signing.js";
import { verifyMonitorAttestation, verifyOnboardingMonitorAttestation } from "../../hail-server-ts/src/migration/monitor-attestation.js";

const integration = process.env.DATABASE_URL ? describe : describe.skip;

async function identityKey() {
  const key = (await crypto.subtle.generateKey("Ed25519", true, ["sign", "verify"])) as CryptoKeyPair;
  const bytes = new Uint8Array(34);
  bytes.set([0xed, 0x01]);
  bytes.set(new Uint8Array(await crypto.subtle.exportKey("raw", key.publicKey)), 2);
  return `did:key:${base58btc.encode(bytes)}`;
}

integration("independent monitor durable cursor", () => {
  let db: MonitorDatabase;
  let did: string;
  let key: P256Keypair;
  let genesis: CompatibleOpOrTombstone;
  let cid: string;
  let log: CompatibleOpOrTombstone[];
  let exported: ExportedOpWithSeq[];
  let tick = Date.now();
  const auditEpoch=tick;
  let corrupt = false;
  const observed = () => new Date(tick);
  const client: MonitorPlcClient = {
    async exportAfter(after, count) { return exported.filter((entry) => entry.seq > after).slice(0, count); },
    async getOperationLog() { return log; },
    async getDocumentData() {
      const state = await validateOperationLog(did, log);
      if (!state) throw new Error("Invalid fixture log");
      return corrupt ? { ...state, alsoKnownAs: ["https://tampered.example.com"] } : state;
    },
    async getAuditableLog() {
      return Promise.all(log.map(async (operation,index) => ({ did, operation,
        cid: corrupt&&index===log.length-1?cid:(await cidForCbor(operation)).toString(), nullified: false,
        createdAt: new Date(auditEpoch+index*1000).toISOString() })));
    },
  };

  beforeAll(async () => {
    db = new MonitorDatabase(process.env.DATABASE_URL!);
    await db.migrate();
    const existing = await db.sql<{ count: number; last_seq: number | bigint | string }[]>`
      SELECT (SELECT count(*)::int FROM monitored_dids) AS count, last_seq
      FROM monitor_cursor WHERE singleton = true`;
    if (existing[0]?.count !== 0 || Number(existing[0].last_seq) !== 0) {
      throw new Error("Monitor integration requires an empty disposable database");
    }
    key = await P256Keypair.create({ exportable: true });
    const [identity, messaging] = await Promise.all([identityKey(), identityKey()]);
    const operation = await signOperation({ type: "plc_operation", rotationKeys: [key.did()],
      verificationMethods: { "hail-identity": identity, "hail-messaging": messaging },
      alsoKnownAs: [], services: { hail: { type: "HailMessaging", endpoint: "https://sender.example.com/hail" } },
      prev: null }, key);
    genesis = operation;
    did = await didForCreateOp(operation);
    cid = (await cidForCbor(operation)).toString();
    log = [operation];
    exported = [{ did, operation, cid, seq: 1, type: "sequenced_op", createdAt: observed().toISOString() }];
  });

  afterAll(async () => {
    if (!db) return;
    if (did) {
      await db.sql`DELETE FROM monitor_alerts WHERE did = ${did}`;
      await db.sql`DELETE FROM monitor_observations WHERE did = ${did}`;
      await db.sql`DELETE FROM monitor_approvals WHERE did = ${did}`;
      await db.sql`DELETE FROM monitor_bootstrap_checkpoints WHERE did = ${did}`;
      await db.sql`DELETE FROM monitored_dids WHERE did = ${did}`;
      const remaining = await db.sql<{ count: number }[]>`SELECT count(*)::int AS count FROM monitored_dids`;
      if (remaining[0]?.count === 0) {
        await db.sql`UPDATE monitor_cursor SET last_seq = 0, last_healthy_at = NULL, caught_up = false WHERE singleton = true`;
      }
    }
    await db.close();
  });

  it("enrolls a validated DID, advances an exact sequence and alerts on unexpected changes", async () => {
    const monitor = new PlcMonitor(db.sql, client, observed);
    await monitor.enroll(did, cid, "https://user.example.com/alerts");
    expect(await monitor.poll()).toMatchObject({ state: "current", inspected: 0, alerts: 0 });
    const updated = await signOperation({ type: "plc_operation", rotationKeys: [key.did()],
      verificationMethods: { "hail-identity": (genesis as { verificationMethods: Record<string, string> }).verificationMethods["hail-identity"]!,
        "hail-messaging": (genesis as { verificationMethods: Record<string, string> }).verificationMethods["hail-messaging"]! },
      alsoKnownAs: ["https://changed.example.com"],
      services: { hail: { type: "HailMessaging", endpoint: "https://sender.example.com/hail" } },
      prev: cid }, key);
    log = [genesis, updated];
    const updateCid = (await cidForCbor(updated)).toString();
    exported.push({ did, operation: updated, cid: updateCid, seq: 2, type: "sequenced_op",
      createdAt: observed().toISOString() });
    expect(await monitor.poll()).toMatchObject({ state: "current", inspected: 1, alerts: 1 });
    const alerts = await db.sql<{ category: string; sent_at: Date | null }[]>`
      SELECT category, sent_at FROM monitor_alerts WHERE did = ${did}`;
    expect(alerts[0]?.category).toBe("unexpected-operation");
    expect(alerts[0]?.sent_at).toBeNull();
    expect(await monitor.poll()).toMatchObject({ state: "current", alerts: 0 });
    expect((await db.sql`SELECT id FROM monitor_alerts WHERE did = ${did}`)).toHaveLength(1);
  });

  it("signs coverage only after user-run approval and out-of-band notification", async () => {
    const signer = new MonitorSigner(generateKeyPairSync("ed25519").privateKey);
    const monitor = new PlcMonitor(db.sql, client, observed);
    await expect(monitor.attest(did, randomUUID(), exported[1]!.cid,
      "https://monitor.example.com", signer)).rejects.toThrow("approval or uninterrupted coverage");
    const notifier = new MonitorNotifier(db.sql, signer, { async send() { return 204; } }, observed);
    expect(await notifier.sendOne()).toBe("sent");
    const reviewed = await validateOperationLog(did, log);
    expect(reviewed).not.toBeNull();
    await monitor.approveExpected(did, exported[1]!.cid, reviewed!);
    const signed = await monitor.attest(did, randomUUID(), exported[1]!.cid,
      "https://monitor.example.com", signer);
    expect((await verifyMonitorAttestation(signed, signer.publicDidKey, Math.floor(tick / 1000))).did).toBe(did);
    await expect(monitor.approveExpected(did, cid, reviewed!)).rejects.toThrow();
  });

  it("records lost coverage after downtime and preserves the cursor after a restart", async () => {
    tick += 25 * 3600 * 1000;
    const monitor = new PlcMonitor(db.sql, client, observed);
    expect(await monitor.poll()).toMatchObject({ state: "current", alerts: 1 });
    const restarted = new PlcMonitor(db.sql, client, observed);
    expect(await restarted.poll()).toMatchObject({ state: "current", alerts: 0 });
    expect((await db.sql`SELECT id FROM monitor_alerts WHERE category = 'coverage-lost'`)).toHaveLength(1);
  });

  it("rejects an inconsistent DID audit", async () => {
    const current = await signOperation({ type: "plc_operation", rotationKeys: [key.did()],
      verificationMethods: (genesis as { verificationMethods: Record<string, string> }).verificationMethods,
      alsoKnownAs: ["https://again.example.com"],
      services: { hail: { type: "HailMessaging", endpoint: "https://sender.example.com/hail" } },
      prev: (await cidForCbor(log[log.length - 1])).toString() }, key);
    const newCid = (await cidForCbor(current)).toString();
    exported.push({ did, operation: current, cid: newCid, seq: 4, type: "sequenced_op",
      createdAt: observed().toISOString() });
    const monitor = new PlcMonitor(db.sql, client, observed);
    log = [...log, current];
    corrupt = true;
    expect(await monitor.poll()).toMatchObject({ state: "invalid-log", alerts: 1 });
  });

  it("durably retries signed user alerts and interoperates with provider monitor verification", async () => {
    const signer = new MonitorSigner(generateKeyPairSync("ed25519").privateKey);
    let sends = 0;
    const transport: AlertTransport = { async send(url, bytes, signature, publicDidKey) {
      sends += 1;
      expect(url).toBe("https://user.example.com/alerts");
      expect(bytes.length).toBeGreaterThan(0);
      expect(signature).toHaveLength(64);
      expect(publicDidKey).toBe(signer.publicDidKey);
      return sends === 1 ? 503 : 204;
    } };
    const notifier = new MonitorNotifier(db.sql, signer, transport, observed);
    expect(await notifier.sendOne()).toBe("retry");
    const pending = await db.sql<{ attempt_count: number; sent_at: Date | null }[]>`
      SELECT attempt_count, sent_at FROM monitor_alerts WHERE category = 'coverage-lost'`;
    expect(pending[0]?.attempt_count).toBe(1);
    expect(pending[0]?.sent_at).toBeNull();
    await db.sql`UPDATE monitor_alerts SET next_attempt_at = now() - interval '1 second'
      WHERE category = 'coverage-lost'`;
    expect(await notifier.sendOne()).toBe("sent");
    const acknowledged = await db.sql<{ sent_at: Date | null }[]>`
      SELECT sent_at FROM monitor_alerts WHERE category = 'coverage-lost'`;
    expect(acknowledged[0]?.sent_at).not.toBeNull();
    const signed = signer.signCoverage({ type: "hail.plc-monitor-attestation", version: 1,
      did, transfer_id: randomUUID(), operation_cid: exported[1]!.cid,
      monitor_origin: "https://monitor.example.com", coverage_since: Math.floor(tick / 1000) - 3600,
      observed_at: Math.floor(tick / 1000) });
    expect((await verifyMonitorAttestation(signed, signer.publicDidKey, Math.floor(tick / 1000))).did).toBe(did);
  });

  it("preserves legacy evidence and refuses rollback after per-DID polling", async () => {
    corrupt = false;
    const monitor = new PlcMonitor(db.sql, client, observed);
    expect((await monitor.poll()).state).toBe("current");
    const fingerprint = async () => Promise.all(["monitored_dids", "monitor_observations", "monitor_alerts", "monitor_approvals", "monitor_cursor"].map(async table =>
      JSON.stringify(await db.sql.unsafe(`SELECT to_jsonb(row) - 'caught_up' AS value FROM ${table} row ORDER BY to_jsonb(row)::text`))));
    const before = await fingerprint(), connection = await db.sql.reserve();
    try {
      await expect(connection.unsafe(await Bun.file(new URL("../migrations/rollback/0005_per_did_audit_polling.sql", import.meta.url)).text()))
        .rejects.toThrow("per-DID monitor evidence");
      await connection.unsafe("ROLLBACK");
    } catch (error) { await connection.unsafe("ROLLBACK"); throw error; }
    finally { connection.release(); }
    expect(await fingerprint()).toEqual(before);
    await db.migrate(); expect(await fingerprint()).toEqual(before);
    expect(await db.sql`SELECT did FROM monitor_bootstrap_checkpoints`).toHaveLength(0);
    await db.migrate(); expect(await fingerprint()).toEqual(before);
  });
});

integration("reviewed bootstrap and durable backfill readiness", () => {
  it("reports lost coverage for enrollment that has never completed its first backfill", async () => {
    const db = new MonitorDatabase(process.env.DATABASE_URL!);
    let did = "";
    try {
      await db.migrate();
      const key = await P256Keypair.create();
      const operation = await signOperation({ type: "plc_operation", prev: null, rotationKeys: [key.did()],
        verificationMethods: {}, services: {}, alsoKnownAs: [] }, key);
      did = await didForCreateOp(operation);
      const cid = (await cidForCbor(operation)).toString();
      let tick = Date.now();
      let unavailable=false;
      const client: MonitorPlcClient = {
        async exportAfter() { throw new Error("Export unavailable"); }, async getOperationLog() { return [operation]; },
        async getDocumentData() { return (await validateOperationLog(did, [operation]))!; },
        async getAuditableLog() { if(unavailable)throw new Error("Audit unavailable");return [{ did, operation, cid, nullified: false, createdAt: new Date(tick).toISOString() }]; },
      };
      const monitor = new PlcMonitor(db.sql, client, () => new Date(tick));
      await monitor.enroll(did, cid, "https://owner.example.com/alerts");
      unavailable=true;
      tick += 25 * 3600_000;
      expect(await monitor.poll()).toMatchObject({ state: "unavailable", alerts: 1 });
      expect(await monitor.poll()).toMatchObject({ state: "unavailable", alerts: 0 });
      expect(await db.sql`SELECT id FROM monitor_alerts WHERE did=${did} AND category='coverage-lost'`).toHaveLength(1);
      expect((await db.sql<{ last_healthy_at: Date | null }[]>`SELECT last_healthy_at FROM monitor_cursor`)[0]!.last_healthy_at).toBeNull();
    } finally {
      if (did) { await db.sql`DELETE FROM monitor_alerts WHERE did=${did}`; await db.sql`DELETE FROM monitored_dids WHERE did=${did}`; }
      await db.sql`UPDATE monitor_cursor SET last_seq=0,last_healthy_at=NULL,caught_up=false WHERE singleton=true`;
      await db.close();
    }
  });

  it("refuses partial/outage/gapped coverage across restart and preserves all rows through guarded migration rollback", async () => {
    const db = new MonitorDatabase(process.env.DATABASE_URL!);
    let did = "";
    try {
      await db.migrate();
      expect((await db.sql`SELECT did FROM monitored_dids`)).toHaveLength(0);
      const key = await P256Keypair.create();
      const genesis = await signOperation({ type: "plc_operation", prev: null, rotationKeys: [key.did()],
        verificationMethods: {}, services: {}, alsoKnownAs: [] }, key);
      did = await didForCreateOp(genesis);
      const genesisCid = (await cidForCbor(genesis)).toString();
      let log: CompatibleOpOrTombstone[] = [genesis], tick = Date.now(), unavailable = false, corruptAudit = false;
      const auditEpoch=tick;
      let exported: ExportedOpWithSeq[] = [{ did, operation: genesis, cid: genesisCid, seq: 1,
        type: "sequenced_op", createdAt: new Date(tick).toISOString() }];
      const client: MonitorPlcClient = {
        async exportAfter(after, count) { if (unavailable) throw new Error("Offline"); return exported.filter(entry => entry.seq > after).slice(0, count); },
        async getOperationLog() { return log; },
        async getDocumentData() { return (await validateOperationLog(did, log))!; },
         async getAuditableLog() { if(unavailable)throw new Error("Offline");return Promise.all(log.map(async (operation,index) => ({ did, operation,
           cid: corruptAudit ? genesisCid : (await cidForCbor(operation)).toString(), nullified: false, createdAt: new Date(auditEpoch+index*1000).toISOString() }))); },
      };
      const monitor = new PlcMonitor(db.sql, client, () => new Date(tick));
      const reviewed = (await validateOperationLog(did, log))!;
      await expect(monitor.enroll(did, genesisCid, "https://owner.example.com/alerts",
        { ...reviewed, alsoKnownAs: ["at://unreviewed.example.com"] })).rejects.toThrow("Reviewed bootstrap");
      expect((await db.sql`SELECT did FROM monitored_dids`)).toHaveLength(0);
      await monitor.enroll(did, genesisCid, "https://owner.example.com/alerts", reviewed);
      expect((await db.sql<{ last_healthy_at: Date | null }[]>`SELECT last_healthy_at FROM monitor_cursor`)[0]!.last_healthy_at).toBeNull();
      expect(await monitor.poll()).toMatchObject({ state: "current" });
      const signer = new MonitorSigner(generateKeyPairSync("ed25519").privateKey);
      await expect(monitor.attestOnboarding(did, genesisCid, "https://monitor.example.com", signer)).rejects.toThrow("coverage");
      expect(await new MonitorNotifier(db.sql, signer, { async send() { return 204; } }).sendOne()).toBe("sent");
      const onboarding = await monitor.attestOnboarding(did, genesisCid, "https://monitor.example.com", signer);
      expect(await verifyOnboardingMonitorAttestation(onboarding, signer.publicDidKey, Math.floor(tick / 1000))).toMatchObject({
        did, operation_cid: genesisCid, version:2,
      });
      const { sig, ...unsigned } = genesis;
      const updated = await signOperation({ ...unsigned, prev: genesisCid, alsoKnownAs: ["at://approved.example.com"] }, key);
      const updatedCid = (await cidForCbor(updated)).toString();
      log.push(updated); tick += 1000;
      exported.push({ did, operation: updated, cid: updatedCid, seq: 2, type: "sequenced_op", createdAt: new Date(tick).toISOString() });
      expect(await monitor.poll()).toMatchObject({ state: "current", alerts: 1 });
      expect(await new MonitorNotifier(db.sql, signer, { async send() { return 204; } }).sendOne()).toBe("sent");
      await monitor.approveExpected(did, updatedCid, (await validateOperationLog(did, log))!);
      const restarted = new PlcMonitor(db.sql, client, () => new Date(tick));
      const attest = () => restarted.attest(did, randomUUID(), updatedCid, "https://monitor.example.com", signer);
      const rollback = await Bun.file(new URL("../migrations/rollback/0003_backfill_readiness.sql", import.meta.url)).text();
      const applyRollback = async () => {
        const connection = await db.sql.reserve();
        try { await connection.unsafe(rollback); }
        catch (error) { await connection.unsafe("ROLLBACK"); throw error; }
        finally { connection.release(); }
      };
      await expect(applyRollback()).rejects.toThrow("later monitor migrations");
      expect(await restarted.poll()).toMatchObject({ state: "current" });
      const signed = await attest();
      expect(await verifyMonitorAttestation(signed, signer.publicDidKey, Math.floor(tick / 1000), 300)).toMatchObject({
        version: 3, operation_cid: updatedCid, bootstrap_cid: genesisCid });
      const originalCheckpoint = await db.sql<{ operation_cid: string; reviewed_state: unknown }[]>`SELECT operation_cid, reviewed_state FROM monitor_bootstrap_checkpoints WHERE did=${did}`;
      expect(originalCheckpoint[0]!.operation_cid).toBe(genesisCid);
      const storedState = originalCheckpoint[0]!.reviewed_state;
      expect(typeof storedState === "string" ? JSON.parse(storedState) : storedState).toEqual(reviewed);
      tick += 301_000;
      await expect(attest()).rejects.toThrow();
      expect(await restarted.poll()).toMatchObject({ state: "current" });
      unavailable = true;
      expect(await restarted.poll()).toMatchObject({ state: "unavailable" });
      await expect(attest()).rejects.toThrow();
      unavailable = false;
      expect(await restarted.poll()).toMatchObject({ state: "current" });
      corruptAudit = true;
      await expect(attest()).rejects.toThrow("audit");
      corruptAudit = false;
      // Assert cursor-first locking: attestation waits for a currently admitted
      // outage poll and cannot sign using its previously committed caught_up=true.
      let admitted!: () => void, release!: () => void;
      const started = new Promise<void>(resolve => { admitted = resolve; });
      const blocked = new Promise<void>(resolve => { release = resolve; });
      const racingClient = { ...client, async getAuditableLog() { admitted(); await blocked; throw new Error("Offline"); } };
      const racingPoll = new PlcMonitor(db.sql, racingClient, () => new Date(tick)).poll();
      await started;
      let settled = false;
      const refused = expect(attest().finally(() => { settled = true; })).rejects.toThrow("uninterrupted coverage");
      await new Promise(resolve => setTimeout(resolve, 25)); expect(settled).toBe(false);
      release(); expect((await racingPoll).state).toBe("unavailable"); await refused;
      expect(await restarted.poll()).toMatchObject({ state: "current" });
      const fingerprint = async () => Promise.all(["monitored_dids", "monitor_observations", "monitor_alerts", "monitor_approvals", "monitor_cursor"].map(async table => {
        const rows = await db.sql.unsafe(`SELECT to_jsonb(row) - 'caught_up' AS value FROM ${table} row ORDER BY to_jsonb(row)::text`);
        return JSON.stringify(rows);
      }));
      const before = await fingerprint();
      const rollbackNotification = await Bun.file(new URL("../migrations/rollback/0004_onboarding_notification.sql", import.meta.url)).text();
      const connection = await db.sql.reserve();
      try { await expect(connection.unsafe(rollbackNotification)).rejects.toThrow("notification evidence"); }
      finally { await connection.unsafe("ROLLBACK"); connection.release(); }
      await expect(applyRollback()).rejects.toThrow("later monitor migrations"); expect(await fingerprint()).toEqual(before);
      await db.migrate(); expect(await fingerprint()).toEqual(before);
      await expect(attest()).resolves.toHaveProperty("signature");
    } finally {
      await db.migrate();
      if (did) {
        await db.sql`DELETE FROM monitor_bootstrap_checkpoints WHERE did = ${did}`;
        await db.sql`DELETE FROM monitor_alerts WHERE did = ${did}`;
        await db.sql`DELETE FROM monitor_observations WHERE did = ${did}`;
        await db.sql`DELETE FROM monitor_approvals WHERE did = ${did}`;
        await db.sql`DELETE FROM monitored_dids WHERE did = ${did}`;
      }
      await db.sql`UPDATE monitor_cursor SET last_seq = 0, last_healthy_at = NULL, caught_up = false WHERE singleton = true`;
      await db.close();
    }
  }, 30_000);
});
