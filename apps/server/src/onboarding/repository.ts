import { createHash } from "node:crypto";
import type { Operation } from "@did-plc/lib";
import { encodeBase64Url, validatePayload, type HailSenderProfile } from "@hailproto/codec";
import type { SQL } from "bun";
import type { StoredAccountKey } from "../identity/keys.js";
import type { DiscoveryStore, PublishedAddressBinding } from "../discovery/store.js";
import type {
  SenderProfileStore,
  StoredSenderProfile,
  VerifiedSenderProfile,
  VerifiedSenderProfileStore,
} from "../profiles/store.js";
import type { PlcResolutionEvidence } from "../plc/resolver.js";
import { retainPublicSigningAuthority } from "../plc/signing-authority.js";

export type OnboardingState =
  | "reserved"
  | "prepared"
  | "submission-unknown"
  | "did-registered"
  | "address-staged"
  | "activating"
  | "active";

export interface AccountRecord {
  id: string;
  tenantId: string;
  canonicalAddress: string;
  did: string | null;
  state: OnboardingState;
  activationAttemptId: string | null;
  activationVerificationMode: "local" | "public" | null;
}

export interface GenesisEvidence {
  id: string;
  did: string;
  operationCid: string;
  registryOrigin: string;
  operationBytes: Uint8Array;
  dagCbor: Uint8Array;
  operation: Operation;
  submissionState: "prepared" | "submission-unknown" | "submitted" | "verified";
}

export interface AccountKeyRecord extends StoredAccountKey {
  accountId: string;
}

interface AccountRow {
  id: string;
  tenant_id: string;
  canonical_address: string;
  did: string | null;
  onboarding_state: OnboardingState;
  activation_attempt_id: string | null;
  activation_verification_mode: "local" | "public" | null;
}

interface EvidenceRow {
  id: string;
  did: string;
  operation_cid: string;
  registry_origin: string;
  signed_operation_bytes: Uint8Array | null;
  dag_cbor: Uint8Array;
  signed_operation: unknown;
  submission_state: GenesisEvidence["submissionState"];
}

interface KeyRow {
  account_id: string;
  role: AccountKeyRecord["role"];
  algorithm: AccountKeyRecord["algorithm"];
  public_key: string;
  encrypted_private_key: Uint8Array;
  encryption_nonce: Uint8Array;
  encryption_version: number;
  kek_id: string;
}

interface BindingRow {
  id: string;
  account_id: string;
  canonical_address: string;
  did: string;
  cose: Uint8Array;
  representation_digest: Uint8Array;
  issued_at: Date;
  expires_at: Date;
  published_at: Date | null;
}

interface SenderProfileRow {
  id: string;
  account_id: string;
  did: string;
  revision: number;
  profile_payload: unknown;
  cose: Uint8Array;
  representation_digest: Uint8Array;
  signing_public_key: string;
  profile_updated_at: number | bigint | string;
  created_at: Date;
}

interface VerifiedSenderProfileRow {
  did: string;
  revision: number;
  profile_updated_at: number | bigint | string;
  profile_payload: unknown;
  cose: Uint8Array;
  representation_digest: Uint8Array;
  service_base: string;
  messaging_public_key: string;
  plc_document: unknown;
  plc_data: unknown;
  plc_operation_log: unknown;
  verified_at: Date;
}

function decodedJson(value: unknown): unknown {
  return typeof value === "string" ? JSON.parse(value) : value;
}

function jsonObject(value: unknown, field: string): object {
  const decoded = decodedJson(value);
  if (!decoded || typeof decoded !== "object" || Array.isArray(decoded)) {
    throw new Error(`${field} is not a JSON object`);
  }
  return decoded;
}

function accountFromRow(row: AccountRow): AccountRecord {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    canonicalAddress: row.canonical_address,
    did: row.did,
    state: row.onboarding_state,
    activationAttemptId: row.activation_attempt_id,
    activationVerificationMode: row.activation_verification_mode,
  };
}

