import {expect, it} from "vitest";
import {render} from "svelte/server";
import AccountSecurity from "./AccountSecurity.svelte";
import {load} from "../routes/settings/security/+page.server.js";

it("keeps passkey and session management gated by fresh verification", () => {
  for (const recentlyVerified of [false, true]) {
    const {body} = render(AccountSecurity, {props: {data: {recentlyVerified, passkeys: [], sessions: [{id: "session-1", label: "This browser", createdAt: "2026-10-29T12:00:00Z", lastSeenAt: "2026-10-29T12:00:00Z", current: true}]}}});
    expect(body).toContain('Sign-in &amp; security');
    expect(body).toContain('Account sessions');
    const checkbox = body.match(/<input[^>]*type="checkbox"[^>]*>/)?.[0];
    expect(checkbox).toBeDefined();
    expect(checkbox?.includes('disabled')).toBe(!recentlyVerified);
    expect(body).not.toContain('<h1');
    expect(body.includes('Verify with your current passkey before adding')).toBe(!recentlyVerified);
    expect(/<button[^>]*disabled[^>]*>Add passkey<\/button>/.test(body)).toBe(!recentlyVerified);
    expect(/<button[^>]*disabled[^>]*>Sign out everywhere<\/button>/.test(body)).toBe(!recentlyVerified);
  }
});
it("redirects old security bookmarks to Account and preserves query parameters", () => {
  expect(() => load({url: new URL('https://example.com/settings/security?fresh=1')} as never)).toThrow(
    expect.objectContaining({status: 303, location: '/account?fresh=1#security'}),
  );
});
