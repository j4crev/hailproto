import { createHash, randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { inspectSignedPayload, type HailGrant } from "@hailproto/codec";
import type { SQL } from "bun";
import type {
  AuthoritativeGrantRevision1,
  AuthoritativeGrantRevocation,
  AuthoritativeGrantUpdate,
  ClaimedPublicationResult,
  GrantConsentEvidence,
  GrantPublicationClaim,
  GrantStore,
  ReceivedGrantRevision,
  SignedGrantRevision,
  SignedGrantRevisionInput,
} from "./store.js";
import { restrictsAuthorization } from "./revision.js";
import { retainPublicGrantAuthority } from "../plc/grant-authority.js";

export class GrantConflictError extends Error {}

interface GrantRow {
  grant_id: string;
  local_account_id: string;
  local_role: SignedGrantRevision["localRole"];
  grantor_did: string;
  grantee_did: string;
  revision: number;
  status: HailGrant["status"];
  issued_at: number | string | bigint;
  grant_updated_at: number | string | bigint;
  expires_at: number | string | bigint | null;
  previous_digest: Uint8Array | null;
  scope_payload: unknown;
  consent_address_binding_sha256: Uint8Array;
  consent_sender_profile_sha256: Uint8Array;
  cose: Uint8Array;
  representation_digest: Uint8Array;
  signing_public_key: string;
  signing_plc_document: unknown;
  signing_plc_data: unknown;
  signing_plc_operation_log: unknown;
  received_at: Date;
}

interface PublicationRow extends GrantRow {
  destination_service_base: string;
  attempt_count: number;
  lease_token: string;
  lease_expires_at: Date;
}

const GRANT_COLUMNS = `
  lineage.grant_id, lineage.local_account_id, lineage.local_role,
  lineage.grantor_did, lineage.grantee_did, revision.revision, revision.status,
  revision.issued_at, revision.updated_at AS grant_updated_at, revision.expires_at,
  revision.previous_digest, revision.scope_payload,
  revision.consent_address_binding_sha256, revision.consent_sender_profile_sha256,
  revision.cose, revision.representation_digest, revision.signing_public_key,
  revision.signing_plc_document, revision.signing_plc_data, revision.signing_plc_operation_log,
  revision.received_at
`;

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  return Buffer.from(left).equals(Buffer.from(right));
}

function safeInteger(value: number | string | bigint, field: string): number {
  const number = Number(value);
  if (!Number.isSafeInteger(number)) throw new Error(`Persisted Grant ${field} is unsafe`);
  return number;
}

function decodedJson(value: unknown): unknown {
  return typeof value === "string" ? JSON.parse(value) : value;
}

function digestValue(payload: HailGrant, field: "address_binding_hash" | "sender_profile_hash") {
  return payload.consent_context[field].value;
}

function grantFromRow(row: GrantRow): SignedGrantRevision {
  const representation = new Uint8Array(row.cose);
  const digest = new Uint8Array(row.representation_digest);
  const computedDigest = createHash("sha256").update(representation).digest();
  const payload = inspectSignedPayload("hail.grant", representation).payload;
  const issuedAt = safeInteger(row.issued_at, "issued_at");
  const updatedAt = safeInteger(row.grant_updated_at, "updated_at");
  const expiresAt = row.expires_at === null ? null : safeInteger(row.expires_at, "expires_at");
  const previous = row.previous_digest === null ? null : new Uint8Array(row.previous_digest);
  const scope = decodedJson(row.scope_payload);

  if (
    !computedDigest.equals(Buffer.from(digest)) ||
    payload.grant_id !== row.grant_id ||
    payload.grantor !== row.grantor_did ||
    payload.grantee !== row.grantee_did ||
    payload.revision !== row.revision ||
    payload.status !== row.status ||
    payload.issued_at !== issuedAt ||
    payload.updated_at !== updatedAt ||
    payload.expires_at !== expiresAt ||
    !isDeepStrictEqual(payload.previous, previous) ||
    !isDeepStrictEqual(payload.scope, scope) ||
    !bytesEqual(
      digestValue(payload, "address_binding_hash"),
      row.consent_address_binding_sha256,
    ) ||
    !bytesEqual(
      digestValue(payload, "sender_profile_hash"),
      row.consent_sender_profile_sha256,
    )
  ) {
    throw new Error("Persisted Grant metadata does not match its exact representation");
  }

  return {
    localAccountId: row.local_account_id,
    localRole: row.local_role,
    payload,
    representation,
    digest,
    signingPublicKey: row.signing_public_key,
    signingPlcEvidence: {
      document: jsonObject(row.signing_plc_document, "signing PLC document"),
      data: jsonObject(row.signing_plc_data, "signing PLC data"),
      log: jsonArray(row.signing_plc_operation_log, "signing PLC operation log"),
    },
    receivedAt: row.received_at,
  };
}

