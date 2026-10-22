import type { Hono } from "hono";
import type { SQL } from "bun";
import { timingSafeEqual } from "node:crypto";
import { decodeBase64Url, encodeBase64Url } from "@hailproto/codec/base64url";
import { tokenHash } from "../accounts/repository.js";
import { accountRequestBytes } from "../accounts/routes.js";
import { parseJsonWithoutDuplicateKeys } from "../discovery/strict-json.js";
import { clientAddress, FixedWindowRateLimit } from "../http/rate-limit.js";
import { boundedTransferBody } from "../migration/wire.js";

export interface SignupEmailConfig { origin: string; token: string; }
class SignupEmailError extends Error {
  constructor(readonly status: number, readonly retry?: string) { super("Signup email request refused"); }
}
const uuid = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/;

export class SignupEmailClient {
  constructor(private readonly config: SignupEmailConfig, private readonly request: typeof fetch = fetch) {
    const url = new URL(config.origin);
    if (url.protocol !== "https:" || url.origin !== config.origin) throw new Error("Signup email requires a canonical HTTPS Worker origin");
    decodeBase64Url(config.token, 32);
  }
  async post(step: "start" | "verify" | "bind", input: Record<string, unknown>, token: string) {
    const path = step === "start" ? "/signup-email" : `/signup-email/${step}`;
    try {
      const response = await this.request(`${this.config.origin}${path}`, { method: "POST", redirect: "error", signal: AbortSignal.timeout(10_000),
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${this.config.token}` },
        body: JSON.stringify({ ...input, signupHash: encodeBase64Url(tokenHash(token)) }) });
      if (!response.ok) {
        await response.body?.cancel();
        const retry = response.headers.get("Retry-After");
        throw new SignupEmailError([400, 409, 429].includes(response.status) ? response.status : 503,
          retry && /^\d{1,5}$/.test(retry) ? retry : undefined);
      }
      const bytes = await boundedTransferBody(response.body, response.headers.get("Content-Length"), 4096);
      const value = parseJsonWithoutDuplicateKeys(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as Record<string, unknown>;
      if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();
      if (step === "bind") {
        if (Object.keys(value).length !== 3 || value.bound !== true || value.did !== input.did || value.operationCid !== input.operationCid) throw new Error();
      } else if (Object.keys(value).length !== 2 || typeof value.verified !== "boolean" || !Number.isSafeInteger(value.expiresAt)) throw new Error();
      return value;
    } catch (error) {
      if (error instanceof SignupEmailError) throw error;
      throw new SignupEmailError(503);
    }
  }
}

export function registerSignupEmailRoutes(app: Hono, sql: SQL, client: SignupEmailClient, browserOrigin: string) {
  const rate = new FixedWindowRateLimit();
  app.all("/api/v1/signup-email/:step", async context => {
    context.header("Cache-Control", "no-store");
    if (context.req.method !== "POST") return context.json({ error: "Use POST" }, 405);
    if (context.req.header("Origin") !== browserOrigin) return context.json({ error: "Signup origin refused" }, 403);
    const retry = rate.take(clientAddress(context.req.raw), 10);
    if (retry !== null) { context.header("Retry-After", String(retry)); return context.json({ error: "Rate limited" }, 429); }
    if (context.req.header("Content-Type") !== "application/json" || context.req.header("Content-Encoding") !== undefined)
      return context.json({ error: "Use uncoded JSON" }, 415);
    const token = /^Bearer (hailp_[A-Za-z0-9_-]{43})$/.exec(context.req.header("Authorization") ?? "")?.[1];
    if (!token) return context.json({ error: "Signup capability required" }, 401);
    const step = context.req.param("step");
    if (step !== "start" && step !== "verify" && step !== "bind") return context.json({ error: "Unknown signup email operation" }, 404);
    let input: Record<string, unknown>;
    try {
      const bytes = await accountRequestBytes(context.req.raw, 4096);
      if (!bytes) return context.json({ error: "Request too large" }, 413);
      input = parseJsonWithoutDuplicateKeys(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as Record<string, unknown>;
      const allowed = step === "start" ? ["signupId", "email", "resend"] : step === "verify" ? ["signupId", "code"] : ["signupId", "accountId"];
      if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).some(key => !allowed.includes(key)) ||
        typeof input.signupId !== "string" || !uuid.test(input.signupId)) throw new Error();
      if (step === "start" && (typeof input.email !== "string" || input.email.length > 254 || input.resend !== undefined && typeof input.resend !== "boolean") ||
        step === "verify" && (typeof input.code !== "string" || !/^\d{8}$/.test(input.code)) ||
        step === "bind" && (typeof input.accountId !== "string" || !uuid.test(input.accountId))) throw new Error();
    } catch { return context.json({ error: "Invalid signup email request" }, 400); }
    try {
      if (step === "bind") {
        // Never accept a browser-selected DID/CID. Bind only an alpha genesis
        // retained after owner signature verification and public read-back.
        const row = (await sql<{ did: string; operation_cid: string; signup_token_hash: Uint8Array }[]>`
          SELECT account.did,evidence.operation_cid,preparation.signup_token_hash FROM provider_accounts account
          JOIN public_onboarding_preparations preparation ON preparation.account_id=account.id
          JOIN plc_operation_evidence evidence ON evidence.account_id=account.id AND evidence.previous_cid IS NULL
          WHERE account.id=${input.accountId as string} AND account.did=evidence.did
            AND account.onboarding_state IN ('did-registered','address-staged','active')
            AND preparation.custody_profile='managed' AND preparation.monitor_assurance='reduced-assurance-alpha-v1'`)[0];
        const expected = tokenHash(token);
        if (!row?.signup_token_hash || row.signup_token_hash.length !== expected.length ||
          !timingSafeEqual(Buffer.from(row.signup_token_hash), Buffer.from(expected))) return context.json({ error: "Signup identity refused" }, 403);
        return context.json(await client.post("bind", { signupId: input.signupId, did: row.did, operationCid: row.operation_cid }, token));
      }
      return context.json(await client.post(step, input, token));
    } catch (error) {
      if (error instanceof SignupEmailError) {
        if (error.retry) context.header("Retry-After", error.retry);
        return new Response(JSON.stringify({ error: "Signup email request refused; retry or check your code" }),
          { status: error.status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store", ...(error.retry ? { "Retry-After": error.retry } : {}) } });
      }
      return context.json({ error: "Signup email service unavailable" }, 503);
    }
  });
}
