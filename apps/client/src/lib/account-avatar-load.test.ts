import {afterEach, expect, it, vi} from "vitest";
import {AccountApiError} from "../../../cli/src/account-api.js";
const mocks = vi.hoisted(() => ({profile: vi.fn()}));
vi.mock("$lib/server/canary.js", () => ({canaryAccount: async () => ({account: {address: "alice@example.com", did: "did:plc:aaaaaaaaaaaaaaaaaaaaaaaa"}, client: {profile: mocks.profile, request: async () => ({recentlyVerified: false, passkeys: [], sessions: []})}})}));
import {load} from "../routes/account/+page.server.js";
afterEach(() => vi.resetAllMocks());
it("loads the saved avatar and current revision for editing", async () => {
  mocks.profile.mockResolvedValue({payload: {did: "did:plc:aaaaaaaaaaaaaaaaaaaaaaaa", version: 2, revision: 7, display_name: "Alice", offers_uncategorized: false,
    categories: [{id: "general", label: "General"}], assets: {assets: [{data: new Uint8Array([1, 2, 3])}]}}});
  expect(await load({cookies: {}, url: new URL("https://example.com/account")} as never)).toMatchObject({revision: 7, definition: {avatar: "AQID", display_name: "Alice"}});
});
it("only treats a missing profile as new, and refuses mismatched identity", async () => {
  mocks.profile.mockRejectedValue(new AccountApiError(404));
  expect(await load({cookies: {}, url: new URL("https://example.com/account")} as never)).toMatchObject({revision: 0, definition: {display_name: "alice"}});
  mocks.profile.mockRejectedValue(new Error("Unavailable"));
  await expect(load({cookies: {}, url: new URL("https://example.com/account")} as never)).rejects.toThrow("Unavailable");
  mocks.profile.mockResolvedValue({payload: {did: "another"}});
  await expect(load({cookies: {}, url: new URL("https://example.com/account")} as never)).rejects.toThrow("another account");
});