function checkedInput(
  input: SignedGrantRevisionInput,
  expectedRole: SignedGrantRevision["localRole"],
): void {
  if (input.localRole !== expectedRole) throw new Error(`Grant local role must be ${expectedRole}`);
  const parsed = inspectSignedPayload("hail.grant", input.representation).payload;
  const computed = createHash("sha256").update(input.representation).digest();
  if (!computed.equals(Buffer.from(input.digest)) || !isDeepStrictEqual(parsed, input.payload)) {
    throw new Error("Grant payload or digest does not match its exact representation");
  }
}

function assertConsent(payload: HailGrant, evidence: GrantConsentEvidence): void {
  const bindingPayload = inspectSignedPayload("hail.address-binding", evidence.address.representation).payload;
  const profilePayload = inspectSignedPayload(
    "hail.sender-profile",
    evidence.senderProfile.representation,
  ).payload;
  const bindingDigest = createHash("sha256").update(evidence.address.representation).digest();
  const profileDigest = createHash("sha256").update(evidence.senderProfile.representation).digest();
  if (
    evidence.address.address !== payload.consent_context.grantee_address ||
    evidence.address.did !== payload.grantee ||
    evidence.senderProfile.did !== payload.grantee ||
    !isDeepStrictEqual(bindingPayload, evidence.address.binding) ||
    !isDeepStrictEqual(profilePayload, evidence.senderProfile.profile) ||
    bindingPayload.address !== evidence.address.address ||
    bindingPayload.did !== evidence.address.did ||
    profilePayload.did !== evidence.senderProfile.did ||
    !bindingDigest.equals(Buffer.from(evidence.address.digest)) ||
    !profileDigest.equals(Buffer.from(evidence.senderProfile.digest)) ||
    !bytesEqual(digestValue(payload, "address_binding_hash"), evidence.address.digest) ||
    !bytesEqual(digestValue(payload, "sender_profile_hash"), evidence.senderProfile.digest)
  ) {
    throw new Error("Grant consent evidence does not match the signed grant");
  }
}

function scopeJson(payload: HailGrant): string {
  return JSON.stringify(payload.scope);
}

function evidenceJson(value: unknown): string {
  return JSON.stringify(value);
}

function jsonObject(value: unknown, field: string): object {
  const decoded = decodedJson(value);
  if (!decoded || typeof decoded !== "object" || Array.isArray(decoded)) {
    throw new Error(`Persisted ${field} is not an object`);
  }
  return decoded;
}

function jsonArray(value: unknown, field: string): readonly object[] {
  const decoded = decodedJson(value);
  if (!Array.isArray(decoded) || decoded.some((entry) => !entry || typeof entry !== "object" || Array.isArray(entry))) {
    throw new Error(`Persisted ${field} is not an object array`);
  }
  return decoded as object[];
}

function accountParty(payload: HailGrant, role: SignedGrantRevision["localRole"]): string {
  return role === "grantor" ? payload.grantor : payload.grantee;
}

function pairLockKey(payload: HailGrant): string {
  return `hail-grant-pair:${payload.grantor}\n${payload.grantee}`;
}

export class GrantRepository implements GrantStore {
  constructor(private readonly sql: SQL) {}

  async findCurrentByGrantId(grantId: string): Promise<SignedGrantRevision | null> {
    const rows = await this.sql<GrantRow[]>`
      SELECT ${this.sql.unsafe(GRANT_COLUMNS)}
      FROM grant_lineages AS lineage
      JOIN grant_revisions AS revision
        ON revision.grant_id = lineage.grant_id
       AND revision.revision = lineage.current_revision
      WHERE lineage.grant_id = ${grantId}
    `;
    return rows[0] ? grantFromRow(rows[0]) : null;
  }

