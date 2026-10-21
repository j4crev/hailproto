import { cidForCbor } from "@atproto/common";
import { def, validateOperationLog } from "@did-plc/lib";
import type { SQL } from "bun";
import type { PlcDirectoryClient } from "../plc/client.js";
import { parseJsonWithoutDuplicateKeys } from "../discovery/strict-json.js";
import { assertPrivatePocRegistry } from "./poc-profile.js";
import { validateTransferManifest } from "./transfer.js";
import { verifyPortableMigrationConsent } from "./consent.js";

export class PrivatePocPlcSubmission {
  constructor(private readonly sql: SQL, private readonly plc: PlcDirectoryClient,
    registryOrigin: string, serviceBase: string) {
    assertPrivatePocRegistry(registryOrigin, serviceBase);
  }

  async submit(transferId: string): Promise<string> {
    // The import-row lock serializes invalidation/activation with this bounded PLC request.
    return this.sql.begin(async tx=>{
    const rows = await tx<{ did: string; state: string; manifest_bytes: Uint8Array;
      signed_plc_operation_bytes: Uint8Array;user_consent_payload:Uint8Array;user_consent_signature:Uint8Array;user_identity_public_key:string }[]>`
      SELECT did, state, manifest_bytes, signed_plc_operation_bytes,user_consent_payload,user_consent_signature,user_identity_public_key
      FROM pending_migration_imports WHERE transfer_id = ${transferId} FOR UPDATE`;
    const row = rows[0];
    if (!row || row.state !== "staged") throw new Error("POC PLC write requires an inactive staged import");
    const manifest = validateTransferManifest(row.manifest_bytes);
    if (manifest.did !== row.did || manifest.transferId !== transferId ||
      manifest.tables.portable_custody_evidence[0]?.monitor_verification_mode !== "poc-local") {
      throw new Error("POC PLC submission cannot use public cutover custody");
    }
    const op = def.operation.parse(parseJsonWithoutDuplicateKeys(new TextDecoder("utf-8", { fatal: true })
      .decode(row.signed_plc_operation_bytes)));
    const expectedCid = (await cidForCbor(op)).toString();
    const log = await this.plc.getOperationLog(row.did);
    const last = log.at(-1);
    if (!last) throw new Error("Private PLC has no existing DID operation");
    const current = (await cidForCbor(last)).toString();
    if (current === expectedCid) return expectedCid;
    await verifyPortableMigrationConsent({payloadBytes:row.user_consent_payload,signature:row.user_consent_signature},row.user_identity_public_key,Math.floor(Date.now()/1000));
    if (op.prev !== current || !await validateOperationLog(row.did, [...log, op])) {
      throw new Error("Private PLC changed after user approval; cutover requires new user consent");
    }
    try { await this.plc.sendOperation(row.did, op); }
    catch (error) {
      const retry = (await this.plc.getOperationLog(row.did)).at(-1);
      if (!retry || (await cidForCbor(retry)).toString() !== expectedCid) {
        throw new Error("Private PLC cutover write remains ambiguous; retry the exact operation", { cause: error });
      }
    }
    const observed = (await this.plc.getOperationLog(row.did)).at(-1);
    if (!observed || (await cidForCbor(observed)).toString() !== expectedCid) {
      throw new Error("Private PLC did not retain the exact user-signed cutover operation");
    }
    return expectedCid;
    });
  }
}
