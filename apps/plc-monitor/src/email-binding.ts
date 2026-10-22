import { decodeBase64Url } from "@hailproto/codec/base64url";
import { CID } from "multiformats/cid";

export const EMAIL_BINDING_CONTEXT = "hail.plc-monitor-email-binding.v1\0";
export const SIGNUP_ALERT_PATH = "/hail/signup";
export const SIGNUP_BINDING_PATH = "/hail/signup/binding";
export interface MonitorEmailBindingQuery {
  type: "hail.plc-monitor-email-binding"; version: 1;
  signupId: string; signupHash: string; did: string; operationCid: string; issuedAt: number;
}

export function checkEmailBindingQuery(value: unknown, now: number): asserts value is MonitorEmailBindingQuery {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid monitor binding query");
  const row = value as Record<string, unknown>;
  const fields = ["type", "version", "signupId", "signupHash", "did", "operationCid", "issuedAt"];
  if (Object.keys(row).length !== fields.length || fields.some(key => !Object.hasOwn(row, key)) ||
    row.type !== "hail.plc-monitor-email-binding" || row.version !== 1 || typeof row.signupId !== "string" ||
    !/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/.test(row.signupId) || typeof row.signupHash !== "string" ||
    typeof row.did !== "string" || !/^did:plc:[a-z2-7]{24}$/.test(row.did) || typeof row.operationCid !== "string" ||
    typeof row.issuedAt !== "number" || !Number.isSafeInteger(row.issuedAt) || row.issuedAt < now - 300 || row.issuedAt > now + 300)
    throw new Error("Invalid or stale monitor binding query");
  decodeBase64Url(row.signupHash, 32);
  const cid = CID.parse(row.operationCid);
  if (cid.toString() !== row.operationCid || cid.code !== 0x71 || cid.multihash.code !== 0x12 || cid.multihash.digest.length !== 32)
    throw new Error("Invalid genesis CID");
}
