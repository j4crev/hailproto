import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { cidForCbor } from "@atproto/common";
import { def, validateOperationLog } from "@did-plc/lib";
import type { SQL } from "bun";
import { parseJsonWithoutDuplicateKeys } from "../discovery/strict-json.js";
import type { IndependentPlcObserver, CutoverAssessment } from "./cutover-gate.js";
import { validateTransferManifest } from "./transfer.js";
import { assertPrivatePocRegistry } from "./poc-profile.js";

// This checks one canonical *private* PLC log for a POC, not two independent
// public mirrors or an independently operated monitor. Never use it for a
// public PLC DID or label its observation as production finality.
export class PrivatePocCutoverGate {
  constructor(private readonly sql: SQL, private readonly observer: IndependentPlcObserver,
    private readonly registryOrigin: string, private readonly destinationBase: string,
    private readonly now: () => Date = () => new Date()) {
    assertPrivatePocRegistry(registryOrigin, destinationBase);
    if (observer.origin !== registryOrigin) throw new Error("POC observer must read the configured private PLC");
  }

  async assess(transferId: string): Promise<CutoverAssessment> {
    const rows = await this.sql<{ did: string; state: string; manifest_bytes: Uint8Array;
      signed_plc_operation_bytes: Uint8Array | null }[]>`
      SELECT did, state, manifest_bytes, signed_plc_operation_bytes
      FROM pending_migration_imports WHERE transfer_id = ${transferId}`;
    const staged = rows[0];
    if (!staged || staged.state !== "staged" || !staged.signed_plc_operation_bytes) {
      throw new Error("Private POC cutover requires an inactive staged user-signed operation");
    }
    const manifest = validateTransferManifest(staged.manifest_bytes);
    const custody = manifest.tables.portable_custody_evidence[0]!;
    if (custody.monitor_verification_mode !== "poc-local" || manifest.did !== staged.did ||
      manifest.destinationServiceBase !== this.destinationBase) {
      throw new Error("Only a labeled private POC identity may use the single-directory gate");
    }
    const signed = def.operation.parse(parseJsonWithoutDuplicateKeys(
      new TextDecoder("utf-8", { fatal: true }).decode(staged.signed_plc_operation_bytes)));
    const expectedCid = (await cidForCbor(signed)).toString();
    const [resolved, audit] = await Promise.all([
      this.observer.resolver.resolve(manifest.did), this.observer.audit(manifest.did),
    ]);
    const log = resolved.evidence.log.map((op) => def.compatibleOpOrTombstone.parse(op));
    const result = await validateOperationLog(manifest.did, log);
    const last = log.at(-1);
    const cid = last ? (await cidForCbor(last)).toString() : null;
    const audited = audit.at(-1);
    const state = result as { rotationKeys: string[]; alsoKnownAs: string[] } | null;
    const sourceState = manifest.tables.plc_operation_evidence.at(-1)?.expected_state;
    const original = (typeof sourceState === "string" ?
      parseJsonWithoutDuplicateKeys(sourceState) : sourceState) as { alsoKnownAs?: unknown } | undefined;
    if (!result || !last || cid !== expectedCid ||
      !isDeepStrictEqual(result, resolved.evidence.data) ||
      !audited || audited.did !== manifest.did || audited.cid !== expectedCid || audited.nullified ||
      resolved.did !== manifest.did || resolved.serviceBase !== this.destinationBase ||
      resolved.messagingDidKey !== manifest.destinationMessagingPublicKey ||
      resolved.identityDidKey !== custody.user_identity_public_key ||
      !state || state.rotationKeys[0] !== custody.user_recovery_public_key ||
      !state.rotationKeys.slice(1).includes(manifest.destinationRotationPublicKey) ||
      state.rotationKeys.some((key) => manifest.tables.account_keys.some((old) =>
        old.role === "plc-rotation" && old.public_key === key)) ||
      !original || !isDeepStrictEqual(state.alsoKnownAs, original.alsoKnownAs)) {
      throw new Error("Private PLC has not confirmed the exact current non-nullified user cutover");
    }
    const now = this.now();
    const digest = new Uint8Array(createHash("sha256")
      .update("hail.private-poc.no-independent-monitor.v1").digest());
    return this.sql.begin(async (tx) => {
      const existing = await tx<{ operation_cid: string; first_seen_at: Date;
        assessment_profile: string }[]>`
        SELECT operation_cid, first_seen_at, assessment_profile
        FROM portable_cutover_observations WHERE transfer_id = ${transferId} FOR UPDATE`;
      if (existing[0] && (existing[0].operation_cid !== expectedCid ||
        existing[0].assessment_profile !== "private-poc")) {
        throw new Error("POC observation conflicts with a prior cutover assessment");
      }
      const first = existing[0]?.first_seen_at ?? now;
      await tx`INSERT INTO portable_cutover_observations
        (transfer_id, did, operation_cid, first_seen_at, last_seen_at,
         mirror_origins, monitor_attestation_digest, state, assessment_profile)
        VALUES (${transferId}, ${manifest.did}, ${expectedCid}, ${first}, ${now},
          ${JSON.stringify([this.registryOrigin])}::jsonb, ${digest}, 'eligible', 'private-poc')
        ON CONFLICT (transfer_id) DO UPDATE SET last_seen_at = EXCLUDED.last_seen_at,
          state = 'eligible' WHERE portable_cutover_observations.assessment_profile = 'private-poc'`;
      return { eligible: true, operationCid: expectedCid, firstSeenAt: first,
        earliestEligibleAt: first };
    });
  }
}
