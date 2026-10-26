import { cidForCbor } from "@atproto/common";
import { parseDidKey, P256_JWT_ALG, SECP256K1_JWT_ALG } from "@atproto/crypto";
import { assureValidSig, def, didForCreateOp, validateOperationLog } from "@did-plc/lib";
import { decodeBase64Url, encodeBase64Url } from "@hailproto/codec/base64url";
import { base58btc } from "multiformats/bases/base58";
import { encode as encodeDagCbor } from "@ipld/dag-cbor";
import { SIGNUP_ALERT_PATH, SIGNUP_BINDING_PATH, checkEmailBindingQuery, type MonitorEmailBindingQuery } from "./email-binding.js";
import { authenticated, boundedBody } from "./http.js";
import { assertWebhookUrl, OnboardingMonitorPending, type PlcMonitor } from "./monitor.js";
import type { MonitorSigner } from "./signing.js";
import { parseJsonWithoutDuplicateKeys } from "./strict-json.js";

export interface MonitorEnrollmentConfig {
  token: string; providerOrigin: string; alertOrigin: string; monitorOrigin: string;
  hostname: string; port: number;
}
function origin(value: string | undefined): string {
  if (!value || assertWebhookUrl(value).origin !== value) throw new Error("Enrollment requires canonical HTTPS origins");
  return value;
}

export function monitorEnrollmentConfig(env: Record<string, string | undefined>): MonitorEnrollmentConfig | undefined {
  const names = ["MONITOR_ENROLLMENT_TOKEN", "MONITOR_ENROLLMENT_PROVIDER", "MONITOR_ENROLLMENT_ALERT_ORIGIN", "MONITOR_API_HOST", "MONITOR_API_PORT"];
  if (!names.some(name => env[name])) return undefined;
  if (env.PLC_DIRECTORY_URL !== "https://plc.directory") throw new Error("Automatic public onboarding requires the canonical PLC registry");
  const token = env.MONITOR_ENROLLMENT_TOKEN;
  if (!token) throw new Error("MONITOR_ENROLLMENT_TOKEN is required");
  decodeBase64Url(token, 32);
  const hostname = env.MONITOR_API_HOST || "127.0.0.1", port = Number(env.MONITOR_API_PORT || "3001");
  if (!["127.0.0.1", "0.0.0.0", "::1"].includes(hostname) || !Number.isInteger(port) || port < 1024 || port > 65535 ||
    env.MONITOR_API_PORT && String(port) !== env.MONITOR_API_PORT) throw new Error("Invalid private monitor API listener");
  return { token, hostname, port, providerOrigin: origin(env.MONITOR_ENROLLMENT_PROVIDER),
    alertOrigin: origin(env.MONITOR_ENROLLMENT_ALERT_ORIGIN), monitorOrigin: origin(env.MONITOR_ORIGIN) };
}