function evidenceFromRow(row: EvidenceRow): GenesisEvidence {
  if (row.signed_operation_bytes === null) {
    throw new Error("Genesis evidence is missing exact operation bytes");
  }
  return {
    id: row.id,
    did: row.did,
    operationCid: row.operation_cid,
    registryOrigin: row.registry_origin,
    operationBytes: new Uint8Array(row.signed_operation_bytes),
    dagCbor: new Uint8Array(row.dag_cbor),
    operation: decodedJson(row.signed_operation) as Operation,
    submissionState: row.submission_state,
  };
}

function bindingFromRow(row: BindingRow): PublishedAddressBinding {
  return {
    id: row.id,
    accountId: row.account_id,
    canonicalAddress: row.canonical_address,
    did: row.did,
    cose: new Uint8Array(row.cose),
    digest: new Uint8Array(row.representation_digest),
    issuedAt: row.issued_at,
    expiresAt: row.expires_at,
    publishedAt: row.published_at,
  };
}

function senderProfileFromRow(row: SenderProfileRow): StoredSenderProfile {
  const payload = decodedJson(row.profile_payload);
  validatePayload("hail.sender-profile", payload);
  const updatedAt = Number(row.profile_updated_at);
  if (!Number.isSafeInteger(updatedAt)) throw new Error("Sender Profile timestamp is unsafe");
  const digest = new Uint8Array(row.representation_digest);
  const computedDigest = createHash("sha256").update(row.cose).digest();
  if (
    payload.did !== row.did ||
    payload.revision !== row.revision ||
    payload.updated_at !== updatedAt ||
    !computedDigest.equals(Buffer.from(digest))
  ) {
    throw new Error("Persisted Sender Profile metadata does not match its representation");
  }
  return {
    id: row.id,
    accountId: row.account_id,
    did: row.did,
    revision: row.revision,
    payload: payload as HailSenderProfile,
    cose: new Uint8Array(row.cose),
    digest,
    signingPublicKey: row.signing_public_key,
    updatedAt,
    createdAt: row.created_at,
  };
}

function verifiedSenderProfileFromRow(row: VerifiedSenderProfileRow): VerifiedSenderProfile {
  const payload = decodedJson(row.profile_payload);
  validatePayload("hail.sender-profile", payload);
  const updatedAt = Number(row.profile_updated_at);
  if (!Number.isSafeInteger(updatedAt)) throw new Error("Sender Profile timestamp is unsafe");
  const digest = new Uint8Array(row.representation_digest);
  const computedDigest = createHash("sha256").update(row.cose).digest();
  if (
    payload.did !== row.did ||
    payload.revision !== row.revision ||
    payload.updated_at !== updatedAt ||
    !computedDigest.equals(Buffer.from(digest))
  ) {
    throw new Error("Retained Sender Profile metadata does not match its representation");
  }
  return {
    did: row.did,
    serviceBase: row.service_base,
    messagingDidKey: row.messaging_public_key,
    profile: payload as HailSenderProfile,
    representation: new Uint8Array(row.cose),
    digest,
    etag: encodeBase64Url(digest),
    plcEvidence: {
      document: jsonObject(row.plc_document, "PLC document evidence"),
      data: jsonObject(row.plc_data, "PLC data evidence"),
      log: (() => {
        const log = decodedJson(row.plc_operation_log);
        if (!Array.isArray(log)) throw new Error("PLC operation log evidence is not an array");
        return log as object[];
      })(),
    },
    verifiedAt: row.verified_at,
  };
}

