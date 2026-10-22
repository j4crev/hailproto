import type { Hono } from "hono";
import type { SQL } from "bun";
import { def } from "@did-plc/lib";
import { decodeBase64Url, encodeBase64Url } from "@hailproto/codec/base64url";
import { base58btc } from "multiformats/bases/base58";
import { tokenHash } from "../accounts/repository.js";
import { accountRequestBytes } from "../accounts/routes.js";
import { parseJsonWithoutDuplicateKeys } from "../discovery/strict-json.js";
import { clientAddress, FixedWindowRateLimit } from "../http/rate-limit.js";
import { verifyOnboardingMonitorAttestation } from "../migration/monitor-attestation.js";
import { boundedTransferBody } from "../migration/wire.js";
import { plcStateDigest } from "../plc/read-evidence.js";
import { SignupEmailError, signupIdentity, type SignupEmailClient, type SignupIdentity } from "./email.js";

export interface SignupMonitorConfig { apiOrigin: string; token: string; publicKey: string; }
export class SignupMonitorError extends Error {
  constructor(readonly status: number) { super("Signup monitor request refused"); }
}

export class SignupMonitorClient {
  readonly publicKey: string;
  constructor(private readonly config: SignupMonitorConfig, private readonly request: typeof fetch = fetch) {
    const url = new URL(config.apiOrigin);
    if (url.protocol !== "https:" || url.origin !== config.apiOrigin) throw new Error("Monitor API requires a canonical HTTPS origin");
    decodeBase64Url(config.token, 32);
    const key = config.publicKey.startsWith("did:key:") ? base58btc.decode(config.publicKey.slice(8)) : new Uint8Array();
    if (key.length !== 34 || key[0] !== 0xed || key[1] !== 1) throw new Error("Monitor API requires a pinned Ed25519 public key");
    this.publicKey = config.publicKey;
  }
  async enroll(identity: SignupIdentity, signupId: string, token: string): Promise<{ status: 200 | 202; body: Record<string, unknown> }> {
    try {
      const operation = def.operation.strict().parse(typeof identity.operation === "string" ? parseJsonWithoutDuplicateKeys(identity.operation) : identity.operation);
      const response = await this.request(`${this.config.apiOrigin}/api/v1/onboarding`, { method: "POST", redirect: "error",
        signal: AbortSignal.timeout(20_000), headers: { "Content-Type": "application/json", Authorization: `Bearer ${this.config.token}` },
        body: JSON.stringify({ signupId, signupHash: encodeBase64Url(tokenHash(token)), operation }) });
      if (response.status !== 200 && response.status !== 202) {
        await response.body?.cancel(); throw new SignupMonitorError([400, 409, 429].includes(response.status) ? response.status : 503);
      }
      const bytes = await boundedTransferBody(response.body, response.headers.get("Content-Length"), 16_384);
      const result = parseJsonWithoutDuplicateKeys(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as Record<string, unknown>;
      const ready = response.status === 200;
      if (!result || typeof result !== "object" || Array.isArray(result) || Object.keys(result).length !== (ready ? 7 : 6) ||
        Object.keys(result).some(key => !["state", "did", "operationCid", "monitorOrigin", "monitorPublicKey", "monitorAssurance", ...(ready ? ["attestation"] : [])].includes(key)) ||
        result.state !== (ready ? "ready" : "awaiting-monitor") || result.did !== identity.did || result.operationCid !== identity.operation_cid ||
        result.monitorOrigin !== identity.monitor_origin || result.monitorPublicKey !== this.publicKey || result.monitorAssurance !== "reduced-assurance-alpha-v1") throw new Error();
      if (ready) {
        const attestation = result.attestation as Record<string, unknown>;
        if (!attestation || typeof attestation !== "object" || Object.keys(attestation).length !== 2 ||
          typeof attestation.payload !== "string" || typeof attestation.signature !== "string") throw new Error();
        const report = await verifyOnboardingMonitorAttestation({ payloadBytes: decodeBase64Url(attestation.payload),
          signature: decodeBase64Url(attestation.signature, 64) }, this.publicKey, Math.floor(Date.now() / 1000));
        const state = { did: identity.did, rotationKeys: operation.rotationKeys, verificationMethods: operation.verificationMethods,
          services: operation.services, alsoKnownAs: operation.alsoKnownAs };
        if (report.version !== 2 || report.did !== identity.did || report.operation_cid !== identity.operation_cid ||
          report.monitor_origin !== identity.monitor_origin || report.bootstrap_state_digest !== plcStateDigest(state)) throw new Error();
      }
      return { status: ready ? 200 : 202, body: result };
    } catch (error) {
      if (error instanceof SignupMonitorError) throw error;
      throw new SignupMonitorError(503);
    }
  }
}

export class SignupMonitorService {
  constructor(private readonly sql: SQL, private readonly email: SignupEmailClient, private readonly monitor: SignupMonitorClient) {}
  async enroll(accountId: string, signupId: string, token: string) {
    const identity = await signupIdentity(this.sql, accountId, token);
    if (!identity) throw new SignupMonitorError(403);
    if (identity.monitor_public_key !== this.monitor.publicKey) throw new SignupMonitorError(503);
    await this.email.post("bind", { signupId, did: identity.did, operationCid: identity.operation_cid }, token);
    return this.monitor.enroll(identity, signupId, token);
  }
}

export function registerSignupMonitorRoutes(app: Hono, service: SignupMonitorService, browserOrigin: string) {
  const rate = new FixedWindowRateLimit(), uuid = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/;
  app.post("/api/v1/signup-monitor", async context => {
    context.header("Cache-Control", "no-store");
    if (context.req.header("Origin") !== browserOrigin) return context.json({ error: "Signup origin refused" }, 403);
    const retry = rate.take(clientAddress(context.req.raw), 20);
    if (retry !== null) { context.header("Retry-After", String(retry)); return context.json({ error: "Rate limited" }, 429); }
    const token = /^Bearer (hailp_[A-Za-z0-9_-]{43})$/.exec(context.req.header("Authorization") ?? "")?.[1];
    if (!token) return context.json({ error: "Signup capability required" }, 401);
    if (context.req.header("Content-Type") !== "application/json" || context.req.header("Content-Encoding") !== undefined)
      return context.json({ error: "Use uncoded JSON" }, 415);
    let input: Record<string, unknown>;
    try {
      const bytes = await accountRequestBytes(context.req.raw, 4096);
      if (!bytes) return context.json({ error: "Request too large" }, 413);
      input = parseJsonWithoutDuplicateKeys(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as Record<string, unknown>;
      if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).length !== 2 ||
        typeof input.signupId !== "string" || !uuid.test(input.signupId) || typeof input.accountId !== "string" || !uuid.test(input.accountId)) throw new Error();
    } catch { return context.json({ error: "Invalid signup monitor request" }, 400); }
    try {
      const result = await service.enroll(input.accountId as string, input.signupId as string, token);
      if (result.status === 202) context.header("Retry-After", "15");
      return context.json(result.body, result.status);
    } catch (error) {
      const status = error instanceof SignupMonitorError || error instanceof SignupEmailError ? error.status : 503;
      return new Response(JSON.stringify({ error: "Signup monitoring not completed; retain the original signup state" }), {
        status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store", ...(status === 429 || status === 503 ? { "Retry-After": "15" } : {}) } });
    }
  });
}
