import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import type { SQL } from "bun";
import { canonicalizeHailAddress } from "../identity/address.js";
import { discoverProvider, lookupTxt, type ProviderDiscovery } from "../discovery/delegation.js";
import { tokenHash, type AccountApiSession } from "./repository.js";

export { CustomDomainError, canonicalDomain } from "./domain-proof.js";
import { CustomDomainError, canonicalDomain } from "./domain-proof.js";
import { StandaloneDomains } from "./standalone-domains.js";

interface DomainRow {
  id: string; account_id: string; domain: string; provider_host: string;
  challenge_hash: Uint8Array; challenge_expires_at: Date; challenge_created_at: Date;
  next_check_at: Date; verified_at: Date | null;
  ownership_checked_at: Date | null; delegation_checked_at: Date | null;
}

interface AddressAuthorization {
  id: string; domain_id: string; account_id: string; account_generation: number | string;
  provider_origin: string; canonical_address: string; token_hash: Uint8Array;
  issued_at: Date; expires_at: Date; signup_id: string | null;
  signup_token_hash: Uint8Array | null; request_digest: Uint8Array | null; consumed_at: Date | null;
}

function summary(row: DomainRow) {
  return { id: row.id, domain: row.domain, provider: row.provider_host,
    status: row.verified_at ? "verified" : row.challenge_expires_at.getTime() <= Date.now() ? "expired" : "pending",
    challengeExpiresAt: row.challenge_expires_at.toISOString(), lastVerifiedAt: row.verified_at?.toISOString() ?? null,
    ownershipCheckedAt: row.ownership_checked_at?.toISOString() ?? null,
    delegationCheckedAt: row.delegation_checked_at?.toISOString() ?? null,
    verificationName: `_hail-domain-verify.${row.domain}`,
    delegationName: `_hail-provider.${row.domain}`, delegationValue: `v=hail1; provider=${row.provider_host}` };
}

export class CustomDomains {
  readonly standalone: StandaloneDomains;
  private readonly host: string;
  private readonly origin: string;
  constructor(private readonly sql: SQL, origin: string,
    private readonly txt: typeof lookupTxt = lookupTxt,
    private readonly discover: ProviderDiscovery = discoverProvider) {
    this.host = new URL(origin).hostname; this.origin = new URL(origin).origin;
    this.standalone = new StandaloneDomains(sql, this.origin, txt, discover);
  }

  private async writer(tx: SQL, session: AccountApiSession) {
    if (!session.passkey_credential_id || session.migration_state) throw new CustomDomainError(403, "Sign in with a current passkey session.");
    const rows = await tx`SELECT id FROM provider_accounts WHERE id=${session.account_id} AND did=${session.did}
      AND canonical_address=${session.canonical_address} AND onboarding_state='active'
      AND activation_verification_mode='public' FOR UPDATE`;
    if (!rows.length) {
      throw new CustomDomainError(403, "Manage domains from an active account.");
    }
    await tx`SELECT hail_assert_unfenced_account(${session.account_id}::uuid)`;
  }

  async list(session: AccountApiSession) {
    const rows = await this.sql<DomainRow[]>`SELECT * FROM account_custom_domains WHERE account_id=${session.account_id} ORDER BY created_at,id`;
    return { domains: rows.map(summary), provider: this.host };
  }

  async start(session: AccountApiSession, input: string) {
    const domain = canonicalDomain(input);
    if (domain === this.host) throw new CustomDomainError(400, "The provider's native domain is already managed by the provider.");
    const token = randomBytes(32).toString("base64url"), hash = tokenHash(token);
    return this.sql.begin(async tx => {
      await this.writer(tx, session);
      const current = (await tx<DomainRow[]>`SELECT * FROM account_custom_domains WHERE account_id=${session.account_id} AND domain=${domain}`)[0];
      if (current?.verified_at) return { ...summary(current), verificationValue: null };
      if ((await tx`SELECT id FROM account_custom_domains WHERE domain=${domain} AND verified_at IS NOT NULL`).length) {
        throw new CustomDomainError(409, "This domain is already registered. Ownership transfer is not supported yet.");
      }
      if (current && current.challenge_created_at.getTime() > Date.now() - 60_000) throw new CustomDomainError(429, "Wait one minute before replacing this challenge.");
      if (!current && (await tx`SELECT id FROM account_custom_domains WHERE account_id=${session.account_id}`).length >= 10) {
        throw new CustomDomainError(429, "Remove an unused pending domain before adding another (limit 10).");
      }
      const row = (await tx<DomainRow[]>`INSERT INTO account_custom_domains
        (id,account_id,domain,provider_host,challenge_hash,challenge_expires_at)
        VALUES (${randomUUID()},${session.account_id},${domain},${this.host},${hash},clock_timestamp()+interval '24 hours')
        ON CONFLICT (account_id,domain) DO UPDATE SET challenge_hash=excluded.challenge_hash,
          challenge_expires_at=excluded.challenge_expires_at,challenge_created_at=clock_timestamp(),
          ownership_checked_at=NULL,delegation_checked_at=NULL
        RETURNING *`)[0]!;
      return { ...summary(row), verificationValue: `hail-domain-verify=${token}` };
    });
  }

