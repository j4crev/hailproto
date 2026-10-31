import type { SQL } from "bun";
import { discoverProvider, type ProviderDiscovery } from "../discovery/delegation.js";

export class CustomDomainAuthorityError extends Error {
  constructor(readonly status:409|503,message:string){super(message);}
}

// Call within the publication transaction to hold the domain registration lock.
export async function requireCustomDomainAuthority(tx:SQL,accountId:string,address:string,origin:string,
  discover:ProviderDiscovery=discoverProvider) {
  const domain=address.split("@")[1]!,host=new URL(origin).hostname;
  if(domain===host)return; // Native publication does not depend on DNS delegation.
  // Original account admission establishes provenance. The administrator's
  // login, generation and expired issuance token do not control this identity.
  const registered=await tx`SELECT domain.id FROM account_custom_domains domain
    JOIN custom_address_authorizations capability ON capability.domain_id=domain.id
    JOIN account_signup_ceremonies ceremony ON ceremony.id=capability.signup_id
    WHERE domain.domain=${domain} AND domain.provider_host=${host} AND domain.verified_at IS NOT NULL
      AND capability.provider_origin=${origin} AND capability.canonical_address=${address}
      AND capability.consumed_at IS NOT NULL AND ceremony.account_id=${accountId}
      AND ceremony.request_digest=capability.request_digest FOR SHARE OF domain`;
  if(!registered.length)throw new CustomDomainAuthorityError(409,"Custom address has no registered domain authority");
  let provider:string|null;
  try {provider=await discover(domain,AbortSignal.timeout(10_000));}
  catch {throw new CustomDomainAuthorityError(503,"DNS delegation could not be checked; retry the same publication");}
  if(provider!==host)throw new CustomDomainAuthorityError(409,"Custom domain must currently delegate to this provider");
}
