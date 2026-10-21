import { createHash, randomBytes, randomUUID } from "node:crypto";
import { encodeBase64Url } from "@hailproto/codec";
import type { SQL } from "bun";
import { canonicalizeHailAddress } from "../identity/address.js";

export const ALL_ACCOUNT_SCOPES = ["account:read","grants:read","grants:write","credentials:write","messages:read","messages:write","account:write"] as const;
export type AccountApiScope = typeof ALL_ACCOUNT_SCOPES[number];
export interface AccountApiSession {
  account_id: string;
  credential_id: string;
  credential_expires_at: Date;
  did: string;
  canonical_address: string;
  scopes: AccountApiScope[];
  migration_state: "fenced" | "exported" | "retired" | null;
  serving_generation?:number;
}
export const tokenHash = (token: string) => new Uint8Array(createHash("sha256").update(token).digest());
export class CredentialConflictError extends Error {}

export class AccountApiRepository {
  constructor(private readonly sql: SQL) {}

  async issue(address: string, writeGrants = false, suppliedToken?: string, requestedScopes?: AccountApiScope[]) {
    const token = suppliedToken ?? `hailp_${encodeBase64Url(randomBytes(32))}`;
    if (!/^hailp_[A-Za-z0-9_-]{43}$/.test(token)) throw new Error("Invalid API token");
    const id = randomUUID();
    const selected = requestedScopes ?? ["account:read", "grants:read", ...(writeGrants ? ["grants:write" as const] : [])];
    if (!selected.length || new Set(selected).size !== selected.length || selected.some(scope => !ALL_ACCOUNT_SCOPES.includes(scope as AccountApiScope))) {
      throw new Error("Invalid credential scopes");
    }
    const scopes = ALL_ACCOUNT_SCOPES.filter(scope => selected.includes(scope));
    return this.sql.begin(async (tx) => {
      const accounts = await tx<{ id: string }[]>`
        SELECT id FROM provider_accounts WHERE canonical_address = ${canonicalizeHailAddress(address)}
          AND onboarding_state = 'active' AND did IS NOT NULL FOR UPDATE`;
      const account = accounts[0];
      if (!account) throw new Error("API credentials require an existing active account");
      const fenced = await tx`SELECT did FROM provider_migration_fences WHERE account_id = ${account.id}`;
      if (fenced.length) throw new Error("Cannot issue credentials for a migration-fenced account");
      const prior = await tx<{id:string;account_id:string;expires_at:Date;revoked_at:Date|null;scopes:unknown;current_generation:boolean}[]>`
        SELECT c.id,c.account_id,c.expires_at,c.revoked_at,c.scopes,b.generation=g.generation AS current_generation
        FROM account_api_credentials c LEFT JOIN account_credential_generations b ON b.credential_id=c.id
        LEFT JOIN account_serving_generations g ON g.account_id=c.account_id WHERE c.token_hash=${tokenHash(token)}`;
      if (prior[0]) {
        if (prior[0].account_id !== account.id || !prior[0].current_generation || prior[0].revoked_at || prior[0].expires_at.getTime() <= Date.now()) throw new CredentialConflictError("Credential cannot be reused");
        const priorScopes = typeof prior[0].scopes === "string" ? JSON.parse(prior[0].scopes) as AccountApiScope[] : prior[0].scopes as AccountApiScope[];
        if (JSON.stringify([...priorScopes].sort()) !== JSON.stringify([...scopes].sort())) throw new CredentialConflictError("Credential retry changed requested scopes");
        return {credentialId:prior[0].id,accountId:account.id,token,scopes:priorScopes,expiresAt:prior[0].expires_at.toISOString()};
      }
      const rows = await tx<{ expires_at: Date }[]>`
        INSERT INTO account_api_credentials (id, account_id, token_hash, scopes, expires_at)
        VALUES (${id}, ${account.id}, ${tokenHash(token)}, (${JSON.stringify(scopes)}::text)::jsonb,
          now() + interval '30 days') RETURNING expires_at`;
      return { credentialId: id, accountId: account.id, token, scopes, expiresAt: rows[0]!.expires_at.toISOString() };
    });
  }

  async revoke(id: string, accountId?: string): Promise<void> {
    if (!/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/.test(id)) throw new Error("Credential ID must be a canonical UUID");
    const rows = await this.sql`UPDATE account_api_credentials SET revoked_at = COALESCE(revoked_at, now())
      WHERE id = ${id} AND (${accountId ?? null}::uuid IS NULL OR account_id=${accountId ?? null}::uuid) RETURNING id`;
    if (!rows.length) throw new Error("API credential does not exist");
  }

  async listCredentials(session: AccountApiSession, after: string | null) {
    const rows = await this.sql<{ id: string; scopes: AccountApiScope[] | string;
      created_at: Date; expires_at: Date; revoked_at: Date | null; status: string }[]>`
      SELECT id, scopes, created_at, expires_at, revoked_at,
        CASE WHEN revoked_at IS NOT NULL THEN 'revoked' WHEN expires_at <= now() THEN 'expired' ELSE 'active' END AS status
      FROM account_api_credentials WHERE account_id=${session.account_id}
        AND (${after}::uuid IS NULL OR id > ${after}::uuid) ORDER BY id LIMIT 51`;
    return { credentials: rows.slice(0, 50).map(row => ({ credentialId: row.id,
      scopes: typeof row.scopes === "string" ? JSON.parse(row.scopes) as AccountApiScope[] : row.scopes,
      createdAt: row.created_at.toISOString(), expiresAt: row.expires_at.toISOString(),
      revokedAt: row.revoked_at?.toISOString() ?? null, status: row.status })),
      next: rows.length > 50 ? rows[49]!.id : null };
  }