  async verify(session: AccountApiSession, id: string) {
    const row = await this.sql.begin(async tx => {
      await this.writer(tx, session);
      const row = (await tx<DomainRow[]>`SELECT * FROM account_custom_domains WHERE id=${id} AND account_id=${session.account_id} FOR UPDATE`)[0];
      if (!row) throw new CustomDomainError(404, "Domain not found.");
      if (row.verified_at) return row; // Consumed challenges cannot claim again.
      if (row.challenge_expires_at.getTime() <= Date.now()) throw new CustomDomainError(409, "Challenge expired. Generate a new challenge.");
      if (row.next_check_at.getTime() > Date.now()) throw new CustomDomainError(429, "Wait one minute before checking DNS again.");
      await tx`UPDATE account_custom_domains SET next_check_at=clock_timestamp()+interval '1 minute' WHERE id=${id}`;
      return row;
    });
    if (row.verified_at) return { ...summary(row), ownership: true, delegation: true };
    const signal = AbortSignal.timeout(10_000);
    let ownership: boolean, delegation: boolean;
    try {
      const [records, provider] = await Promise.all([
        this.txt(`_hail-domain-verify.${row.domain}`, signal), this.discover(row.domain, signal),
      ]);
      // Multiple registration attempts may coexist; only this attempt's token counts.
      ownership = records.some(parts => {
        const match = /^hail-domain-verify=([A-Za-z0-9_-]{43})$/.exec(parts.join(""));
        return !!match && match[0] === parts.join("") && timingSafeEqual(tokenHash(match[1]!), row.challenge_hash);
      });
      delegation = provider === this.host;
    } catch { throw new CustomDomainError(503, "DNS could not be checked. Check the records and retry after one minute."); }
    try {
      return await this.sql.begin(async tx => {
        await this.writer(tx, session);
        const current = (await tx<DomainRow[]>`SELECT * FROM account_custom_domains WHERE id=${id} AND account_id=${session.account_id} FOR UPDATE`)[0];
        if (!current || current.verified_at || !timingSafeEqual(current.challenge_hash, row.challenge_hash) ||
          current.challenge_expires_at.getTime() <= Date.now()) throw new CustomDomainError(409, "The challenge changed or expired. Refresh and try again.");
        const updated = (await tx<DomainRow[]>`UPDATE account_custom_domains SET
          ownership_checked_at=${ownership ? new Date() : null}, delegation_checked_at=${delegation ? new Date() : null},
          verified_at=${ownership && delegation ? new Date() : null} WHERE id=${id} RETURNING *`)[0]!;
        return { ...summary(updated), ownership, delegation };
      });
    } catch (error) {
      const postgres = error as { code?: string; errno?: string };
      if (postgres.code === "23505" || postgres.errno === "23505") throw new CustomDomainError(409, "This domain is already registered. Ownership transfer is not supported yet.");
      throw error;
    }
  }

  async removePending(session: AccountApiSession, id: string) {
    return this.sql.begin(async tx => {
      await this.writer(tx, session);
      const rows = await tx`DELETE FROM account_custom_domains WHERE id=${id} AND account_id=${session.account_id} AND verified_at IS NULL RETURNING id`;
      if (!rows.length) throw new CustomDomainError(409, "Only pending registrations can be removed in this release.");
      return { removed: true };
    });
  }

  private async available(tx: SQL, address: string) {
    if ((await tx`SELECT 1 FROM provider_accounts WHERE canonical_address=${address}
      UNION ALL SELECT 1 FROM transfer_address_reservations WHERE canonical_address=${address}
      UNION ALL SELECT 1 FROM provider_reserved_names WHERE local_part=split_part(${address}, '@', 1) LIMIT 1`).length) {
      throw new CustomDomainError(409, "This address is already reserved.");
    }
  }