  async findRevisionByGrantId(grantId:string,revision:number):Promise<SignedGrantRevision|null> {
    const rows=await this.sql<GrantRow[]>`SELECT ${this.sql.unsafe(GRANT_COLUMNS)} FROM grant_lineages AS lineage
      JOIN grant_revisions AS revision ON revision.grant_id=lineage.grant_id
      WHERE lineage.grant_id=${grantId} AND revision.revision=${revision}`;
    return rows[0]?grantFromRow(rows[0]):null;
  }

  async findReceivedForSender(grantId: string, senderDid: string): Promise<SignedGrantRevision | null> {
    const current = await this.findCurrentByGrantId(grantId);
    if (!current || current.payload.grantee !== senderDid) return null;
    if (current.localRole === "grantee") return current;
    const rows = await this.sql<{ grantee_account_id: string }[]>`
      SELECT local.grantee_account_id FROM collocated_grant_receivers local
      JOIN provider_accounts account ON account.id = local.grantee_account_id
      WHERE local.grant_id = ${grantId} AND account.did = ${senderDid}
        AND account.onboarding_state = 'active'`;
    return rows[0] ? { ...current, localAccountId: rows[0].grantee_account_id,
      localRole: "grantee" } : null;
  }

  async findActiveAuthoritativeByDidPair(
    grantorDid: string,
    granteeDid: string,
  ): Promise<SignedGrantRevision | null> {
    const rows = await this.sql<GrantRow[]>`
      SELECT ${this.sql.unsafe(GRANT_COLUMNS)}
      FROM grant_lineages AS lineage
      JOIN grant_revisions AS revision
        ON revision.grant_id = lineage.grant_id
       AND revision.revision = lineage.current_revision
      WHERE lineage.local_role = 'grantor'
        AND lineage.grantor_did = ${grantorDid}
        AND lineage.grantee_did = ${granteeDid}
        AND lineage.current_status = 'active'
      LIMIT 1
    `;
    return rows[0] ? grantFromRow(rows[0]) : null;
  }

  async insertAuthoritativeRevision1(input: AuthoritativeGrantRevision1): Promise<void> {
    const { revision, consent } = input;
    checkedInput(revision, "grantor");
    assertConsent(revision.payload, consent);
    if (revision.payload.revision !== 1 || revision.payload.status !== "active") {
      throw new Error("An authoritative Grant must begin at active revision 1");
    }

    await this.sql.begin(async (transaction) => {
      await transaction`SELECT pg_advisory_xact_lock(hashtextextended(${pairLockKey(revision.payload)}, 0))`;
      const accounts = await transaction<{ did: string | null; onboarding_state: string }[]>`
        SELECT did, onboarding_state FROM provider_accounts
        WHERE id = ${revision.localAccountId} FOR UPDATE
      `;
      const account = accounts[0];
      if (
        !account ||
        account.onboarding_state !== "active" ||
        account.did !== accountParty(revision.payload, "grantor")
      ) {
        throw new Error("Active local grantor account does not match the Grant");
      }

      await transaction`
        INSERT INTO grant_lineages (
          grant_id, local_account_id, local_role, grantor_did, grantee_did,
          current_revision, current_digest, current_status
        ) VALUES (
          ${revision.payload.grant_id}, ${revision.localAccountId}, 'grantor',
          ${revision.payload.grantor}, ${revision.payload.grantee}, 1,
          ${revision.digest}, 'active'
        )
      `;
      await this.insertRevision(transaction, revision);
      await retainPublicGrantAuthority(transaction,revision,consent);
      await transaction`
        INSERT INTO grant_consent_evidence (
          grant_id, revision, grantee_address, binding_cose, binding_digest,
          binding_plc_document, binding_plc_data, binding_plc_operation_log,
          binding_verified_at, profile_revision, profile_cose, profile_digest,
          profile_plc_document, profile_plc_data, profile_plc_operation_log,
          profile_verified_at
        ) VALUES (
          ${revision.payload.grant_id}, 1, ${consent.address.address},
          ${consent.address.representation}, ${consent.address.digest},
          ${evidenceJson(consent.address.plcEvidence.document)}::jsonb,
          ${evidenceJson(consent.address.plcEvidence.data)}::jsonb,
          ${evidenceJson(consent.address.plcEvidence.log)}::jsonb,
          ${consent.address.verifiedAt}, ${consent.senderProfile.profile.revision},
          ${consent.senderProfile.representation}, ${consent.senderProfile.digest},
          ${evidenceJson(consent.senderProfile.plcEvidence.document)}::jsonb,
          ${evidenceJson(consent.senderProfile.plcEvidence.data)}::jsonb,
          ${evidenceJson(consent.senderProfile.plcEvidence.log)}::jsonb,
          ${consent.senderProfile.verifiedAt}
        )
      `;
      await this.insertPublication(transaction, revision.payload, input.destinationServiceBase);
    });
  }

