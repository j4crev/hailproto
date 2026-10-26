import {expect, it, vi} from "vitest";
import {senderSubscription} from "./server/subscription.js";

const payload = {grant_id: "current", grantor: "owner", grantee: "sender", status: "active", revision: 3,
  expires_at: null, scope: [{type: "categories", values: ["general", "news"]}], consent_context: {grantee_address: "sender@example.com"}};
function client(pages: unknown[], override = {}) {
  const request = vi.fn(); for (const page of pages) request.mockResolvedValueOnce(page);
  return {request, grant: vi.fn().mockResolvedValue({localRole: "grantor", digest: "digest", payload: {...payload, ...override}})};
}
it("finds the current sender subscription across pages, ignoring unrelated and received Grants", async () => {
  const api = client([{grants: [{grantId: "unrelated", localRole: "grantor", grantee: "other", status: "active"},
    {grantId: "received", localRole: "grantee", grantee: "sender", status: "active"}], next: "cursor"},
    {grants: [{grantId: "current", localRole: "grantor", grantee: "sender", status: "active"}], next: null}]);
  expect(await senderSubscription(api as never, "owner", "sender")).toMatchObject({grantId: "current", revision: 3, scope: payload.scope[0]});
  expect(api.request).toHaveBeenLastCalledWith("/grants?after=cursor");
  expect(api.grant).toHaveBeenCalledExactlyOnceWith("current");
});
it("does not offer expired or unsubscribed permissions", async () => {
  expect(await senderSubscription(client([{grants: [], next: null}]) as never, "owner", "sender")).toBeNull();
  const row = {grantId: "current", localRole: "grantor", grantee: "sender", status: "active"};
  for (const override of [{status: "revoked"}, {expires_at: 1}]) {
    expect(await senderSubscription(client([{grants: [row], next: null}], override) as never, "owner", "sender")).toBeNull();
  }
});
it("fails closed on identity mismatch, lookup failure, and repeated pagination", async () => {
  const row = {grantId: "current", localRole: "grantor", grantee: "sender", status: "active"};
  for (const override of [{grantor: "other"}, {grantee: "other"}]) {
    await expect(senderSubscription(client([{grants: [row], next: null}], override) as never, "owner", "sender")).rejects.toThrow("identity mismatch");
  }
  await expect(senderSubscription(client([{grants: [], next: "loop"}, {grants: [], next: "loop"}]) as never, "owner", "sender")).rejects.toThrow("cursor");
  const api = client([]);api.request.mockRejectedValue(new Error("Offline"));
  await expect(senderSubscription(api as never, "owner", "sender")).rejects.toThrow("Offline");
});