  private async currentDelegation(domain: string) {
    let provider: string | null;
    try { provider = await this.discover(domain, AbortSignal.timeout(10_000)); }
    catch { throw new CustomDomainError(503, "DNS could not be checked. Try again later."); }
    if (provider !== this.host) throw new CustomDomainError(409, "The domain must currently delegate to this provider.");
  }

  /** Read-only preflight; actual signup must still consume inside reservation. */
  async checkAddressAuthorization(token: string, address: string) {
    if(await this.standalone.exists(token))return this.standalone.check(token,address);
    if (!/^haild_[A-Za-z0-9_-]{43}$/.test(token)) throw new CustomDomainError(400, "Invalid address authorization.");
    const rows = await this.sql`SELECT auth.id FROM custom_address_authorizations auth
      JOIN account_custom_domains domain ON domain.id=auth.domain_id AND domain.account_id=auth.account_id
      JOIN provider_accounts owner ON owner.id=auth.account_id
      JOIN account_serving_generations generation ON generation.account_id=owner.id
      WHERE auth.token_hash=${tokenHash(token)} AND auth.canonical_address=${address} AND auth.provider_origin=${this.origin}
        AND auth.consumed_at IS NULL AND auth.expires_at>clock_timestamp() AND domain.verified_at IS NOT NULL
        AND domain.domain=split_part(${address},'@',2) AND domain.provider_host=${this.host}
        AND owner.onboarding_state='active' AND owner.activation_verification_mode='public'
        AND generation.generation=auth.account_generation
        AND NOT EXISTS(SELECT 1 FROM provider_migration_fences fence WHERE fence.account_id=owner.id)`;
    if (!rows.length) throw new CustomDomainError(403, "The address authorization is expired, used, or no longer valid.");
  }

  /** Issue authority for one exact address, not general signup or account access. */
  async authorizeAddress(session: AccountApiSession, domainId: string, input: string) {
    let address: string;
    try { address = canonicalizeHailAddress(input); }
    catch { throw new CustomDomainError(400, "Enter a valid Hail address."); }
    const authorize = async (tx: SQL) => {
      await this.writer(tx, session);
      const domain = (await tx<DomainRow[]>`SELECT * FROM account_custom_domains
        WHERE id=${domainId} AND account_id=${session.account_id} AND verified_at IS NOT NULL FOR UPDATE`)[0];
      if (!domain || domain.provider_host !== this.host || address.split("@")[1] !== domain.domain) {
        throw new CustomDomainError(403, "Choose an address under your verified domain.");
      }
      await this.available(tx, address);
      return domain;
    };
    const domain = await this.sql.begin(tx => authorize(tx));
    await this.currentDelegation(domain.domain); // No transaction is held during issuance DNS.
    const token = `haild_${randomBytes(32).toString("base64url")}`;
    return this.sql.begin(async tx => {
      await authorize(tx); // Recheck after the network boundary.
      const existing = (await tx<AddressAuthorization[]>`SELECT * FROM custom_address_authorizations WHERE canonical_address=${address} FOR UPDATE`)[0];
      if (existing && (existing.account_id !== session.account_id || existing.domain_id !== domainId || existing.provider_origin !== this.origin)) {
        throw new CustomDomainError(409, "This address has authorization under different administration.");
      }
      if (existing?.consumed_at) throw new CustomDomainError(409, "This address authorization has already been used.");
      if (existing && existing.issued_at.getTime() > Date.now() - 60_000) throw new CustomDomainError(429, "Wait one minute before replacing an authorization.");
      if ((!existing || existing.expires_at.getTime() <= Date.now()) && (await tx`SELECT id FROM custom_address_authorizations
        WHERE account_id=${session.account_id} AND consumed_at IS NULL AND expires_at>clock_timestamp()`).length >= 20) {
        throw new CustomDomainError(429, "Too many pending address authorizations. Wait for an authorization to expire.");
      }
      const generation = (await tx<{generation: number | string}[]>`SELECT generation FROM account_serving_generations WHERE account_id=${session.account_id}`)[0];
      if (!generation) throw new CustomDomainError(409, "Account generation is unavailable.");
      const row = (await tx<AddressAuthorization[]>`INSERT INTO custom_address_authorizations
        (id,domain_id,account_id,account_generation,provider_origin,canonical_address,token_hash,issued_at,expires_at)
        VALUES(${randomUUID()},${domainId},${session.account_id},${generation.generation},${this.origin},${address},${tokenHash(token)},
          statement_timestamp(),statement_timestamp()+interval '15 minutes')
        ON CONFLICT(canonical_address) DO UPDATE SET token_hash=excluded.token_hash,issued_at=excluded.issued_at,
          expires_at=excluded.expires_at,account_generation=excluded.account_generation
        RETURNING *`)[0]!;
      return { authorizationId: row.id, address, token, expiresAt: row.expires_at.toISOString() };
    });
  }

