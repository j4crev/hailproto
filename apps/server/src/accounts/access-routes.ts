import type { Hono } from "hono";
import { ProtectedResponseSchedule } from "../http/protected-schedule.js";
import { TransferRateLimit } from "../migration/rate-limit.js";
import { parseJsonWithoutDuplicateKeys } from "../discovery/strict-json.js";
import { accountRequestBytes } from "./routes.js";
import type { AccountAccess } from "./access.js";
import type { SQL } from "bun";

export function registerAccountAccess(app: Hono, access: AccountAccess, sql: SQL) {
  const limits = new TransferRateLimit(sql), schedule = new ProtectedResponseSchedule();
  for (const operation of ["prepare", "complete"] as const) app.all(`/api/v1/account-access/${operation}`, async context => {
    context.header("Cache-Control", "no-store");
    if (!await limits.admit(operation === "prepare" ? "access-prepare" : "access-complete")) {
      context.header("Retry-After", "60"); return context.json({ error: "Account access unavailable" }, 429);
    }
    if (context.req.method !== "POST") return context.json({ error: "Use POST" }, 405);
    if (new URL(context.req.url).search || context.req.header("Content-Type") !== "application/json" ||
      context.req.header("Content-Encoding") !== undefined) return context.json({ error: "Use uncoded JSON without query" }, 415);
    const bytes = await accountRequestBytes(context.req.raw);
    if (!bytes || bytes.length > 16_384) return context.json({ error: "Request too large" }, 413);
    let input: Record<string, unknown>;
    try {
      input = parseJsonWithoutDuplicateKeys(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as Record<string, unknown>;
      if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Invalid object");
    } catch { return context.json({ error: "Invalid account-access request" }, 400); }
    if (operation === "prepare") {
      try { return context.json(await access.prepare(input)); }
      catch { return context.json({ error: "Account access unavailable; retain state" }, 401); }
    }
    if (Object.keys(input).length !== 3 || Object.keys(input).some(k => !["challengeId", "token", "signature"].includes(k)) ||
      typeof input.challengeId !== "string" || typeof input.token !== "string" || typeof input.signature !== "string") return context.json({ error: "Invalid proof" }, 400);
    const { challengeId, token, signature } = input;
    const result = await schedule.run(signal => access.complete(challengeId, token, signature, signal));
    if (result.kind === "busy") { context.header("Retry-After", "1"); return context.json({ error: "Account access unavailable" }, 429); }
    return result.kind === "detailed" ? context.json({ credential: result.value }) :
      context.json({ error: "Account access unavailable; retain state" }, 401);
  });
}
