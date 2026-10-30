import type { Context, Hono } from "hono";
import { getCookie } from "hono/cookie";
import type { AccountApiRepository } from "./repository.js";
import { CustomDomainError, type CustomDomains } from "./custom-domains.js";
import { accountRequestBytes } from "./routes.js";
import { parseJsonWithoutDuplicateKeys } from "../discovery/strict-json.js";
import { clientAddress, FixedWindowRateLimit } from "../http/rate-limit.js";
import { withServingGeneration } from "../db/serving.js";

export function registerCustomDomainRoutes(app: Hono, domains: CustomDomains, accounts: AccountApiRepository, origin: string) {
  const ingress = new FixedWindowRateLimit(), authenticated = new FixedWindowRateLimit();
  const handle = async (c: Context) => {
    c.header("Cache-Control", "no-store"); c.header("Vary", "Cookie"); c.header("Referrer-Policy", "no-referrer");
    try {
      if (ingress.take(clientAddress(c.req.raw), 60) !== null) throw new CustomDomainError(429, "Wait before retrying.");
      if (c.req.header("Authorization") || c.req.header("Origin") !== origin &&
        !(c.req.method === "GET" && c.req.header("Origin") === undefined)) throw new CustomDomainError(403, "Request origin refused.");
      const session = await accounts.authenticate(undefined, getCookie(c, "hail_session"));
      if (!session?.passkey_credential_id) return c.json({ error: "Sign in with your passkey first." }, 401);
      if (authenticated.take(session.account_id, 20) !== null) throw new CustomDomainError(429, "Wait before retrying.");
      if (new URL(c.req.url).search) throw new CustomDomainError(400, "Unexpected query parameters.");
      const id = c.req.param("id"), action = c.req.param("action");
      if (!id && c.req.method === "GET") return await withServingGeneration(session.account_id, session.serving_generation ?? 1,
        () => domains.list(session).then(result => c.json(result)));
      if (c.req.method !== "POST") return c.json({ error: "Use POST for this operation." }, 405);
      if (session.migration_state) throw new CustomDomainError(409, "Account is being transferred.");
      if (id && (!/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/.test(id) || !["verify", "remove"].includes(action ?? ""))) {
        throw new CustomDomainError(404, "Operation not found.");
      }
      if (c.req.header("Content-Type") !== "application/json" || c.req.header("Content-Encoding")) return c.json({ error: "Use JSON." }, 415);
      const bytes = await accountRequestBytes(c.req.raw, 2048);
      if (!bytes) return c.json({ error: "Request too large." }, 413);
      let input: Record<string, unknown>;
      try {
        input = parseJsonWithoutDuplicateKeys(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as Record<string, unknown>;
        if (!input || typeof input !== "object" || Array.isArray(input) ||
          (id ? Object.keys(input).length !== 0 : Object.keys(input).join(",") !== "domain" || typeof input.domain !== "string")) throw new Error();
      } catch { throw new CustomDomainError(400, "Invalid domain request."); }
      return await withServingGeneration(session.account_id, session.serving_generation ?? 1, async () =>
        c.json(!id ? await domains.start(session, input.domain as string) : action === "verify" ?
          await domains.verify(session, id) : await domains.removePending(session, id)));
    } catch (error) {
      if (error instanceof CustomDomainError) {
        if (error.status === 429) c.header("Retry-After", "60");
        return c.json({ error: error.message }, error.status);
      }
      return c.json({ error: "Domain operation unavailable. Refresh and try again." }, 503);
    }
  };
  app.all("/api/v1/account/custom-domains", handle);
  app.all("/api/v1/account/custom-domains/:id/:action", handle);
}