  /** Internal signup seam: caller MUST use the same transaction for admission and
   * account reservation. There is deliberately no standalone HTTP redeem route.
   * Exact retries retain the same signup intent even after issuance expiry. */
  async consumeAddressAuthorization(tx: SQL, token: string, addressInput: string,
    signupId: string, signupTokenHash: Uint8Array, requestDigest: Uint8Array) {
    if (!/^haild_[A-Za-z0-9_-]{43}$/.test(token) ||
      !/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/.test(signupId) ||
      signupTokenHash.length !== 32 || requestDigest.length !== 32) throw new CustomDomainError(400, "Invalid address authorization intent.");
    let address: string;
    try { address = canonicalizeHailAddress(addressInput); }
    catch { throw new CustomDomainError(400, "Invalid Hail address."); }
    if(await this.standalone.exists(token,tx))return this.standalone.consume(tx,token,address,signupId,signupTokenHash,requestDigest);
    // Find the owner first, then lock in the same account/domain/authorization
    // order as issuance. No token is consumed before all checks pass.
    const found = (await tx<AddressAuthorization[]>`SELECT * FROM custom_address_authorizations WHERE token_hash=${tokenHash(token)}`)[0];
    if (!found || found.provider_origin !== this.origin || found.canonical_address !== address) throw new CustomDomainError(403, "Address authorization does not match.");
    // Signup is not authenticated as the domain administrator. Admit only the
    // generation recorded in this capability, preserving any caller admission
    // already present. The normal DB guard below rejects stale generations.
    await tx`SELECT set_config('hail.admitted_generations', (
      CASE WHEN coalesce(nullif(current_setting('hail.admitted_generations',true),''),'{}')::jsonb ? ${found.account_id}
        THEN coalesce(nullif(current_setting('hail.admitted_generations',true),''),'{}')::jsonb
        ELSE coalesce(nullif(current_setting('hail.admitted_generations',true),''),'{}')::jsonb
          || jsonb_build_object(${found.account_id}::text,${Number(found.account_generation)}::bigint)
      END)::text,true)`;
    await tx`SELECT hail_assert_unfenced_account(${found.account_id}::uuid)`;
    const owner = (await tx`SELECT a.id FROM provider_accounts a JOIN account_serving_generations g ON g.account_id=a.id
      WHERE a.id=${found.account_id} AND g.generation=${found.account_generation} AND a.onboarding_state='active'
        AND a.activation_verification_mode='public'`)[0];
    const domain = (await tx<DomainRow[]>`SELECT * FROM account_custom_domains WHERE id=${found.domain_id}
      AND account_id=${found.account_id} AND verified_at IS NOT NULL FOR UPDATE`)[0];
    if (!owner || !domain || domain.domain !== address.split("@")[1] || domain.provider_host !== this.host) throw new CustomDomainError(403, "Domain administration authority is no longer current.");
    const row = (await tx<AddressAuthorization[]>`SELECT * FROM custom_address_authorizations WHERE id=${found.id} FOR UPDATE`)[0]!;
    if (!timingSafeEqual(row.token_hash, tokenHash(token))) throw new CustomDomainError(403, "Address authorization was replaced.");
    const result = { authorizationId: row.id, domainId: row.domain_id, address };
    if (row.consumed_at) {
      if (row.signup_id !== signupId || !timingSafeEqual(row.signup_token_hash!, signupTokenHash) ||
        !timingSafeEqual(row.request_digest!, requestDigest)) throw new CustomDomainError(409, "Address authorization already belongs to another signup intent.");
      return result;
    }
    if (row.expires_at.getTime() <= Date.now()) throw new CustomDomainError(409, "Address authorization expired.");
    await this.currentDelegation(domain.domain);
    if (row.expires_at.getTime() <= Date.now()) throw new CustomDomainError(409, "Address authorization expired during verification.");
    await this.available(tx, address);
    await tx`UPDATE custom_address_authorizations SET signup_id=${signupId},signup_token_hash=${signupTokenHash},
      request_digest=${requestDigest},consumed_at=clock_timestamp() WHERE id=${row.id}`;
    return result;
  }
}