export class OnboardingRepository
  implements DiscoveryStore, SenderProfileStore, VerifiedSenderProfileStore
{
  constructor(private readonly sql: SQL) {}

  async reserve(canonicalAddress: string): Promise<AccountRecord> {
    const id = crypto.randomUUID();
    const tenantId = crypto.randomUUID();
    const inserted = await this.sql<AccountRow[]>`
      INSERT INTO provider_accounts (
        id, tenant_id, canonical_address, onboarding_state
      )
      VALUES (${id}, ${tenantId}, ${canonicalAddress}, 'reserved')
      ON CONFLICT (canonical_address) DO NOTHING
      RETURNING id, tenant_id, canonical_address, did, onboarding_state,
                activation_attempt_id, activation_verification_mode
    `;
    if (inserted[0]) return accountFromRow(inserted[0]);

    const transferReservation = await this.sql`
      SELECT 1 FROM transfer_address_reservations WHERE canonical_address = ${canonicalAddress}`;
    if (transferReservation.length) throw new Error("Address is held for a provider transfer");

    const existing = await this.sql<AccountRow[]>`
      SELECT id, tenant_id, canonical_address, did, onboarding_state,
             activation_attempt_id, activation_verification_mode
      FROM provider_accounts
      WHERE canonical_address = ${canonicalAddress}
    `;
    if (!existing[0]) throw new Error("Address reservation conflict could not be reconciled");
    return accountFromRow(existing[0]);
  }

  async prepare(
    account: AccountRecord,
    keys: readonly StoredAccountKey[],
    evidence: GenesisEvidence,
    expectedState: object,
  ): Promise<void> {
    await this.sql.begin(async (transaction) => {
      const updated = await transaction`
        UPDATE provider_accounts
        SET did = ${evidence.did}, onboarding_state = 'prepared',
            state_version = state_version + 1, updated_at = now()
        WHERE id = ${account.id} AND onboarding_state = 'reserved' AND did IS NULL
        RETURNING id
      `;
      if (updated.length !== 1) throw new Error("Account is no longer reserved");

      for (const key of keys) {
        await transaction`
          INSERT INTO account_keys (
            account_id, role, algorithm, public_key, encrypted_private_key,
            encryption_nonce, encryption_version, kek_id
          )
          VALUES (
            ${account.id}, ${key.role}, ${key.algorithm}, ${key.publicKey},
            ${key.ciphertext}, ${key.nonce}, ${key.encryptionVersion}, ${key.kekId}
          )
        `;
      }

      await transaction`
        INSERT INTO plc_operation_evidence (
          id, account_id, did, operation_cid, previous_cid, registry_origin,
          signed_operation, signed_operation_bytes, dag_cbor, expected_state,
          submission_state
        )
        VALUES (
          ${evidence.id}, ${account.id}, ${evidence.did}, ${evidence.operationCid},
          NULL, ${evidence.registryOrigin}, ${evidence.operation}::jsonb,
          ${evidence.operationBytes}, ${evidence.dagCbor}, ${expectedState}::jsonb,
          'prepared'
        )
      `;
    });
  }

  async getAccount(accountId: string): Promise<AccountRecord> {
    const rows = await this.sql<AccountRow[]>`
      SELECT id, tenant_id, canonical_address, did, onboarding_state,
             activation_attempt_id, activation_verification_mode
      FROM provider_accounts
      WHERE id = ${accountId}
    `;
    if (!rows[0]) throw new Error("Account does not exist");
    return accountFromRow(rows[0]);
  }

  async getAccountByAddress(canonicalAddress: string): Promise<AccountRecord> {
    const rows = await this.sql<AccountRow[]>`
      SELECT id, tenant_id, canonical_address, did, onboarding_state,
             activation_attempt_id, activation_verification_mode
      FROM provider_accounts
      WHERE canonical_address = ${canonicalAddress}
    `;
    if (!rows[0]) throw new Error("Account does not exist");
    return accountFromRow(rows[0]);
  }

  async getAccountByDid(did: string): Promise<AccountRecord | null> {
    const rows = await this.sql<AccountRow[]>`
      SELECT id, tenant_id, canonical_address, did, onboarding_state,
             activation_attempt_id, activation_verification_mode
      FROM provider_accounts
      WHERE did = ${did}
    `;
    return rows[0] ? accountFromRow(rows[0]) : null;
  }

  async getGenesis(accountId: string): Promise<GenesisEvidence> {
    const rows = await this.sql<EvidenceRow[]>`
      SELECT id, did, operation_cid, registry_origin, signed_operation_bytes,
             dag_cbor, signed_operation, submission_state
      FROM plc_operation_evidence
      WHERE account_id = ${accountId} AND previous_cid IS NULL
    `;
    if (!rows[0]) throw new Error("Genesis evidence does not exist");
    return evidenceFromRow(rows[0]);
  }

  async getKey(accountId: string, role: AccountKeyRecord["role"]): Promise<AccountKeyRecord> {
    const rows = await this.sql<KeyRow[]>`
      SELECT account_id, role, algorithm, public_key, encrypted_private_key,
             encryption_nonce, encryption_version, kek_id
      FROM account_keys
      WHERE account_id = ${accountId} AND role = ${role}
    `;
    const row = rows[0];
    if (!row) throw new Error(`Account key ${role} does not exist`);
    if (row.encryption_version !== 1 || row.kek_id !== "poc-v1") {
      throw new Error("Unsupported encrypted key envelope");
    }
    return {
      accountId: row.account_id,
      role: row.role,
      algorithm: row.algorithm,
      publicKey: row.public_key,
      ciphertext: new Uint8Array(row.encrypted_private_key),
      nonce: new Uint8Array(row.encryption_nonce),
      encryptionVersion: 1,
      kekId: "poc-v1",
    };
  }

  async getLatestSenderProfile(accountId: string): Promise<StoredSenderProfile | null> {
    const rows = await this.sql<SenderProfileRow[]>`
      SELECT id, account_id, did, revision, profile_payload, cose,
             representation_digest, signing_public_key, profile_updated_at, created_at
      FROM sender_profiles
      WHERE account_id = ${accountId}
      ORDER BY revision DESC
      LIMIT 1
    `;
    return rows[0] ? senderProfileFromRow(rows[0]) : null;
  }

  async findCurrentByDid(did: string): Promise<StoredSenderProfile | null> {
    const rows = await this.sql<SenderProfileRow[]>`
      SELECT profile.id, profile.account_id, profile.did, profile.revision,
             profile.profile_payload, profile.cose, profile.representation_digest,
             profile.signing_public_key, profile.profile_updated_at, profile.created_at
       FROM sender_profiles AS profile
       JOIN provider_accounts AS account ON account.id = profile.account_id
       WHERE profile.did = ${did} AND account.onboarding_state = 'active'
         AND NOT EXISTS (SELECT 1 FROM provider_migration_fences fence WHERE fence.did = account.did)
      ORDER BY profile.revision DESC
      LIMIT 1
    `;
    return rows[0] ? senderProfileFromRow(rows[0]) : null;
  }

  async insertSenderProfile(
    profile: StoredSenderProfile,
    expectedPreviousRevision: number,
    authority?: { evidence: PlcResolutionEvidence; serviceBase: string },
  ): Promise<void> {
    await this.sql.begin(async (transaction) => {
      const accounts = await transaction<Pick<AccountRow, "did" | "onboarding_state">[]>`
        SELECT did, onboarding_state
        FROM provider_accounts
        WHERE id = ${profile.accountId}
        FOR UPDATE
      `;
      const account = accounts[0];
      if (!account || account.onboarding_state !== "active" || account.did !== profile.did) {
        throw new Error("Active Sender Profile account does not match the profile DID");
      }
      const latest = await transaction<{ revision: number; profile_updated_at: number | string | bigint }[]>`
        SELECT revision, profile_updated_at
        FROM sender_profiles
        WHERE account_id = ${profile.accountId}
        ORDER BY revision DESC
        LIMIT 1
      `;
      const previous = latest[0];
      const previousRevision = previous?.revision ?? 0;
      if (
        previousRevision !== expectedPreviousRevision ||
        profile.revision !== expectedPreviousRevision + 1
      ) {
        throw new Error("Sender Profile revision conflict");
      }
      if (previous && profile.updatedAt <= Number(previous.profile_updated_at)) {
        throw new Error("Sender Profile updated_at must increase with every revision");
      }
      await transaction`
        INSERT INTO sender_profiles (
          id, account_id, did, revision, profile_payload, cose,
          representation_digest, signing_public_key, profile_updated_at
        )
        VALUES (
          ${profile.id}, ${profile.accountId}, ${profile.did}, ${profile.revision},
          ${profile.payload}::jsonb, ${profile.cose}, ${profile.digest},
          ${profile.signingPublicKey}, ${profile.updatedAt}
        )
      `;
      if (authority) {
        await retainPublicSigningAuthority(transaction, {
          actionType: "sender-profile",
          localAccountId: profile.accountId,
          did: profile.did,
          role: "hail-messaging",
          key: profile.signingPublicKey,
          serviceBase: authority.serviceBase,
          representation: profile.cose,
          evidence: authority.evidence,
        });
      }
    });
  }

  async getLatestVerifiedSenderProfile(did: string): Promise<VerifiedSenderProfile | null> {
    const rows = await this.sql<VerifiedSenderProfileRow[]>`
      SELECT did, revision, profile_updated_at, profile_payload, cose,
             representation_digest, service_base, messaging_public_key,
             plc_document, plc_data, plc_operation_log, verified_at
      FROM verified_sender_profiles
      WHERE did = ${did}
      ORDER BY revision DESC
      LIMIT 1
    `;
    return rows[0] ? verifiedSenderProfileFromRow(rows[0]) : null;
  }

  async retainVerifiedSenderProfile(profile: VerifiedSenderProfile): Promise<void> {
    await this.sql.begin(async (transaction) => {
      await transaction`SELECT pg_advisory_xact_lock(hashtextextended(${profile.did}, 0))`;
      const rows = await transaction<VerifiedSenderProfileRow[]>`
        SELECT did, revision, profile_updated_at, profile_payload, cose,
               representation_digest, service_base, messaging_public_key,
               plc_document, plc_data, plc_operation_log, verified_at
        FROM verified_sender_profiles
        WHERE did = ${profile.did}
        ORDER BY revision DESC
        LIMIT 1
      `;
      const retained = rows[0] ? verifiedSenderProfileFromRow(rows[0]) : null;
      if (retained) {
        if (profile.profile.revision < retained.profile.revision) {
          throw new Error("Sender Profile revision rollback detected");
        }
        if (profile.profile.revision === retained.profile.revision) {
          if (!Buffer.from(profile.representation).equals(Buffer.from(retained.representation))) {
            throw new Error("Sender Profile revision conflicts with retained evidence");
          }
          await transaction`
            UPDATE verified_sender_profiles
            SET service_base = ${profile.serviceBase},
                messaging_public_key = ${profile.messagingDidKey},
                plc_document = ${profile.plcEvidence.document}::jsonb,
                plc_data = ${profile.plcEvidence.data}::jsonb,
                plc_operation_log = ${profile.plcEvidence.log}::jsonb,
                verified_at = ${profile.verifiedAt}
            WHERE did = ${profile.did} AND revision = ${profile.profile.revision}
          `;
          return;
        }
        if (profile.profile.updated_at <= retained.profile.updated_at) {
          throw new Error("Sender Profile updated_at did not advance");
        }
      }
      await transaction`
        INSERT INTO verified_sender_profiles (
          id, did, revision, profile_updated_at, profile_payload, cose,
          representation_digest, service_base, messaging_public_key,
          plc_document, plc_data, plc_operation_log, verified_at
        )
        VALUES (
          ${crypto.randomUUID()}, ${profile.did}, ${profile.profile.revision},
          ${profile.profile.updated_at}, ${profile.profile}::jsonb,
          ${profile.representation}, ${profile.digest}, ${profile.serviceBase},
          ${profile.messagingDidKey}, ${profile.plcEvidence.document}::jsonb,
          ${profile.plcEvidence.data}::jsonb,
          ${profile.plcEvidence.log}::jsonb, ${profile.verifiedAt}
        )
      `;
    });
  }

  async beginSubmission(accountId: string): Promise<void> {
    await this.sql.begin(async (transaction) => {
      const accounts = await transaction`
        UPDATE provider_accounts
        SET onboarding_state = 'submission-unknown', state_version = state_version + 1,
            updated_at = now()
        WHERE id = ${accountId} AND onboarding_state IN ('prepared', 'submission-unknown')
        RETURNING id
      `;
      if (accounts.length !== 1) throw new Error("Account is not ready for PLC submission");
      await transaction`
        UPDATE plc_operation_evidence
        SET submission_state = 'submission-unknown',
            submission_attempts = submission_attempts + 1,
            last_submission_at = now()
        WHERE account_id = ${accountId} AND previous_cid IS NULL
      `;
    });
  }

  async markDidRegistered(
    accountId: string,
    readback: { document: object; data: object; log: readonly object[]; audit: readonly object[] },
  ): Promise<void> {
    await this.sql.begin(async (transaction) => {
      const accounts = await transaction`
        UPDATE provider_accounts
        SET onboarding_state = 'did-registered', state_version = state_version + 1,
            updated_at = now()
        WHERE id = ${accountId} AND onboarding_state IN ('prepared', 'submission-unknown')
        RETURNING id
      `;
      if (accounts.length !== 1) throw new Error("Account cannot be marked DID-registered");
      await transaction`
        UPDATE plc_operation_evidence
        SET submission_state = 'verified', submitted_at = COALESCE(submitted_at, now()),
            verified_at = now(),
            verified_document = ${readback.document}::jsonb,
            verified_data = ${readback.data}::jsonb,
            verified_log = ${readback.log}::jsonb,
            verified_audit = ${readback.audit}::jsonb
        WHERE account_id = ${accountId} AND previous_cid IS NULL
      `;
    });
  }

  async stageAddressBinding(input: {
    accountId: string;
    bindingId: string;
    address: string;
    did: string;
    cose: Uint8Array;
    digest: Uint8Array;
    issuedAt: Date;
    expiresAt: Date;
  }): Promise<void> {
    await this.sql.begin(async (transaction) => {
      await transaction`
        INSERT INTO address_bindings (
          id, account_id, canonical_address, did, cose, representation_digest,
          issued_at, expires_at, hosted_at
        )
        VALUES (
          ${input.bindingId}, ${input.accountId}, ${input.address}, ${input.did},
          ${input.cose}, ${input.digest}, ${input.issuedAt}, ${input.expiresAt}, now()
        )
      `;
      const accounts = await transaction`
        UPDATE provider_accounts
        SET onboarding_state = 'address-staged', state_version = state_version + 1,
            updated_at = now()
        WHERE id = ${input.accountId} AND onboarding_state = 'did-registered'
        RETURNING id
      `;
      if (accounts.length !== 1) throw new Error("Account is not ready to stage a binding");
    });
  }

  async getBindingForAccount(accountId: string, digest?: Uint8Array): Promise<PublishedAddressBinding> {
    const rows = await this.sql<BindingRow[]>`
      SELECT id, account_id, canonical_address, did, cose, representation_digest,
             issued_at, expires_at, published_at
      FROM address_bindings
      WHERE account_id = ${accountId}
        AND (${digest ?? null}::bytea IS NULL OR representation_digest=${digest ?? null})
      ORDER BY created_at DESC
      LIMIT 1
    `;
    if (!rows[0]) throw new Error("Address Binding does not exist");
    return bindingFromRow(rows[0]);
  }

  async findPublishedByAddress(address: string): Promise<PublishedAddressBinding | null> {
    const rows = await this.sql<BindingRow[]>`
      SELECT id, account_id, canonical_address, did, cose, representation_digest,
             issued_at, expires_at, published_at
      FROM (
        SELECT * FROM address_bindings WHERE canonical_address=${address} AND selected_at IS NOT NULL
        ORDER BY selected_at DESC, id DESC LIMIT 1
      ) AS current_binding
      WHERE expires_at > now()
        AND EXISTS (SELECT 1 FROM provider_accounts account WHERE account.id=current_binding.account_id
          AND account.canonical_address=current_binding.canonical_address)
        AND NOT EXISTS (SELECT 1 FROM provider_migration_fences fence
          WHERE fence.account_id = current_binding.account_id AND fence.state = 'retired')
    `;
    return rows[0] ? bindingFromRow(rows[0]) : null;
  }

  async findPublishedById(id: string): Promise<PublishedAddressBinding | null> {
    const rows = await this.sql<BindingRow[]>`
      SELECT id, account_id, canonical_address, did, cose, representation_digest,
             issued_at, expires_at, published_at
      FROM address_bindings
      WHERE id = ${id}
        AND hosted_at IS NOT NULL
        AND expires_at > now()
      LIMIT 1
    `;
    return rows[0] ? bindingFromRow(rows[0]) : null;
  }

  async beginActivation(accountId: string, bindingId: string): Promise<string> {
    return this.sql.begin(async (transaction) => {
      const existing = await transaction<
        (Pick<AccountRow, "onboarding_state" | "activation_attempt_id"> & { updated_at: Date })[]
      >`
        SELECT onboarding_state, activation_attempt_id, updated_at
        FROM provider_accounts
        WHERE id = ${accountId}
        FOR UPDATE
      `;
      const account = existing[0];
      if (!account) throw new Error("Account does not exist");
      let attemptId = account.activation_attempt_id;
      if (account.onboarding_state === "address-staged") {
        attemptId = crypto.randomUUID();
        await transaction`
          UPDATE provider_accounts
          SET onboarding_state = 'activating', activation_attempt_id = ${attemptId},
              state_version = state_version + 1, updated_at = now()
          WHERE id = ${accountId} AND onboarding_state = 'address-staged'
        `;
      } else if (
        account.onboarding_state === "activating" &&
        attemptId &&
        account.updated_at.getTime() <= Date.now() - 120_000
      ) {
        attemptId = crypto.randomUUID();
        await transaction`
          UPDATE provider_accounts
          SET activation_attempt_id = ${attemptId}, state_version = state_version + 1,
              updated_at = now()
          WHERE id = ${accountId} AND onboarding_state = 'activating'
        `;
      } else if (account.onboarding_state === "activating") {
        throw new Error("Account activation is already in progress");
      } else {
        throw new Error("Account is not ready for activation");
      }
      const selected = await transaction`
        UPDATE address_bindings
        SET selected_at = COALESCE(selected_at, now()),
            published_at = COALESCE(published_at, now())
        WHERE id = ${bindingId}
          AND account_id = ${accountId}
          AND hosted_at IS NOT NULL
          AND expires_at > now()
        RETURNING id
      `;
      if (selected.length !== 1) throw new Error("Address Binding cannot be selected");
      if (!attemptId) throw new Error("Activation attempt was not established");
      return attemptId;
    });
  }

  async cancelActivation(accountId: string, bindingId: string, attemptId: string): Promise<void> {
    await this.sql.begin(async (transaction) => {
      const reset = await transaction`
        UPDATE provider_accounts
        SET onboarding_state = 'address-staged', activation_attempt_id = NULL,
            state_version = state_version + 1, updated_at = now()
        WHERE id = ${accountId}
          AND onboarding_state = 'activating'
          AND activation_attempt_id = ${attemptId}
        RETURNING id
      `;
      if (reset.length === 1) {
        await transaction`
          UPDATE address_bindings
          SET selected_at = NULL, published_at = NULL
          WHERE id = ${bindingId} AND account_id = ${accountId}
        `;
      }
    });
  }

  async activateAccount(
    accountId: string,
    bindingId: string,
    bindingDigest: Uint8Array,
    attemptId: string,
    verificationMode: "local" | "public",
  ): Promise<void> {
    const rows = await this.sql`
      UPDATE provider_accounts AS account
      SET onboarding_state = 'active', activated_at = now(),
          activation_binding_digest = ${bindingDigest},
          activation_verification_mode = ${verificationMode}, activation_attempt_id = NULL,
          state_version = state_version + 1, updated_at = now()
      FROM address_bindings AS binding
      WHERE account.id = ${accountId}
        AND account.onboarding_state = 'activating'
        AND account.activation_attempt_id = ${attemptId}
        AND binding.id = ${bindingId}
        AND binding.account_id = account.id
        AND binding.selected_at IS NOT NULL
        AND binding.expires_at > now()
        AND binding.representation_digest = ${bindingDigest}
      RETURNING account.id
    `;
    if (rows.length !== 1) throw new Error("Account cannot be activated");
  }

  async promoteActivation(
    accountId: string,
    bindingId: string,
    bindingDigest: Uint8Array,
  ): Promise<void> {
    const rows = await this.sql`
      UPDATE provider_accounts AS account
      SET activation_verification_mode = 'public',
          state_version = state_version + 1, updated_at = now()
      FROM address_bindings AS binding
      WHERE account.id = ${accountId}
        AND account.onboarding_state = 'active'
        AND account.activation_verification_mode IN ('local', 'public')
        AND account.activation_binding_digest = ${bindingDigest}
        AND binding.id = ${bindingId}
        AND binding.account_id = account.id
        AND binding.selected_at IS NOT NULL
        AND binding.expires_at > now()
        AND binding.representation_digest = ${bindingDigest}
      RETURNING account.id
    `;
    if (rows.length !== 1) throw new Error("Account activation cannot be promoted");
  }
}