  async appendAuthoritativeRevocation(input: AuthoritativeGrantRevocation): Promise<void> {
    if(input.revision.payload.status!=="revoked")throw new Error("Expected a signed terminal revision");
    return this.appendAuthoritativeUpdate(input);
  }

  async appendAuthoritativeUpdate(input:AuthoritativeGrantUpdate):Promise<void> {
    const { revision } = input;
    checkedInput(revision, "grantor");
    if (
      revision.payload.revision !== input.expectedCurrentRevision + 1 ||
      !revision.payload.previous ||
      !bytesEqual(revision.payload.previous, input.expectedCurrentDigest)
    ) {
      throw new Error("Grant revocation does not follow the expected current revision");
    }

    await this.sql.begin(async (transaction) => {
      await transaction`SELECT id FROM provider_accounts WHERE id=${revision.localAccountId} FOR UPDATE`;
      const currentRows=await transaction<GrantRow[]>`SELECT ${transaction.unsafe(GRANT_COLUMNS)} FROM grant_lineages AS lineage
        JOIN grant_revisions AS revision ON revision.grant_id=lineage.grant_id AND revision.revision=lineage.current_revision
        WHERE lineage.grant_id=${revision.payload.grant_id} FOR UPDATE OF lineage`;
      const current=currentRows[0]?grantFromRow(currentRows[0]):null;
      if(!current||current.localAccountId!==revision.localAccountId||current.localRole!=="grantor"||
        current.payload.status!=="active"||current.payload.issued_at!==revision.payload.issued_at)throw new GrantConflictError("Grant immutable/current state conflicts");
      if(current.signingPublicKey!==revision.signingPublicKey)throw new GrantConflictError("Historical-key reconciliation required for signer changes");
      if(restrictsAuthorization(current.payload,revision.payload)&&!isDeepStrictEqual(current.payload.consent_context,revision.payload.consent_context))throw new GrantConflictError("Restrictions must retain prior consent");
      if(input.consent)assertConsent(revision.payload,input.consent);
      else if(!restrictsAuthorization(current.payload,revision.payload)||!isDeepStrictEqual(current.payload.consent_context,revision.payload.consent_context))throw new GrantConflictError("Fresh consent evidence required");
      const updated = await transaction`
        UPDATE grant_lineages
        SET current_revision = ${revision.payload.revision},
            current_digest = ${revision.digest}, current_status = ${revision.payload.status}, updated_at = now()
        WHERE grant_id = ${revision.payload.grant_id}
          AND local_account_id = ${revision.localAccountId}
          AND local_role = 'grantor'
          AND grantor_did = ${revision.payload.grantor}
          AND grantee_did = ${revision.payload.grantee}
          AND current_status = 'active'
          AND current_revision = ${input.expectedCurrentRevision}
          AND current_digest = ${input.expectedCurrentDigest}
          AND EXISTS (
            SELECT 1 FROM grant_revisions AS current
            WHERE current.grant_id = grant_lineages.grant_id
              AND current.revision = grant_lineages.current_revision
              AND current.updated_at < ${revision.payload.updated_at}
          )
        RETURNING grant_id
      `;
      if (updated.length !== 1) throw new GrantConflictError("Authoritative Grant revision conflict");
      await this.insertRevision(transaction, revision);
      await retainPublicGrantAuthority(transaction,revision,input.consent);
      if(input.consent) {
        const consent=input.consent;
        await transaction`INSERT INTO grant_consent_evidence (grant_id,revision,grantee_address,binding_cose,binding_digest,
          binding_plc_document,binding_plc_data,binding_plc_operation_log,binding_verified_at,profile_revision,profile_cose,profile_digest,
          profile_plc_document,profile_plc_data,profile_plc_operation_log,profile_verified_at)
          VALUES (${revision.payload.grant_id},${revision.payload.revision},${consent.address.address},${consent.address.representation},${consent.address.digest},
            ${evidenceJson(consent.address.plcEvidence.document)}::jsonb,${evidenceJson(consent.address.plcEvidence.data)}::jsonb,${evidenceJson(consent.address.plcEvidence.log)}::jsonb,
            ${consent.address.verifiedAt},${consent.senderProfile.profile.revision},${consent.senderProfile.representation},${consent.senderProfile.digest},
            ${evidenceJson(consent.senderProfile.plcEvidence.document)}::jsonb,${evidenceJson(consent.senderProfile.plcEvidence.data)}::jsonb,
            ${evidenceJson(consent.senderProfile.plcEvidence.log)}::jsonb,${consent.senderProfile.verifiedAt})`;
      }
      const publications = await transaction`
        INSERT INTO grant_publications (grant_id, revision, destination_service_base)
        SELECT ${revision.payload.grant_id}, ${revision.payload.revision}, COALESCE(${input.destinationServiceBase ?? null},destination_service_base)
        FROM grant_publications
        WHERE grant_id = ${revision.payload.grant_id}
        ORDER BY revision
        LIMIT 1
        RETURNING grant_id
      `;
      if (publications.length !== 1) {
        throw new Error("Authoritative Grant is missing its publication destination evidence");
      }
    });
  }

