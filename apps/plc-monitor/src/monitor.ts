import { randomUUID } from "node:crypto";
import { isIP } from "node:net";
import { isDeepStrictEqual } from "node:util";
import { cidForCbor } from "@atproto/common";
import { assureValidNextOp, def, validateOperationLog, type DocumentData, type ExportedOp, type IndexedOperation } from "@did-plc/lib";
import type { SQL } from "bun";
import { plcStateDigest, type MonitorPlcClient } from "./plc.js";
import type { MonitorSigner } from "./signing.js";

export interface MonitorPollResult {
  state: "current" | "unavailable" | "invalid-log";
  inspected: number;
  alerts: number;
}

export class PlcMonitor {
  constructor(private readonly sql: SQL, private readonly plc: MonitorPlcClient,
    private readonly now: () => Date = () => new Date()) {}

  async enroll(did: string, expectedCid: string, alertWebhookUrl: string, reviewed?: DocumentData): Promise<void> {
    if (!/^did:plc:[a-z2-7]{24}$/.test(did) || !/^b[a-z2-7]+$/.test(expectedCid)) {
      throw new Error("Monitor DID or expected PLC CID is not canonical");
    }
    assertWebhookUrl(alertWebhookUrl);
    const current = await this.readState(did);
    if (current.cid !== expectedCid) throw new Error("Expected PLC CID does not match current valid state");
    if (reviewed !== undefined && !isDeepStrictEqual(def.documentData.strict().parse(reviewed), current.state)) {
      throw new Error("Reviewed bootstrap checkpoint does not match the complete current PLC state");
    }
    const enrolledAt = this.now();
    await this.sql.begin(async (tx) => {
      await tx`SELECT singleton FROM monitor_cursor WHERE singleton = true FOR UPDATE`;
      await tx`INSERT INTO monitored_dids (did, expected_cid, expected_state, alert_webhook_url,
        enrolled_at, last_verified_cid, last_verified_at, last_audit, coverage_since)
        VALUES (${did}, ${expectedCid}, ${JSON.stringify(current.state)}::jsonb,
          ${alertWebhookUrl}, ${enrolledAt}, ${expectedCid}, ${enrolledAt},
          ${JSON.stringify(current.audit)}::jsonb, ${enrolledAt})`;
      if (reviewed !== undefined) {
        await tx`INSERT INTO monitor_bootstrap_checkpoints (did, operation_cid, reviewed_state, reviewed_at)
          VALUES (${did}, ${expectedCid}, ${JSON.stringify(current.state)}::jsonb, ${enrolledAt})`;
        await this.alert(tx, did, "onboarding-enrollment", `onboarding:${did}:${expectedCid}`,
          { operationCid: expectedCid, enrolledAt: enrolledAt.toISOString() });
      }
    });
  }

  async poll(_legacyCount?:number): Promise<MonitorPollResult> {
    return this.sql.begin(async (tx): Promise<MonitorPollResult> => {
      const now = this.now();
      let alerts = 0;
      let result:MonitorPollResult["state"]="current",inspected=0;
      const monitored = await tx<{ did:string;expected_cid:string;expected_state:unknown;enrolled_at:Date;
        last_polled_at:Date|null;last_audit:unknown }[]>`SELECT did,expected_cid,expected_state,enrolled_at,last_polled_at,last_audit
        FROM monitored_dids ORDER BY did FOR UPDATE`;
      for (const row of monitored) {
        const baseline = row.last_polled_at && row.last_polled_at > row.enrolled_at ? row.last_polled_at : row.enrolled_at;
        if (now.getTime() - baseline.getTime() > 86_400_000) alerts += await this.alert(tx, row.did, "coverage-lost",
          `coverage:${row.did}:${baseline.toISOString()}`,
          { lastHealthyAt: row.last_polled_at?.toISOString() ?? null, enrolledAt: row.enrolled_at.toISOString(), observedAt: now.toISOString() });
        let rawAudit:ExportedOp[];
        try { rawAudit=await this.plc.getAuditableLog(row.did); }
        catch { result=result==="invalid-log"?result:"unavailable";await tx`UPDATE monitored_dids SET poll_ready=false WHERE did=${row.did}`;continue; }
        try {
          const current=await this.readState(row.did,rawAudit);
          const previous=typeof row.last_audit==="string"?JSON.parse(row.last_audit) as ExportedOp[]:row.last_audit as ExportedOp[]|null;
          if(previous)this.assertNoHistoryRegression(previous,current.audit);
          const known=new Set((previous??[]).map(entry=>entry.cid));
          const approvedState=typeof row.expected_state==="string"?JSON.parse(row.expected_state) as DocumentData:row.expected_state;
          const expected=current.cid===row.expected_cid&&isDeepStrictEqual(current.state,approvedState);
          for(const entry of current.audit)if(!known.has(entry.cid)){
            await tx`INSERT INTO monitor_observations (did,cid,seq,operation,expected)
              VALUES (${row.did},${entry.cid},NULL,${JSON.stringify(entry.operation)}::jsonb,${expected})
              ON CONFLICT (did,cid) DO NOTHING`;
            if(entry.cid!==row.expected_cid)alerts+=await this.alert(tx,row.did,"unexpected-operation",`operation:${row.did}:${entry.cid}`,
              {operationCid:entry.cid,expectedCid:row.expected_cid});
            inspected+=1;
          }
          if(!expected)alerts+=await this.alert(tx,row.did,"unexpected-operation",`operation:${row.did}:${current.cid}`,
            {operationCid:current.cid,expectedCid:row.expected_cid});
          await tx`UPDATE monitored_dids SET last_audit=${JSON.stringify(current.audit)}::jsonb,last_polled_at=${now},
            coverage_since=COALESCE(coverage_since,${now}),poll_ready=true,
            last_verified_cid=CASE WHEN ${expected} THEN ${current.cid} ELSE last_verified_cid END,
            last_verified_at=CASE WHEN ${expected} THEN ${now} ELSE last_verified_at END WHERE did=${row.did}`;
        } catch {
          result="invalid-log";
          await tx`UPDATE monitored_dids SET poll_ready=false WHERE did=${row.did}`;
          alerts+=await this.alert(tx,row.did,"invalid-operation-log",`invalid:${row.did}`,
            {observedAt:now.toISOString()});
        }
      }
      await tx`UPDATE monitor_cursor SET caught_up=${result==="current"},
        last_healthy_at=CASE WHEN ${result==="current"} THEN ${now} ELSE last_healthy_at END,updated_at=${now}
        WHERE singleton=true`;
      return {state:result,inspected,alerts};
    });
  }

