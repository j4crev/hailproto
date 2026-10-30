import { canaryAccount } from "$lib/server/canary.js";

export async function load({ cookies, url }) {
  const { account, client } = await canaryAccount(cookies, url);
  const result = await client.request("/custom-domains");
  return { account, domains: result.domains as {
    id: string; domain: string; status: string; lastVerifiedAt: string | null;
    challengeExpiresAt: string; verificationName: string; delegationName: string; delegationValue: string;
    ownershipCheckedAt: string | null; delegationCheckedAt: string | null;
  }[], provider: result.provider as string };
}
