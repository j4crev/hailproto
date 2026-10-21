import { createPrivateKey, createPublicKey, sign, type KeyObject } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { base58btc } from "multiformats/bases/base58";
import { encodeDeterministic, type HailValue } from "@hailproto/codec";

const ALERT_CONTEXT = new TextEncoder().encode("hail.plc-monitor-alert.v1\0");
const COVERAGE_CONTEXT = new TextEncoder().encode("hail.independent-plc-monitor.v1\0");
const REVIEWED_COVERAGE_CONTEXT = new TextEncoder().encode("hail.independent-plc-monitor.v2\0");
const DID_COVERAGE_CONTEXT = new TextEncoder().encode("hail.independent-plc-monitor.v3\0");
const ONBOARDING_COVERAGE_CONTEXT = new TextEncoder().encode("hail.independent-plc-onboarding-monitor.v1\0");
const DID_ONBOARDING_CONTEXT = new TextEncoder().encode("hail.independent-plc-onboarding-monitor.v2\0");

export class MonitorSigner {
  readonly publicDidKey: string;

  constructor(private readonly privateKey: KeyObject) {
    if (privateKey.asymmetricKeyType !== "ed25519") throw new Error("Monitor key must be Ed25519");
    const publicDer = createPublicKey(privateKey).export({ format: "der", type: "spki" });
    if (!Buffer.from(publicDer.subarray(0, 12)).equals(Buffer.from("302a300506032b6570032100", "hex"))) {
      throw new Error("Monitor key has an unexpected Ed25519 public representation");
    }
    const prefixed = new Uint8Array(34);
    prefixed.set([0xed, 0x01]);
    prefixed.set(publicDer.subarray(12), 2);
    this.publicDidKey = `did:key:${base58btc.encode(prefixed)}`;
  }

  static async fromPrivateFile(path: string): Promise<MonitorSigner> {
    const file = await stat(path);
    if (!file.isFile() || (file.mode & 0o077) !== 0 || file.size < 1 || file.size > 4096) {
      throw new Error("Monitor signing key must be a private PKCS8 file of at most 4 KiB");
    }
    return new MonitorSigner(createPrivateKey({ key: await readFile(path), format: "der", type: "pkcs8" }));
  }

  signAlert(bytes: Uint8Array): Uint8Array { return this.sign(ALERT_CONTEXT, bytes); }

  signCoverage(payload: { type: "hail.plc-monitor-attestation"; version: 1 | 2 | 3;
    did: string; transfer_id: string; operation_cid: string; monitor_origin: string;
    coverage_since: number; observed_at: number; bootstrap_cid?: string;
    bootstrap_state_digest?: string; export_sequence?: number }): { payloadBytes: Uint8Array; signature: Uint8Array } {
    const payloadBytes = encodeDeterministic(payload as unknown as HailValue);
    const context=payload.version===3?DID_COVERAGE_CONTEXT:payload.version===2?REVIEWED_COVERAGE_CONTEXT:COVERAGE_CONTEXT;
    return { payloadBytes, signature: this.sign(context, payloadBytes) };
  }

  signOnboardingCoverage(payload: { type: "hail.plc-onboarding-monitor-attestation"; version: 1 | 2;
    did: string; operation_cid: string; monitor_origin: string; coverage_since: number;
    observed_at: number; bootstrap_state_digest: string; export_sequence?: number }): {
      payloadBytes: Uint8Array; signature: Uint8Array } {
    const payloadBytes = encodeDeterministic(payload as unknown as HailValue);
    return { payloadBytes, signature: this.sign(payload.version===2?DID_ONBOARDING_CONTEXT:ONBOARDING_COVERAGE_CONTEXT, payloadBytes) };
  }

  private sign(context: Uint8Array, bytes: Uint8Array): Uint8Array {
    const message = new Uint8Array(context.length + bytes.length);
    message.set(context);
    message.set(bytes, context.length);
    return new Uint8Array(sign(null, message, this.privateKey));
  }
}