  async acceptReceivedRevision(input: ReceivedGrantRevision): Promise<SignedGrantRevision> {
    const revision: SignedGrantRevisionInput = {
      ...input,
      localRole: "grantee",
    };
    checkedInput(revision, "grantee");

    return this.sql.begin(async (transaction) => {
      await transaction`SELECT pg_advisory_xact_lock(hashtextextended(${pairLockKey(input.payload)}, 0))`;
      const accounts = await transaction<{ did: string | null; onboarding_state: string }[]>`
        SELECT did, onboarding_state FROM provider_accounts
        WHERE id = ${input.localAccountId} FOR UPDATE
      `;
      const account = accounts[0];
      if (!account || account.onboarding_state !== "active" || account.did !== input.payload.grantee) {
        throw new Error("Active local grantee account does not match the Grant");
      }

      const lineages = await transaction<
        {
          local_account_id: string;
          local_role: string;
          grantor_did: string;
          grantee_did: string;
          current_revision: number;
          current_digest: Uint8Array;
          current_status: HailGrant["status"];
        }[]
      >`
        SELECT local_account_id, local_role, grantor_did, grantee_did,
               current_revision, current_digest, current_status
        FROM grant_lineages WHERE grant_id = ${input.payload.grant_id} FOR UPDATE
      `;
      const lineage = lineages[0];
      if (lineage) {
        const collocated = lineage.local_role === "grantor" ? await transaction<{
          grantee_account_id: string }[]>`
            SELECT grantee_account_id FROM collocated_grant_receivers
            WHERE grant_id = ${input.payload.grant_id} FOR UPDATE` : [];
        if (
          !(lineage.local_role === "grantee" && lineage.local_account_id === input.localAccountId ||
            lineage.local_role === "grantor" && collocated[0]?.grantee_account_id === input.localAccountId) ||
          lineage.grantor_did !== input.payload.grantor ||
          lineage.grantee_did !== input.payload.grantee
        ) {
          throw new Error("Grant parties or local ownership cannot change");
        }
        const existing = await transaction<GrantRow[]>`
          SELECT ${transaction.unsafe(GRANT_COLUMNS)}
          FROM grant_lineages AS lineage
          JOIN grant_revisions AS revision ON revision.grant_id = lineage.grant_id
          WHERE lineage.grant_id = ${input.payload.grant_id}
            AND revision.revision = ${input.payload.revision}
        `;
        if (existing[0]) {
          if (!bytesEqual(existing[0].cose, input.representation)) {
            throw new Error("Grant revision conflicts with previously received exact bytes");
          }
          return { ...grantFromRow(existing[0]), localRole: "grantee", localAccountId: input.localAccountId };
        }
        const currentRows = await transaction<{ grant_updated_at: number | string | bigint }[]>`
          SELECT updated_at AS grant_updated_at FROM grant_revisions
          WHERE grant_id = ${input.payload.grant_id} AND revision = ${lineage.current_revision}
        `;
        const current = currentRows[0];
        if (
          lineage.current_status === "revoked" ||
          !current ||
          input.payload.revision !== lineage.current_revision + 1 ||
          !input.payload.previous ||
          !bytesEqual(input.payload.previous, lineage.current_digest) ||
          input.payload.updated_at <= safeInteger(current.grant_updated_at, "updated_at")
        ) {
          throw new Error("Received Grant revision does not advance the current lineage");
        }
        await this.insertRevision(transaction, revision);
        await transaction`
          UPDATE grant_lineages
          SET current_revision = ${input.payload.revision}, current_digest = ${input.digest},
              current_status = ${input.payload.status}, updated_at = now()
          WHERE grant_id = ${input.payload.grant_id}
        `;
      } else {
        if (input.payload.revision !== 1 || input.payload.status !== "active") {
          throw new Error("A received Grant lineage must begin at active revision 1");
        }
        await transaction`
          INSERT INTO grant_lineages (
            grant_id, local_account_id, local_role, grantor_did, grantee_did,
            current_revision, current_digest, current_status
          ) VALUES (
            ${input.payload.grant_id}, ${input.localAccountId}, 'grantee',
            ${input.payload.grantor}, ${input.payload.grantee}, 1,
            ${input.digest}, 'active'
          )
        `;
        await this.insertRevision(transaction, revision);
      }

      await retainPublicGrantAuthority(transaction,revision);
      const rows = await transaction<GrantRow[]>`
        SELECT ${transaction.unsafe(GRANT_COLUMNS)}
        FROM grant_lineages AS lineage
        JOIN grant_revisions AS revision
          ON revision.grant_id = lineage.grant_id
         AND revision.revision = lineage.current_revision
        WHERE lineage.grant_id = ${input.payload.grant_id}
      `;
      if (!rows[0]) throw new Error("Accepted Grant could not be read back");
      return { ...grantFromRow(rows[0]), localRole: "grantee", localAccountId: input.localAccountId };
    });
  }

