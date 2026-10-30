import {expect, it, vi} from "vitest";
import {AccountApiError} from "../../../../packages/hail-client-support/src/account-api.js";
const fixture = vi.hoisted(() => ({profile: vi.fn(), account: {did: 'did:plc:' + 'a'.repeat(24), address: 'alice@example.com'}}));
vi.mock("$lib/server/canary.js", () => ({ORIGIN: "https://example.com", canaryAccount: async () => ({account: fixture.account, client: {profile: fixture.profile}})}));
import {load} from "../routes/categories/+page.server.js";

it("offers setup only for an absent profile, not authorization or provider errors", async () => {
  fixture.profile.mockRejectedValue(new AccountApiError(404));
  const result = await load({} as never);
  expect(result).toMatchObject({revision: 0, definition: {version: 2, offers_uncategorized: false, categories: [{id: "general", label: "General"}]}});
  for (const status of [401, 403, 503]) {
    fixture.profile.mockRejectedValue(new AccountApiError(status));
    await expect(load({} as never)).rejects.toMatchObject({status});
  }
});
it("loads the current revision and rejects a profile belonging to someone else", async () => {
  const payload = {did: fixture.account.did, version: 1, revision: 4, display_name: "Alice", offers_uncategorized: true, categories: [{id: "news", label: "News"}]};
  fixture.profile.mockResolvedValue({payload});
  expect(await load({} as never)).toMatchObject({revision: 4, definition: {version: 1, display_name: "Alice", offers_uncategorized: true, categories: payload.categories}});
  fixture.profile.mockResolvedValue({payload: {...payload, did: 'did:plc:' + 'b'.repeat(24)}});
  await expect(load({} as never)).rejects.toThrow("another account");
});