// No activation, key export, arbitrary PLC updates or expectation approval API.
export function createMonitorEnrollmentApi(config: MonitorEnrollmentConfig, monitor: PlcMonitor, signer: MonitorSigner,
  request: (url: string, init: RequestInit) => Promise<Response> = fetch) {
  decodeBase64Url(config.token, 32);
  for (const value of [config.providerOrigin, config.alertOrigin, config.monitorOrigin]) origin(value);
  let windowStart = 0, requests = 0;
  const json = (value: unknown, status = 200) => Response.json(value, { status,
    headers: { "Cache-Control": "no-store", ...(status === 202 || status === 429 ? { "Retry-After": "15" } : {}) } });
  return { async fetch(input: Request): Promise<Response> {
    if (new URL(input.url).pathname !== "/api/v1/onboarding") return json({ error: "Not found" }, 404);
    if (input.method !== "POST") return json({ error: "Use POST" }, 405);
    if (!await authenticated(input, config.token)) return json({ error: "Unauthorized enrollment" }, 401);
    const now = Date.now();
    if (now - windowStart >= 60_000) { windowStart = now; requests = 0; }
    if (++requests > 60) return json({ error: "Enrollment rate limited" }, 429);
    if (input.headers.get("Content-Type") !== "application/json" || input.headers.has("Content-Encoding"))
      return json({ error: "Use uncoded JSON" }, 415);
    let query: MonitorEmailBindingQuery, state: NonNullable<Awaited<ReturnType<typeof validateOperationLog>>>;
    try {
      const bytes = await boundedBody(input, 32_768);
      if (!bytes) return json({ error: "Enrollment request exceeds limit" }, 413);
      const row = parseJsonWithoutDuplicateKeys(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as Record<string, unknown>;
      if (!row || typeof row !== "object" || Array.isArray(row) || Object.keys(row).length !== 3 ||
        Object.keys(row).some(key => !["signupId", "signupHash", "operation"].includes(key))) throw new Error();
      const operation = def.operation.strict().parse(row.operation);
      if (encodeDagCbor(operation).length > 7500 || operation.prev !== null || operation.rotationKeys.length !== 2 || operation.alsoKnownAs.length ||
        Object.keys(operation.verificationMethods).length !== 2 || Object.keys(operation.services).length !== 1 ||
        operation.services.hail?.type !== "HailMessaging" || operation.services.hail.endpoint !== `${config.providerOrigin}/hail` ||
        new Set([...operation.rotationKeys, ...Object.values(operation.verificationMethods)]).size !== 4 ||
        operation.rotationKeys.some(key => ![P256_JWT_ALG, SECP256K1_JWT_ALG].includes(parseDidKey(key).jwtAlg))) throw new Error();
      for (const role of ["hail-identity", "hail-messaging"]) {
        const key = operation.verificationMethods[role];
        if (!key?.startsWith("did:key:")) throw new Error();
        const raw = base58btc.decode(key.slice(8));
        if (raw.length !== 34 || raw[0] !== 0xed || raw[1] !== 1) throw new Error();
      }
      // A valid lower-priority provider signature is not owner authorization.
      await assureValidSig([operation.rotationKeys[0]!], operation);
      const did = await didForCreateOp(operation), validated = await validateOperationLog(did, [operation]);
      if (!validated) throw new Error();
      state = validated;
      const candidate = { type: "hail.plc-monitor-email-binding", version: 1, signupId: row.signupId, signupHash: row.signupHash,
        did, operationCid: (await cidForCbor(operation)).toString(), issuedAt: Math.floor(now / 1000) };
      checkEmailBindingQuery(candidate, Math.floor(now / 1000)); query = candidate;
    } catch { return json({ error: "Enrollment requires an exact owner-signed managed genesis" }, 400); }

    // Independently confirm the consumer destination at the pinned receiver.
    // The monitor uses its existing signing key, not the provider's email secret.
    try {
      const bytes = new TextEncoder().encode(JSON.stringify(query));
      const response = await request(`${config.alertOrigin}${SIGNUP_BINDING_PATH}`, { method: "POST", redirect: "error",
        signal: AbortSignal.timeout(10_000), headers: { "Content-Type": "application/json", "X-Hail-Monitor-Key": signer.publicDidKey,
          "X-Hail-Monitor-Signature": encodeBase64Url(signer.signEmailBindingRequest(bytes)) }, body: bytes });
      if (!response.ok) { await response.body?.cancel(); return json({ error: "Verified consumer email binding unavailable" }, response.status === 409 ? 409 : 503); }
      const resultBytes = await boundedBody(response, 4096);
      if (!resultBytes) throw new Error();
      const result = parseJsonWithoutDuplicateKeys(new TextDecoder("utf-8", { fatal: true }).decode(resultBytes)) as Record<string, unknown>;
      if (!result || Object.keys(result).length !== 3 || result.bound !== true || result.did !== query.did || result.operationCid !== query.operationCid) throw new Error();
    } catch { return json({ error: "Consumer email receiver unavailable" }, 503); }
    const status = { did: query.did, operationCid: query.operationCid, monitorOrigin: config.monitorOrigin,
      monitorPublicKey: signer.publicDidKey, monitorAssurance: "reduced-assurance-alpha-v1" };
    try {
      await monitor.enroll(query.did, query.operationCid, `${config.alertOrigin}${SIGNUP_ALERT_PATH}`, state);
      await monitor.pollDid(query.did);
      const signed = await monitor.attestOnboarding(query.did, query.operationCid, config.monitorOrigin, signer);
      return json({ ...status, state: "ready", attestation: { payload: encodeBase64Url(signed.payloadBytes), signature: encodeBase64Url(signed.signature) } });
    } catch (error) {
      if (error instanceof OnboardingMonitorPending) return json({ ...status, state: "awaiting-monitor" }, 202);
      return json({ error: "Retained bootstrap or monitor coverage refused; do not change genesis" }, 409);
    }
  } };
}
