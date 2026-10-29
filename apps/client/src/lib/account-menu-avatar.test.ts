import {beforeEach, expect, it, vi} from "vitest";
const mocks = vi.hoisted(() => ({isConfigured: vi.fn(), canaryAccount: vi.fn(), profile: vi.fn()}));
vi.mock("$lib/server/canary.js", () => mocks);
import {load} from "../routes/+layout.server.js";
const did = "did:plc:aaaaaaaaaaaaaaaaaaaaaaaa";
const payload = {did, version: 2, display_name: "Alice", offers_uncategorized: false, categories: [], assets: {assets: [{data: new Uint8Array([1, 2, 3])}]}};
const run = (path = "/") => load({cookies: {}, url: new URL(path, "https://example.com")} as never);
beforeEach(() => {
  vi.resetAllMocks();
  mocks.isConfigured.mockReturnValue(true);
  mocks.canaryAccount.mockResolvedValue({account: {did}, client: {profile: mocks.profile}});
  mocks.profile.mockResolvedValue({payload});
});
it("supplies the saved avatar to shared navigation on inbox and account pages", async () => {
  for (const path of ["/", "/account", "/settings"]) {
    expect(await run(path)).toEqual({hasAccountSession: true, accountAvatar: {did, src: "data:image/png;base64,AQID"}});
  }
});
it("returns initials fallback after removal, for legacy profiles, or unavailable profiles", async () => {
  for (const version of [1, 2]) {
    mocks.profile.mockResolvedValue({payload: {...payload, version, assets: undefined}});
    expect((await run()).accountAvatar).toBeNull();
  }
  mocks.profile.mockRejectedValue(new Error("Unavailable"));
  expect((await run()).accountAvatar).toBeNull();
});
it("does not expose a different account's avatar", async () => {
  mocks.profile.mockResolvedValue({payload: {...payload, did: "another"}});
  expect((await run()).accountAvatar).toBeNull();
});
it("does not fetch private profiles on signed-out or focused authentication pages", async () => {
  for (const path of ["/?next=%2Faccount", "/auth/login", "/signup", "/signup/recovery"]) await run(path);
  mocks.isConfigured.mockReturnValue(false);
  expect(await run()).toEqual({hasAccountSession: false, accountAvatar: null});
  expect(mocks.canaryAccount).not.toHaveBeenCalled();
});