  async claimDuePublication(
    leaseDurationMs: number,
    now: Date = new Date(),
  ): Promise<GrantPublicationClaim | null> {
    if (!Number.isSafeInteger(leaseDurationMs) || leaseDurationMs <= 0) {
      throw new Error("Publication lease duration must be a positive integer");
    }
    const leaseToken = randomUUID();
    const leaseExpiresAt = new Date(now.getTime() + leaseDurationMs);
    const rows = await this.sql<PublicationRow[]>`
      WITH candidate AS (
        SELECT publication.grant_id, publication.revision
        FROM grant_publications AS publication
        JOIN grant_lineages AS owner ON owner.grant_id = publication.grant_id
        WHERE publication.state IN ('pending', 'retry')
          AND publication.next_attempt_at <= ${now}
          AND (publication.lease_expires_at IS NULL OR publication.lease_expires_at <= ${now})
          AND NOT EXISTS (SELECT 1 FROM provider_migration_fences fence
            WHERE fence.account_id = owner.local_account_id)
          AND NOT EXISTS (
            SELECT 1 FROM grant_publications AS prior
            WHERE prior.grant_id = publication.grant_id
              AND prior.revision < publication.revision
              AND prior.state <> 'acknowledged'
          )
        ORDER BY publication.next_attempt_at, publication.created_at
        FOR UPDATE SKIP LOCKED
        LIMIT 1
      ), claimed AS (
        UPDATE grant_publications AS publication
        SET lease_token = ${leaseToken}, lease_expires_at = ${leaseExpiresAt},
            attempt_count = publication.attempt_count + 1, updated_at = now()
        FROM candidate
        WHERE publication.grant_id = candidate.grant_id
          AND publication.revision = candidate.revision
        RETURNING publication.*
      )
      SELECT ${this.sql.unsafe(GRANT_COLUMNS)}, claimed.destination_service_base,
             claimed.attempt_count, claimed.lease_token, claimed.lease_expires_at
      FROM claimed
      JOIN grant_lineages AS lineage ON lineage.grant_id = claimed.grant_id
      JOIN grant_revisions AS revision
        ON revision.grant_id = claimed.grant_id AND revision.revision = claimed.revision
    `;
    const row = rows[0];
    if (!row) return null;
    return {
      grant: grantFromRow(row),
      destinationServiceBase: row.destination_service_base,
      leaseToken: row.lease_token,
      leaseExpiresAt: row.lease_expires_at,
      attemptCount: row.attempt_count,
    };
  }