  // A user-run host's local operator approves the complete reviewed PLC state.
  // A provider-hosted bootstrap monitor cannot treat its own approval as
  // provider-independent user authorization.
  async approveExpected(did: string, cid: string, reviewed: DocumentData): Promise<void> {
    const current = await this.readState(did);
    if (current.cid !== cid || !isDeepStrictEqual(current.state, reviewed)) {
      throw new Error("Reviewed PLC CID or complete expected state does not match the validated log");
    }
    await this.sql.begin(async (tx) => {
      const rows = await tx<{ expected_cid: string }[]>`
        SELECT expected_cid FROM monitored_dids WHERE did = ${did} FOR UPDATE`;
      const previous = rows[0];
      if (!previous || previous.expected_cid === cid) throw new Error("No new monitored operation to approve");
      const observation = await tx<{ cid: string }[]>`
        SELECT cid FROM monitor_observations WHERE did = ${did} AND cid = ${cid}`;
      if (!observation.length) throw new Error("Operation has not been observed in the sequenced export");
      await tx`INSERT INTO monitor_approvals (did, operation_cid, previous_expected_cid, approved_state)
        VALUES (${did}, ${cid}, ${previous.expected_cid}, ${JSON.stringify(reviewed)}::jsonb)`;
      await tx`UPDATE monitored_dids SET expected_cid = ${cid}, expected_state = ${JSON.stringify(reviewed)}::jsonb,
        last_verified_cid = ${cid}, last_verified_at = ${this.now()} WHERE did = ${did}`;
    });
  }

