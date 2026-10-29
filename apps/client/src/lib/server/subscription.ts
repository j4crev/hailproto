import type {AccountApiClient} from "../../../../cli/src/account-api.js";

// Resolve by verified DID, not the message's display address or historic Grant.
export async function senderSubscription(client: Pick<AccountApiClient, "request" | "grant">, owner: string, sender: string) {
  let after: string | null = null;
  const seen = new Set<string>();
  for (let pageNumber = 0; pageNumber < 100; pageNumber++) {
    const page = await client.request(`/grants?sender=${encodeURIComponent(sender)}${after ? `&after=${encodeURIComponent(after)}` : ""}`);
    if (!Array.isArray(page.grants) || page.next !== null && typeof page.next !== "string") throw new Error("Invalid subscriptions response");
    for (const row of page.grants) {
      if (row.localRole !== "grantor" || row.grantee !== sender || row.status !== "active") continue;
      const grant = await client.grant(row.grantId), payload = grant.payload;
      if (grant.localRole !== "grantor" || payload.grantor !== owner || payload.grantee !== sender) throw new Error("Subscription identity mismatch");
      if (payload.status !== "active" || payload.expires_at !== null && payload.expires_at * 1000 <= Date.now()) continue;
      return {grantId: payload.grant_id, revision: payload.revision, digest: grant.digest,
        sender: payload.consent_context.grantee_address, did: payload.grantee, scope: payload.scope[0]};
    }
    if (page.next === null) return null;
    if (!page.next || seen.has(page.next)) throw new Error("Invalid subscriptions cursor");
    after = page.next; seen.add(after);
  }
  throw new Error("Subscription lookup limit reached");
}
