import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { domainToASCII } from "node:url";
import type { SQL } from "bun";
import { canonicalizeHailAddress } from "../identity/address.js";
import { discoverProvider, lookupTxt, type ProviderDiscovery } from "../discovery/delegation.js";
import { tokenHash, type AccountApiSession } from "./repository.js";

export class CustomDomainError extends Error {
  constructor(readonly status: 400 | 403 | 404 | 409 | 429 | 503, message: string) { super(message); }
}

export function canonicalDomain(input: string): string {
  if (/[\s/@:#?%\\]/u.test(input) || input.length > 1024) throw new CustomDomainError(400, "Enter a domain name.");
  const domain = domainToASCII(input).toLowerCase();
  try { canonicalizeHailAddress(`a@${domain}`); }
  catch { throw new CustomDomainError(400, "Enter a public domain name without a scheme, path, or trailing dot."); }
  return domain;
}

interface DomainRow {
  id: string; account_id: string; domain: string; provider_host: string;
  challenge_hash: Uint8Array; challenge_expires_at: Date; challenge_created_at: Date;
  next_check_at: Date; verified_at: Date | null;
  ownership_checked_at: Date | null; delegation_checked_at: Date | null;
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
  private readonly host: string;
  constructor(private readonly sql: SQL, origin: string,
    private readonly txt: typeof lookupTxt = lookupTxt,
    private readonly discover: ProviderDiscovery = discoverProvider) { this.host = new URL(origin).hostname; }

  private async writer(tx: SQL, session: AccountApiSession) {
    if (!session.passkey_credential_id || session.migration_state) throw new CustomDomainError(403, "Sign in with a current passkey session.");
    const rows = await tx`SELECT id FROM provider_accounts WHERE id=${session.account_id} AND did=${session.did}
      AND canonical_address=${session.canonical_address} AND onboarding_state='active'
      AND activation_verification_mode='public' FOR UPDATE`;
    if (!rows.length || session.canonical_address.split("@")[1] !== this.host) {
      throw new CustomDomainError(403, "Manage domains from an active native-domain account.");
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
}