  async attest(did: string, transferId: string, operationCid: string, origin: string,
    signer: MonitorSigner): Promise<{ payloadBytes: Uint8Array; signature: Uint8Array }> {
    if (!/^did:plc:[a-z2-7]{24}$/.test(did) || !/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/.test(transferId) ||
      !/^b[a-z2-7]+$/.test(operationCid) || assertWebhookUrl(origin).origin !== origin) {
      throw new Error("Monitor attestation needs a canonical DID, transfer ID, CID and HTTPS origin");
    }
    const current = await this.readState(did);
    if (current.cid !== operationCid) throw new Error("Monitor cannot attest a noncurrent PLC operation");
    return this.sql.begin(async tx => {
    const rows = await tx<{ expected_cid: string; expected_state: unknown; enrolled_at: Date;
      coverage_since:Date|null;last_polled_at:Date|null;poll_ready:boolean;
      last_audit:unknown;bootstrap_cid: string | null; bootstrap_state: unknown;
      approved: number; notified: number; gaps: number }[]>`
      SELECT watched.expected_cid, watched.expected_state, watched.enrolled_at,
        watched.coverage_since,watched.last_polled_at,watched.poll_ready,watched.last_audit,
        bootstrap.operation_cid AS bootstrap_cid, bootstrap.reviewed_state AS bootstrap_state,
        (SELECT count(*)::int FROM monitor_approvals approved WHERE approved.did = ${did}
          AND approved.operation_cid = ${operationCid}) AS approved,
        (SELECT count(*)::int FROM monitor_alerts alert WHERE alert.did = ${did}
          AND alert.correlation = ${`operation:${did}:${operationCid}`} AND alert.sent_at IS NOT NULL) AS notified,
        (SELECT count(*)::int FROM monitor_alerts alert WHERE alert.did = ${did}
          AND alert.category IN ('coverage-lost', 'export-gap', 'invalid-operation-log')) AS gaps
      FROM monitored_dids watched
      LEFT JOIN monitor_bootstrap_checkpoints bootstrap ON bootstrap.did = watched.did
      WHERE watched.did = ${did} FOR SHARE OF watched
    `;
    const watched = rows[0];
    const expectation = typeof watched?.expected_state === "string"
      ? JSON.parse(watched.expected_state) as DocumentData : watched?.expected_state;
    const retained=typeof watched?.last_audit==="string"?JSON.parse(watched.last_audit) as ExportedOp[]:watched?.last_audit as ExportedOp[]|null;
    const now = this.now();
    if (!watched || watched.expected_cid !== operationCid ||
      !isDeepStrictEqual(current.state, expectation) || !watched.coverage_since || !watched.poll_ready ||
      watched.approved !== 1 || watched.notified < 1 || watched.gaps !== 0 ||
      !watched.last_polled_at || now.getTime() - watched.last_polled_at.getTime() > 300_000 ||
      watched.last_polled_at.getTime() > now.getTime() + 300_000 || watched.enrolled_at.getTime() > now.getTime() + 300_000) {
      throw new Error("Independent monitor approval or uninterrupted coverage is unavailable");
    }
    if(!retained)throw new Error("Independent monitor has no retained DID audit");
    this.assertNoHistoryRegression(retained,current.audit);
    if(!isDeepStrictEqual(retained,current.audit))throw new Error("Independent monitor has not polled the current DID audit");
    const bootstrap = typeof watched.bootstrap_state === "string"
      ? JSON.parse(watched.bootstrap_state) as DocumentData : watched.bootstrap_state as DocumentData;
    return signer.signCoverage({ type: "hail.plc-monitor-attestation", version: watched.bootstrap_cid ? 3 : 1,
      did, transfer_id: transferId, operation_cid: operationCid, monitor_origin: origin,
      coverage_since: Math.floor(watched.coverage_since.getTime() / 1000),
      observed_at: Math.floor(now.getTime() / 1000),
      ...(watched.bootstrap_cid ? { bootstrap_cid: watched.bootstrap_cid, bootstrap_state_digest: plcStateDigest(bootstrap) } : {}) });
    });
  }

  async attestOnboarding(did: string, operationCid: string, origin: string,
    signer: MonitorSigner): Promise<{ payloadBytes: Uint8Array; signature: Uint8Array }> {
    if (!/^did:plc:[a-z2-7]{24}$/.test(did) || !/^b[a-z2-7]+$/.test(operationCid) ||
      assertWebhookUrl(origin).origin !== origin) throw new Error("Onboarding attestation needs a canonical DID, CID and HTTPS origin");
    const current = await this.readState(did);
    if (current.cid !== operationCid) throw new Error("Monitor cannot attest a noncurrent onboarding operation");
    return this.sql.begin(async tx => {
      const watched = (await tx<{ expected_cid: string; expected_state: unknown; enrolled_at: Date;
        coverage_since:Date|null;last_polled_at:Date|null;poll_ready:boolean;
        last_audit:unknown;bootstrap_cid: string | null; bootstrap_state: unknown; gaps: number; notified: number }[]>`
        SELECT watched.expected_cid, watched.expected_state, watched.enrolled_at,
          watched.coverage_since,watched.last_polled_at,watched.poll_ready,watched.last_audit,
          bootstrap.operation_cid AS bootstrap_cid, bootstrap.reviewed_state AS bootstrap_state,
          (SELECT count(*)::int FROM monitor_alerts alert WHERE alert.did = ${did}
            AND alert.category = 'onboarding-enrollment' AND alert.sent_at IS NOT NULL) AS notified,
          (SELECT count(*)::int FROM monitor_alerts alert WHERE alert.did = ${did}
            AND alert.category IN ('coverage-lost', 'export-gap', 'invalid-operation-log')) AS gaps
        FROM monitored_dids watched
        LEFT JOIN monitor_bootstrap_checkpoints bootstrap ON bootstrap.did = watched.did
        WHERE watched.did = ${did} FOR SHARE OF watched
      `)[0];
      const expected = typeof watched?.expected_state === "string" ? JSON.parse(watched.expected_state) : watched?.expected_state;
      const bootstrap = typeof watched?.bootstrap_state === "string" ? JSON.parse(watched.bootstrap_state) : watched?.bootstrap_state;
      const retained=typeof watched?.last_audit==="string"?JSON.parse(watched.last_audit) as ExportedOp[]:watched?.last_audit as ExportedOp[]|null;
      const now = this.now();
      if (!watched || watched.expected_cid !== operationCid || watched.bootstrap_cid !== operationCid ||
        !isDeepStrictEqual(current.state, expected) || !isDeepStrictEqual(current.state, bootstrap) ||
        watched.gaps !== 0 || watched.notified !== 1 || !watched.coverage_since || !watched.poll_ready || !watched.last_polled_at ||
        watched.last_polled_at.getTime() < watched.enrolled_at.getTime() ||
        now.getTime() - watched.last_polled_at.getTime() > 300_000 ||
        watched.last_polled_at.getTime() > now.getTime() + 300_000) {
        throw new Error("Independent onboarding monitor coverage is unavailable");
      }
      if(!retained)throw new Error("Independent onboarding monitor has no retained DID audit");
      this.assertNoHistoryRegression(retained,current.audit);
      if(!isDeepStrictEqual(retained,current.audit))throw new Error("Independent onboarding monitor has not polled the current DID audit");
      return signer.signOnboardingCoverage({ type: "hail.plc-onboarding-monitor-attestation", version: 2,
        did, operation_cid: operationCid, monitor_origin: origin,
        coverage_since: Math.floor(watched.coverage_since.getTime() / 1000),
        observed_at: Math.floor(now.getTime() / 1000), bootstrap_state_digest: plcStateDigest(current.state),
      });
    });
  }

