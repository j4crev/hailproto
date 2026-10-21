import type { Context, Hono } from "hono";
import { isCoseSign1MediaType } from "../http/media-type.js";
import { GrantReceiveError, type GrantReceiver } from "./receiver.js";

const GRANT_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const MAX_GRANT_BYTES = 262_144;

function problem(status: number, title: string, detail?: string) {
  return detail === undefined
    ? { type: "about:blank", title, status }
    : { type: "about:blank", title, status, detail };
}

function titleFor(status: number): string {
  return (
    {
      400: "Bad Request",
      409: "Conflict",
      412: "Precondition Failed",
      413: "Content Too Large",
      415: "Unsupported Media Type",
      421: "Misdirected Request",
      428: "Precondition Required",
      429: "Too Many Requests",
      503: "Service Unavailable",
    } as Record<number, string>
  )[status] ?? "Bad Request";
}

async function requestBytes(request: Request): Promise<Uint8Array> {
  const declared = request.headers.get("content-length");
  if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > MAX_GRANT_BYTES)) {
    throw new GrantReceiveError(413, "Grant request exceeds its transport limit");
  }
  if (!request.body) return new Uint8Array();
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    length += value.length;
    if (length > MAX_GRANT_BYTES) {
      await reader.cancel();
      throw new GrantReceiveError(413, "Grant request exceeds its transport limit");
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return bytes;
}

export function registerGrantRoutes(
  app: Hono,
  hailServiceBase: string,
  receiver: GrantReceiver,
): void {
  let rateWindowStartedAt = Date.now();
  let requestsInWindow = 0;
  const rateLimit = (): number | null => {
    const now = Date.now();
    if (now - rateWindowStartedAt >= 60_000) {
      rateWindowStartedAt = now;
      requestsInWindow = 0;
    }
    requestsInWindow += 1;
    return requestsInWindow <= 120
      ? null
      : Math.max(1, Math.ceil((60_000 - (now - rateWindowStartedAt)) / 1_000));
  };

  app.all("/hail/grants/:grantId", async (context) => {
    const startedAt = Date.now();
    const headers: Record<string, string> = {
      "Cache-Control": "no-store",
      "Content-Type": "application/problem+json",
    };
    const retryAfter = rateLimit();
    if (retryAfter !== null) {
      return context.json(problem(429, titleFor(429)), 429, {
        ...headers,
        "Retry-After": String(retryAfter),
      });
    }
    if (context.req.method !== "PUT") {
      return context.json(problem(405, "Method Not Allowed"), 405, { ...headers, Allow: "PUT" });
    }
    if (
      !isCoseSign1MediaType(context.req.header("content-type") ?? null) ||
      context.req.header("content-encoding") !== undefined
    ) {
      return context.json(problem(415, titleFor(415)), 415, headers);
    }
    try {
      const grantId = context.req.param("grantId");
      if (!GRANT_ID_PATTERN.test(grantId)) throw new GrantReceiveError(400, "Bad Request", false);
      const result = await receiver.receive(grantId, await requestBytes(context.req.raw), {
        ifMatch: context.req.header("if-match") ?? null,
        ifNoneMatch: context.req.header("if-none-match") ?? null,
      });
      const successHeaders: Record<string, string> = {
        "Cache-Control": "no-store",
        ETag: result.etag,
      };
      if (result.status === 412) {
        return context.json(problem(412, titleFor(412)), 412, {
          ...successHeaders,
          "Content-Type": "application/problem+json",
        });
      }
      if (result.created) successHeaders.Location = `${hailServiceBase}/grants/${grantId}`;
      return new Response(null, { status: result.status, headers: successHeaders });
    } catch (error) {
      const failure =
        error instanceof GrantReceiveError
          ? error
          : new GrantReceiveError(503, "Grant processing is temporarily unavailable");
      if (failure.status === 400 && !failure.disclose) {
        const remaining = 500 - (Date.now() - startedAt);
        if (remaining > 0) await new Promise((resolve) => setTimeout(resolve, remaining));
      }
      return context.json(
        problem(
          failure.status,
          titleFor(failure.status),
          failure.disclose ? failure.message : undefined,
        ),
        failure.status,
        {
          ...headers,
          ...(failure.status === 503 ? { "Retry-After": "30" } : {}),
        },
      );
    }
  });

  const malformedPath = (context: Context) => {
    const headers = { "Cache-Control": "no-store", "Content-Type": "application/problem+json" };
    const retryAfter = rateLimit();
    if (retryAfter !== null) {
      return context.json(problem(429, titleFor(429)), 429, {
        ...headers,
        "Retry-After": String(retryAfter),
      });
    }
    if (context.req.method !== "PUT") {
      return context.json(problem(405, "Method Not Allowed"), 405, { ...headers, Allow: "PUT" });
    }
    if (
      !isCoseSign1MediaType(context.req.header("content-type") ?? null) ||
      context.req.header("content-encoding") !== undefined
    ) {
      return context.json(problem(415, titleFor(415)), 415, headers);
    }
    return context.json(problem(400, "Bad Request"), 400, headers);
  };
  app.all("/hail/grants", malformedPath);
  app.all("/hail/grants/*", malformedPath);
}