  async acknowledgePublication(
    input: ClaimedPublicationResult & { etag: string },
  ): Promise<void> {
    await this.finishPublication(input, "acknowledged", null, input.etag);
  }

  async retryPublication(
    input: ClaimedPublicationResult & { nextAttemptAt: Date },
  ): Promise<void> {
    await this.finishPublication(input, "retry", input.nextAttemptAt, null);
  }

  async blockPublication(input: ClaimedPublicationResult): Promise<void> {
    await this.finishPublication(input, "blocked", null, null);
  }

  private async insertRevision(
    sql: SQL,
    revision: SignedGrantRevisionInput,
  ): Promise<void> {
    const payload = revision.payload;
    await sql`
      INSERT INTO grant_revisions (
        grant_id, revision, status, issued_at, updated_at, expires_at,
        previous_digest, scope_payload, consent_address_binding_sha256,
        consent_sender_profile_sha256, cose, representation_digest, signing_public_key,
        signing_plc_document, signing_plc_data, signing_plc_operation_log
      ) VALUES (
        ${payload.grant_id}, ${payload.revision}, ${payload.status}, ${payload.issued_at},
        ${payload.updated_at}, ${payload.expires_at}, ${payload.previous},
        ${scopeJson(payload)}::jsonb, ${digestValue(payload, "address_binding_hash")},
        ${digestValue(payload, "sender_profile_hash")}, ${revision.representation},
        ${revision.digest}, ${revision.signingPublicKey},
        ${evidenceJson(revision.signingPlcEvidence.document)}::jsonb,
        ${evidenceJson(revision.signingPlcEvidence.data)}::jsonb,
        ${evidenceJson(revision.signingPlcEvidence.log)}::jsonb
      )
    `;
  }

  private async insertPublication(
    sql: SQL,
    payload: HailGrant,
    destinationServiceBase: string,
  ): Promise<void> {
    await sql`
      INSERT INTO grant_publications (grant_id, revision, destination_service_base)
      VALUES (${payload.grant_id}, ${payload.revision}, ${destinationServiceBase})
    `;
  }

  private async finishPublication(
    input: ClaimedPublicationResult,
    state: "acknowledged" | "retry" | "blocked",
    nextAttemptAt: Date | null,
    etag: string | null,
  ): Promise<void> {
    const rows = await this.sql`
      UPDATE grant_publications
      SET state = ${state}, next_attempt_at = COALESCE(${nextAttemptAt}, next_attempt_at),
          lease_token = NULL, lease_expires_at = NULL,
          last_http_status = ${input.httpStatus ?? null}, last_error = ${input.error ?? null},
          acknowledged_etag = ${etag},
          acknowledged_at = CASE WHEN ${state} = 'acknowledged' THEN now() ELSE NULL END,
          updated_at = now()
      WHERE grant_id = ${input.grantId} AND revision = ${input.revision}
        AND lease_token = ${input.leaseToken}
        AND lease_expires_at > now()
        AND state IN ('pending', 'retry')
      RETURNING grant_id
    `;
    if (rows.length !== 1) throw new Error("Publication claim is no longer owned by this lease");
  }
}
