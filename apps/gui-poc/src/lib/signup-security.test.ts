import { expect, it, vi } from "vitest";

const { env } = vi.hoisted(() => ({ env: {} as Record<string, string> }));
vi.mock("$env/dynamic/private", () => ({ env }));
import { load } from "../routes/signup/recovery/+page.server.js";
import { handle } from "../hooks.server.js";

it("keeps the recovery preview off by default and preserves nonce CSP while denying connections", async () => {
  const setHeaders = vi.fn();
  expect(() => load({ setHeaders } as never)).toThrow(expect.objectContaining({ status: 404 }));
  env.HAIL_GUI_SIGNUP_PREVIEW = "true";
  try {
    expect(load({ setHeaders } as never)).toEqual({});
    expect(setHeaders).toHaveBeenCalledWith(expect.objectContaining({ "cache-control": "no-store", "referrer-policy": "no-referrer" }));
    const response = await handle({ event: { url: new URL("https://provider.example/signup/recovery") },
      resolve: async () => new Response("preview", { headers: { "content-security-policy": "script-src 'nonce-test'" } }),
    } as never);
    expect(response.headers.get("content-security-policy")).toBe("script-src 'nonce-test', connect-src 'none'; form-action 'none'; frame-ancestors 'none'");
    expect(response.headers.get("cache-control")).toBe("no-store");
  } finally { delete env.HAIL_GUI_SIGNUP_PREVIEW; }
});