  async authenticate(header: string | undefined): Promise<AccountApiSession | null> {
    const token = /^Bearer (hailp_[A-Za-z0-9_-]{43})$/i.exec(header ?? "")?.[1];
    if (!token) return null;
    const rows = await this.sql<(Omit<AccountApiSession, "scopes"> & { scopes: unknown })[]>`
      SELECT account.id AS account_id, credential.id AS credential_id,
        credential.expires_at AS credential_expires_at, account.did, account.canonical_address,
        credential.scopes, fence.state AS migration_state,generation.generation::integer AS serving_generation
      FROM account_api_credentials credential JOIN provider_accounts account ON account.id = credential.account_id
      JOIN account_credential_generations binding ON binding.credential_id=credential.id
      JOIN account_serving_generations generation ON generation.account_id=account.id AND generation.generation=binding.generation
      LEFT JOIN provider_migration_fences fence ON fence.account_id = account.id
      WHERE credential.token_hash = ${tokenHash(token)} AND credential.revoked_at IS NULL
        AND credential.expires_at > now() AND account.onboarding_state = 'active' AND account.did IS NOT NULL`;
    if (!rows[0]) return null;
    const scopes = typeof rows[0].scopes === "string" ? JSON.parse(rows[0].scopes) : rows[0].scopes;
    return { ...rows[0], scopes: scopes as AccountApiScope[] };
  }

  async describe(session: AccountApiSession, provider: string) {
    const custody = await this.sql<{ user_identity_public_key: string; user_recovery_public_key: string;
      monitor_verification_mode: string }[]>`
      SELECT user_identity_public_key, user_recovery_public_key, monitor_verification_mode
      FROM portable_custody_evidence WHERE account_id = ${session.account_id}`;
    const keys = await this.sql<{ role: string; public_key: string }[]>`
      SELECT role, public_key FROM account_keys WHERE account_id = ${session.account_id} ORDER BY role`;
    const identity = keys.find(key => key.role === "hail-identity");
    const rotation = keys.find(key => key.role === "plc-rotation");
    const managed = await this.sql<{owner_recovery_public_key:string;verification_mode:string;managed_profile_version:string}[]>`
      SELECT owner_recovery_public_key,verification_mode,managed_profile_version
      FROM managed_custody_evidence WHERE account_id=${session.account_id}`;
    const profile = managed[0] && identity ? "managed" : custody[0] && !identity ? "owner-controlled" : !custody[0] && identity && rotation ?
      "custodial-poc" : "unknown";
    return { type: "hailp.account", version: 1, provider, accountId: session.account_id,
      did: session.did, address: session.canonical_address, migrationState: session.migration_state,
      custodyProfile: profile, monitorVerificationMode: managed[0]?.verification_mode ?? custody[0]?.monitor_verification_mode ?? null,
      managedProfileVersion: managed[0]?.managed_profile_version ?? null,
      identityPublicKey: custody[0]?.user_identity_public_key ?? identity?.public_key ?? null,
      ownerRecoveryPublicKey: managed[0]?.owner_recovery_public_key ?? custody[0]?.user_recovery_public_key ?? null, scopes: session.scopes,
      credential: { credentialId: session.credential_id, expiresAt: session.credential_expires_at.toISOString() } };
  }

  async isManaged(accountId: string) { return (await this.sql`SELECT account_id FROM managed_custody_evidence WHERE account_id=${accountId}`).length === 1; }

  async listGrants(session: AccountApiSession, after: string | null) {
    const rows = await this.sql<{ grant_id: string; local_role: string; grantor_did: string;
      grantee_did: string; current_revision: number; current_status: string; expires_at: number | null }[]>`
      SELECT lineage.grant_id, CASE WHEN lineage.local_account_id = ${session.account_id}
        THEN lineage.local_role ELSE 'grantee' END AS local_role, lineage.grantor_did,lineage.grantee_did,
        lineage.current_revision,lineage.current_status,revision.expires_at
      FROM grant_lineages lineage JOIN grant_revisions revision ON revision.grant_id=lineage.grant_id
        AND revision.revision=lineage.current_revision
      WHERE (lineage.local_account_id=${session.account_id} OR EXISTS (
        SELECT 1 FROM collocated_grant_receivers local WHERE local.grant_id=lineage.grant_id
          AND local.grantee_account_id=${session.account_id}))
        AND (${after}::uuid IS NULL OR lineage.grant_id > ${after}::uuid)
      ORDER BY lineage.grant_id LIMIT 51`;
    return { grants: rows.slice(0,50).map(row => ({ grantId: row.grant_id, localRole: row.local_role,
      grantor: row.grantor_did, grantee: row.grantee_did, revision: row.current_revision,
      status: row.current_status, expiresAt: row.expires_at === null ? null : Number(row.expires_at) })),
      next: rows.length > 50 ? rows[49]!.grant_id : null };
  }
}