  private async readState(did:string,source?:readonly unknown[]):Promise<{cid:string;state:DocumentData;audit:ExportedOp[]}>{
    const audit=(source??await this.plc.getAuditableLog(did)).map(entry=>def.exportedOp.parse(entry));
    if(!audit.length||audit.length>1000)throw new Error("PLC audit is incomplete or exceeds the monitor limit");
    const history:IndexedOperation[]=[],seen=new Set<string>();let previousTime=-Infinity;
    for(const entry of audit){
      const cid=await cidForCbor(entry.operation),createdAt=new Date(entry.createdAt);
      if(entry.did!==did||cid.toString()!==entry.cid||seen.has(entry.cid)||!Number.isFinite(createdAt.getTime())||createdAt.getTime()<previousTime)
        throw new Error("PLC audit bytes or annotations are invalid");
      const accepted=await assureValidNextOp(did,history.filter(operation=>!operation.nullified),entry.operation,createdAt);
      for(const nullified of accepted.nullified){const prior=history.find(operation=>operation.cid.equals(nullified));if(!prior)throw new Error("PLC audit recovery is incomplete");prior.nullified=true;}
      history.push({did,cid,operation:entry.operation,createdAt,nullified:false});seen.add(entry.cid);previousTime=createdAt.getTime();
    }
    if(history.some((entry,index)=>entry.nullified!==audit[index]!.nullified))throw new Error("PLC audit nullification is invalid");
    const log=history.filter(entry=>!entry.nullified).map(entry=>entry.operation),state=await validateOperationLog(did,log),last=history.filter(entry=>!entry.nullified).at(-1);
    if(!state||!last)throw new Error("PLC audit has no valid current state");
    return {cid:last.cid.toString(),state,audit};
  }

  private assertNoHistoryRegression(previous:readonly ExportedOp[],current:readonly ExportedOp[]):void{
    const byCid=new Map(current.map(entry=>[entry.cid,entry]));
    for(const prior of previous){const next=byCid.get(prior.cid);
      if(!next||prior.did!==next.did||prior.createdAt!==next.createdAt||!isDeepStrictEqual(prior.operation,next.operation)||prior.nullified&&!next.nullified)
        throw new Error("PLC audit history regressed");
    }
  }

  private async alert(tx: SQL, did: string | null, category: string, correlation: string,
    detail: object): Promise<number> {
    const inserted = await tx<{ id: string }[]>`
      INSERT INTO monitor_alerts (id, did, category, correlation, detail)
      VALUES (${randomUUID()}, ${did}, ${category}, ${correlation}, ${JSON.stringify(detail)}::jsonb)
      ON CONFLICT (correlation) DO NOTHING RETURNING id`;
    return inserted.length;
  }
}

export function assertWebhookUrl(value: string): URL {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password || url.hash || url.search ||
    !url.hostname || isIP(url.hostname) !== 0 || url.hostname.length > 253 ||
    url.hostname.split(".").some(label => label.length > 63 || !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label))) {
    throw new Error("Monitor alert destination must be a canonical HTTPS DNS URL");
  }
  return url;
}
