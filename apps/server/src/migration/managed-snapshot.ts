import { createHash } from "node:crypto";
import { def } from "@did-plc/lib";
import { decodeDeterministic, decodePayload, encodeBase64Url, encodeDeterministic, inspectSignedPayload,
  type HailValue } from "@hailproto/codec";
import type { SQL } from "bun";
import { bodyDigest, validateBodyBytes } from "../bodies/service.js";
import type { KeyEncryptor } from "../identity/key-encryption.js";
import { importEd25519PrivateKey } from "../identity/keys.js";
import { MANAGED_CUSTODY_PROFILE_VERSION } from "../identity/managed-profile.js";
import type { OnboardingRepository } from "../onboarding/repository.js";
import { PUBLIC_EVIDENCE_LIMITS } from "../plc/read-evidence.js";
import { canonicalizeHailServiceBase, type HailDidResolver } from "../plc/resolver.js";
import { parseJsonWithoutDuplicateKeys } from "../discovery/strict-json.js";
import type { ManagedMigrationFence } from "./managed-fence.js";

const UUID = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/;
const DID = /^did:plc:[a-z2-7]{24}$/;
const MANAGED_CONTEXT = new TextEncoder().encode("hail-migration-snapshot-v4\0");

export const MANAGED_TRANSFER_TABLES = [
  "provider_accounts", "account_keys", "managed_custody_evidence", "plc_operation_evidence", "address_bindings",
  "sender_profiles", "grant_lineages", "grant_revisions", "grant_consent_evidence", "grant_publications",
  "detached_bodies", "body_authorizations", "sent_envelopes", "received_envelopes", "reply_capabilities",
  "delivery_work", "verified_body_provenance", "delivered_messages", "delivery_status_payloads",
  "delivery_status_wrappers", "terminal_status_publications", "sent_delivery_status",
  "public_plc_resolution_evidence", "public_envelope_authority_evidence",
  "public_grant_authority_evidence", "public_signing_authority_evidence",
] as const;

type ManagedTransferTable = (typeof MANAGED_TRANSFER_TABLES)[number];
export type ManagedTransferTables = Record<ManagedTransferTable, Record<string, unknown>[]>;

export interface ManagedTransferManifest {
  version: 4; transferId: string; did: string; accountId: string;
  sourceServiceBase: string; destinationServiceBase: string;
  ownerRecoveryPublicKey: string; sourceIdentityPublicKey: string;
  destinationRotationPublicKey: string; destinationIdentityPublicKey: string;
  destinationMessagingPublicKey: string; sourceGeneration: number;
  historyCheckpointDigest: string; custodyProfile: "managed"; capturedAt: string;
  tables: ManagedTransferTables;
}

export interface SignedManagedTransferSnapshot {
  bytes: Uint8Array; digest: Uint8Array; signature: Uint8Array; sourceMessagingPublicKey: string;
}

interface ExportRow {
  manifest_bytes: Uint8Array; manifest_digest: Uint8Array; signature: Uint8Array;
  source_messaging_public_key: string; custody_profile: string;
}

const sha256 = (bytes: Uint8Array) => new Uint8Array(createHash("sha256").update(bytes).digest());
const same = (a: Uint8Array, b: Uint8Array) => Buffer.from(a).equals(Buffer.from(b));

function bytea(value: unknown, label: string): Uint8Array {
  if (typeof value !== "string" || !/^\\x(?:[0-9a-f]{2})+$/i.test(value)) {
    throw new Error(`Managed snapshot ${label} is not a PostgreSQL byte string`);
  }
  return new Uint8Array(Buffer.from(value.slice(2), "hex"));
}

function envelopeKey(row: Record<string, unknown>): string {
  return `${String(row.sender_did)}\0${String(row.message_id)}`;
}

function requireEnvelopes(table: string, rows: Record<string, unknown>[], known: Set<string>): void {
  if (rows.some((row) => !known.has(envelopeKey(row)))) {
    throw new Error(`Managed transfer ${table} references an absent envelope`);
  }
}

function hexKey(value: unknown, label: string): string {
  return Buffer.from(bytea(value, label)).toString("hex");
}

export function managedSnapshotSignatureInput(hash: Uint8Array): Uint8Array<ArrayBuffer> {
  const value = new Uint8Array(MANAGED_CONTEXT.length + hash.length);
  value.set(MANAGED_CONTEXT); value.set(hash, MANAGED_CONTEXT.length); return value;
}

function historyCheckpoint(manifest: Omit<ManagedTransferManifest, "historyCheckpointDigest">): Uint8Array {
  const tables = manifest.tables;
  const checkpoint = {
    type: "hail.managed-migration-history-checkpoint", version: 1, did: manifest.did,
    source_generation: manifest.sourceGeneration,
    plc: tables.plc_operation_evidence.map((row) => ({ id: row.id, operation_cid: row.operation_cid,
      previous_cid: row.previous_cid ?? "", state: row.submission_state,
      dag_cbor_sha256: encodeBase64Url(sha256(bytea(row.dag_cbor, "PLC operation"))) })),
    grants: tables.grant_revisions.map((row) => {
      const publication = tables.grant_publications.find((value) => value.grant_id === row.grant_id &&
        value.revision === row.revision);
      return { grant_id: row.grant_id, revision: row.revision, status: row.status,
        digest: encodeBase64Url(bytea(row.representation_digest, "Grant digest")), signer: row.signing_public_key,
        publication: publication?.state ?? "none", etag: publication?.acknowledged_etag ?? "" };
    }),
    bindings: tables.address_bindings.map((row) => ({ id: row.id,
      digest: encodeBase64Url(bytea(row.representation_digest, "Address Binding digest")),
      selected_at: row.selected_at ?? "", published_at: row.published_at ?? "" })),
    authority: tables.public_plc_resolution_evidence.map((row) => ({ did: row.did,
      operation_cid: row.operation_cid, evidence_digest: encodeBase64Url(bytea(row.evidence_digest, "authority digest")),
      bundle_sha256: encodeBase64Url(sha256(bytea(row.bundle_bytes, "authority bundle"))) })),
    authority_links: [
      ...tables.public_envelope_authority_evidence,
      ...tables.public_grant_authority_evidence,
      ...tables.public_signing_authority_evidence,
    ].map((row) => ({ authority_did: row.authority_did,
      representation_digest: encodeBase64Url(bytea(row.representation_digest, "authority representation")),
      evidence_digest: encodeBase64Url(bytea(row.evidence_digest, "authority link")) })),
  };
  return sha256(encodeDeterministic(checkpoint as unknown as HailValue));
}

export function validateManagedTransferManifest(bytes: Uint8Array): ManagedTransferManifest {
  if (!bytes.length || bytes.length > 67_108_864) throw new Error("Managed transfer manifest exceeds its size limit");
  const value = parseJsonWithoutDuplicateKeys(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid managed transfer manifest");
  const manifest = value as ManagedTransferManifest;
  const expectedFields = ["version", "transferId", "did", "accountId", "sourceServiceBase",
    "destinationServiceBase", "ownerRecoveryPublicKey", "sourceIdentityPublicKey",
    "destinationRotationPublicKey", "destinationIdentityPublicKey", "destinationMessagingPublicKey",
    "sourceGeneration", "historyCheckpointDigest", "custodyProfile", "capturedAt", "tables"];
  if (Object.keys(manifest).length !== expectedFields.length || expectedFields.some((field) => !Object.hasOwn(manifest, field)) ||
    manifest.version !== 4 || manifest.custodyProfile !== "managed" || !UUID.test(manifest.transferId) ||
    !DID.test(manifest.did) || !UUID.test(manifest.accountId) || !Number.isSafeInteger(manifest.sourceGeneration) ||
    manifest.sourceGeneration < 1 || typeof manifest.capturedAt !== "string" || !Number.isFinite(Date.parse(manifest.capturedAt)) ||
    typeof manifest.historyCheckpointDigest !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(manifest.historyCheckpointDigest) ||
    !manifest.tables || typeof manifest.tables !== "object" || Array.isArray(manifest.tables) ||
    Object.keys(manifest.tables).length !== MANAGED_TRANSFER_TABLES.length ||
    MANAGED_TRANSFER_TABLES.some((table) => !Array.isArray(manifest.tables[table]))) {
    throw new Error("Managed transfer manifest has an invalid or incomplete serialization domain");
  }
  if (canonicalizeHailServiceBase(manifest.sourceServiceBase) !== manifest.sourceServiceBase ||
    canonicalizeHailServiceBase(manifest.destinationServiceBase) !== manifest.destinationServiceBase ||
    manifest.sourceServiceBase === manifest.destinationServiceBase) throw new Error("Managed transfer service bases are invalid");
  const roleKeys = [manifest.ownerRecoveryPublicKey, manifest.sourceIdentityPublicKey,
    manifest.destinationRotationPublicKey, manifest.destinationIdentityPublicKey, manifest.destinationMessagingPublicKey];
  if (roleKeys.some((key) => typeof key !== "string" || !key.startsWith("did:key:z")) ||
    new Set(roleKeys).size !== roleKeys.length) throw new Error("Managed transfer roles are missing or reused");
  const account = manifest.tables.provider_accounts;
  if (account.length !== 1 || account[0]?.id !== manifest.accountId || account[0]?.did !== manifest.did ||
    account[0]?.onboarding_state !== "active" || account[0]?.activation_verification_mode !== "public") {
    throw new Error("Managed transfer does not contain one strict active account");
  }
  const keys = manifest.tables.account_keys;
  const forbidden = ["encrypted_private_key", "encryption_nonce", "encryption_version", "kek_id"];
  if (Object.values(manifest.tables).some((rows) => rows.some((row) =>
    [...forbidden, "lease_token", "lease_expires_at"].some((field) => field in row)))) {
    throw new Error("Managed transfer contains private key or worker lease material");
  }
  if (keys.length !== 3 || new Set(keys.map((key) => key.role)).size !== 3 ||
    ["plc-rotation", "hail-identity", "hail-messaging"].some((role) => !keys.some((key) => key.role === role)) ||
    keys.some((key) => key.account_id !== manifest.accountId || forbidden.some((field) => field in key)) ||
    keys.find((key) => key.role === "hail-identity")?.public_key !== manifest.sourceIdentityPublicKey) {
    throw new Error("Managed transfer contains private key material or incomplete source roles");
  }
  const sourceRoles = new Set([manifest.ownerRecoveryPublicKey, ...keys.map((key) => String(key.public_key))]);
  if ([manifest.destinationRotationPublicKey, manifest.destinationIdentityPublicKey,
    manifest.destinationMessagingPublicKey].some((key) => sourceRoles.has(key))) {
    throw new Error("Managed destination roles are not fresh from source roles");
  }
  const custody = manifest.tables.managed_custody_evidence;
  const legacyPrivateProfile = custody[0]?.managed_profile_version === undefined && custody[0]?.verification_mode === "poc-local";
  if (custody.length !== 1 || custody[0]?.account_id !== manifest.accountId ||
    custody[0]?.owner_recovery_public_key !== manifest.ownerRecoveryPublicKey ||
    custody[0]?.provider_identity_public_key !== manifest.sourceIdentityPublicKey ||
    custody[0]?.managed_profile_version !== MANAGED_CUSTODY_PROFILE_VERSION && !legacyPrivateProfile ||
    !["strict-public-v1","poc-local"].includes(String(custody[0]?.verification_mode))) throw new Error("Managed custody evidence is incomplete");
  for (const table of ["plc_operation_evidence", "address_bindings", "sender_profiles"] as const) {
    if (manifest.tables[table].some((row) => row.account_id !== manifest.accountId)) {
      throw new Error(`Managed transfer ${table} contains another account`);
    }
  }
  const grants = new Map(manifest.tables.grant_lineages.map((row) => [row.grant_id, row]));
  if (manifest.tables.grant_lineages.some((row) => row.local_account_id !== manifest.accountId) ||
    manifest.tables.grant_revisions.some((row) => !grants.has(row.grant_id)) ||
    manifest.tables.grant_consent_evidence.some((row) => !grants.has(row.grant_id)) ||
    manifest.tables.grant_publications.some((row) => !grants.has(row.grant_id))) {
    throw new Error("Managed transfer Grant history is incomplete or belongs to another account");
  }
  for (const row of manifest.tables.grant_revisions) {
    const cose = bytea(row.cose, "Grant representation");
    const payload = inspectSignedPayload("hail.grant", cose).payload;
    if (payload.grant_id !== row.grant_id || payload.revision !== row.revision ||
      !same(sha256(cose), bytea(row.representation_digest, "Grant representation digest"))) {
      throw new Error("Managed transfer Grant representation is not exact");
    }
  }
  for (const lineage of manifest.tables.grant_lineages) {
    const current = manifest.tables.grant_revisions.find((row) => row.grant_id === lineage.grant_id &&
      row.revision === lineage.current_revision);
    const publication = manifest.tables.grant_publications.find((row) => row.grant_id === lineage.grant_id &&
      row.revision === lineage.current_revision);
    if (!current || current.status !== lineage.current_status ||
      !same(bytea(current.representation_digest, "current Grant digest"), bytea(lineage.current_digest, "lineage digest")) ||
      (lineage.local_role === "grantor" && lineage.current_status === "active" &&
        (publication?.state !== "acknowledged" || typeof publication.acknowledged_etag !== "string" ||
          !publication.acknowledged_etag || !publication.acknowledged_at))) {
      throw new Error("Managed transfer lacks an exact acknowledged active Grant predecessor");
    }
  }
  const revisions = new Set(manifest.tables.grant_revisions.map((row) => `${row.grant_id}\0${row.revision}`));
  if (manifest.tables.grant_consent_evidence.some((row) => !revisions.has(`${row.grant_id}\0${row.revision}`)) ||
    manifest.tables.grant_publications.some((row) => !revisions.has(`${row.grant_id}\0${row.revision}`))) {
    throw new Error("Managed transfer Grant evidence or publication lacks its revision");
  }
  const bodies = new Set<string>();
  for (const row of manifest.tables.detached_bodies) {
    const bytes = bytea(row.body_bytes, "body bytes");
    const digest = bytea(row.digest, "body digest");
    validateBodyBytes(bytes);
    if (row.sender_account_id !== manifest.accountId || !same(bodyDigest(bytes), digest)) {
      throw new Error("Managed transfer body integrity failed");
    }
    bodies.add(Buffer.from(digest).toString("hex"));
  }
  for (const row of manifest.tables.body_authorizations) {
    if (row.sender_account_id !== manifest.accountId || !bodies.has(hexKey(row.body_digest, "authorized body digest"))) {
      throw new Error("Managed transfer body authorization lacks local provenance");
    }
  }
  for (const [table, accountField, partyField] of [
    ["sent_envelopes", "sender_account_id", "sender_did"],
    ["received_envelopes", "local_account_id", "recipient_did"],
  ] as const) {
    for (const row of manifest.tables[table]) {
      const signed = inspectSignedPayload("hail.envelope", bytea(row.envelope_cose, "envelope representation"));
      if (row[accountField] !== manifest.accountId || row[partyField] !== manifest.did ||
        signed.payload.message_id !== row.message_id || signed.payload.from !== row.sender_did ||
        signed.payload.to !== row.recipient_did ||
        !same(sha256(signed.payloadBytes), bytea(row.envelope_digest, "envelope digest")) ||
        (table === "received_envelopes" &&
          !same(sha256(signed.payloadBytes), bytea(row.payload_digest, "replay payload digest")))) {
        throw new Error(`Managed transfer ${table} has an invalid owner or signed payload`);
      }
    }
  }
  const sent = new Set(manifest.tables.sent_envelopes.map(envelopeKey));
  const received = new Set(manifest.tables.received_envelopes.map(envelopeKey));
  requireEnvelopes("delivery_work", manifest.tables.delivery_work, received);
  requireEnvelopes("delivered_messages", manifest.tables.delivered_messages, received);
  requireEnvelopes("delivery_status_payloads", manifest.tables.delivery_status_payloads, received);
  requireEnvelopes("delivery_status_wrappers", manifest.tables.delivery_status_wrappers, received);
  requireEnvelopes("terminal_status_publications", manifest.tables.terminal_status_publications, received);
  requireEnvelopes("sent_delivery_status", manifest.tables.sent_delivery_status, sent);
  const provenance = new Set<string>();
  for (const row of manifest.tables.verified_body_provenance) {
    const bytes = bytea(row.body_bytes, "verified body");
    const digest = bytea(row.digest, "verified body digest");
    validateBodyBytes(bytes);
    if (row.recipient_did !== manifest.did || !same(bodyDigest(bytes), digest)) {
      throw new Error("Managed transfer verified body lacks valid recipient provenance");
    }
    provenance.add(`${row.sender_did}\0${Buffer.from(digest).toString("hex")}`);
  }
  for (const row of manifest.tables.delivered_messages) {
    if (row.recipient_did !== manifest.did ||
      !provenance.has(`${row.sender_did}\0${hexKey(row.body_digest, "delivered body digest")}`)) {
      throw new Error("Managed transfer delivered message lacks verified body provenance");
    }
  }
  const payloads = new Map<string, Uint8Array>();
  for (const row of manifest.tables.delivery_status_payloads) {
    const bytes = bytea(row.payload_bytes, "status payload");
    const status = decodePayload("hail.delivery-status", bytes);
    if (status.from !== manifest.did || status.to !== row.sender_did || status.message_id !== row.message_id ||
      status.revision !== row.revision) throw new Error("Managed transfer status payload does not match its envelope");
    payloads.set(`${envelopeKey(row)}\0${row.revision}`, bytes);
  }
  for (const row of manifest.tables.delivery_status_wrappers) {
    const signed = inspectSignedPayload("hail.delivery-status", bytea(row.cose, "status wrapper"));
    const original = payloads.get(`${envelopeKey(row)}\0${row.revision}`);
    if (!original || !same(original, signed.payloadBytes)) {
      throw new Error("Managed transfer status wrapper does not match its immutable revision");
    }
  }
  for (const row of manifest.tables.sent_delivery_status) {
    const signed = inspectSignedPayload("hail.delivery-status", bytea(row.cose, "received status"));
    const envelope = manifest.tables.sent_envelopes.find((item) => envelopeKey(item) === envelopeKey(row));
    if (row.sender_did !== manifest.did || !envelope || signed.payload.from !== row.recipient_did ||
      signed.payload.to !== manifest.did || signed.payload.message_id !== row.message_id ||
      signed.payload.revision !== row.current_revision || signed.payload.state !== row.current_state ||
      !same(signed.payloadBytes, bytea(row.payload_bytes, "received status payload")) ||
      !same(bytea(envelope.envelope_digest, "sent envelope digest"), signed.payload.envelope_digest.value)) {
      throw new Error("Managed transfer received status does not correlate to its sent envelope");
    }
  }
  for (const row of manifest.tables.reply_capabilities) {
    const original = manifest.tables.sent_envelopes.find((entry) => entry.sender_did === row.original_sender_did &&
      entry.message_id === row.original_message_id);
    if (!original || row.original_sender_did !== manifest.did || original.recipient_did !== row.permitted_recipient_did) {
      throw new Error("Managed transfer reply invitation lacks its signed original");
    }
    const payload = inspectSignedPayload("hail.envelope", bytea(original.envelope_cose, "reply invitation")).payload;
    if (!payload.reply.allowed || payload.reply.until !== Number(row.reply_until) ||
      (row.state !== "available" && !received.has(`${row.claimed_sender_did}\0${row.claimed_message_id}`))) {
      throw new Error("Managed transfer reply claim conflicts with its signed permission or accepted reply");
    }
  }
  const resolutions = new Map(manifest.tables.public_plc_resolution_evidence.map((row) =>
    [Buffer.from(bytea(row.evidence_digest, "resolution evidence digest")).toString("hex"), row]));
  for (const row of manifest.tables.public_plc_resolution_evidence) {
    const bundle = bytea(row.bundle_bytes, "resolution evidence bundle");
    if (!same(sha256(bundle), bytea(row.evidence_digest, "resolution evidence digest"))) {
      throw new Error("Managed resolution evidence digest is invalid");
    }
    const decoded = decodeDeterministic(bundle, PUBLIC_EVIDENCE_LIMITS) as Record<string, HailValue>;
    if (decoded.type !== "hail.public-plc-resolution" || decoded.version !== 1 ||
      decoded.policy !== "strict-public-v1" || decoded.did !== row.did || decoded.operation_cid !== row.operation_cid ||
      typeof decoded.verified_at !== "string" || typeof row.verified_at !== "string" ||
      Date.parse(decoded.verified_at) !== Date.parse(row.verified_at)) {
      throw new Error("Managed resolution evidence metadata is invalid");
    }
  }
  const links = [...manifest.tables.public_envelope_authority_evidence,
    ...manifest.tables.public_grant_authority_evidence, ...manifest.tables.public_signing_authority_evidence];
  const referenced = new Set(links.map((row) => hexKey(row.evidence_digest, "authority link digest")));
  if (links.some((row) => row.local_account_id !== manifest.accountId ||
    resolutions.get(hexKey(row.evidence_digest, "authority link digest"))?.did !== row.authority_did) ||
    resolutions.size !== manifest.tables.public_plc_resolution_evidence.length || resolutions.size !== referenced.size ||
    [...resolutions.keys()].some((key) => !referenced.has(key))) {
    throw new Error("Managed authority history has a missing resolution checkpoint");
  }
  const representations = {
    envelope: new Set([...manifest.tables.sent_envelopes, ...manifest.tables.received_envelopes]
      .map((row) => Buffer.from(sha256(bytea(row.envelope_cose, "envelope representation"))).toString("hex"))),
    grant: new Set(manifest.tables.grant_revisions.map((row) => hexKey(row.representation_digest, "Grant authority digest"))),
    "address-binding": new Set(manifest.tables.address_bindings
      .map((row) => Buffer.from(sha256(bytea(row.cose, "Address Binding representation"))).toString("hex"))),
    "sender-profile": new Set(manifest.tables.sender_profiles
      .map((row) => Buffer.from(sha256(bytea(row.cose, "Sender Profile representation"))).toString("hex"))),
    "delivery-status": new Set(manifest.tables.delivery_status_wrappers
      .map((row) => Buffer.from(sha256(bytea(row.cose, "Delivery Status representation"))).toString("hex"))),
  };
  if (manifest.tables.public_envelope_authority_evidence.some((row) =>
    !representations.envelope.has(hexKey(row.representation_digest, "envelope authority digest"))) ||
    manifest.tables.public_grant_authority_evidence.some((row) =>
      !revisions.has(`${row.grant_id}\0${row.revision}`) ||
      !representations.grant.has(hexKey(row.representation_digest, "Grant authority digest"))) ||
    manifest.tables.public_signing_authority_evidence.some((row) =>
      !representations[row.action_type as keyof typeof representations]?.has(
        hexKey(row.representation_digest, "signing authority digest")))) {
    throw new Error("Managed authority history does not match a retained signed representation");
  }
  const { historyCheckpointDigest: _retainedCheckpoint, ...withoutCheckpoint } = manifest;
  const expectedCheckpoint = historyCheckpoint(withoutCheckpoint);
  if (encodeBase64Url(expectedCheckpoint) !== manifest.historyCheckpointDigest) {
    throw new Error("Managed history checkpoint does not match the transported history");
  }
  return manifest;
}

export class ManagedMigrationExportService {
  constructor(private readonly sql: SQL, private readonly accounts: Pick<OnboardingRepository, "getKey">,
    private readonly encryptor: KeyEncryptor, private readonly resolver: HailDidResolver,
    private readonly serviceBase: string, private readonly now = () => new Date(),
    private readonly verificationMode:"strict-public-v1"|"poc-local"="strict-public-v1") {}

  async exportFenced(fence: ManagedMigrationFence): Promise<SignedManagedTransferSnapshot> {
    const resolved = await this.resolver.resolve(fence.did);
    const plc = def.documentData.parse(resolved.evidence.data);
    if (resolved.evidence.verification?.profile !== this.verificationMode || resolved.did !== fence.did || resolved.serviceBase !== this.serviceBase ||
      resolved.identityDidKey !== fence.sourceIdentityPublicKey || plc.rotationKeys[0] !== fence.ownerRecoveryPublicKey) {
      throw new Error("Current strict PLC state does not authenticate the managed export source");
    }
    const messaging = await this.accounts.getKey(fence.accountId, "hail-messaging");
    if (messaging.algorithm !== "ed25519" || messaging.publicKey !== resolved.messagingDidKey) {
      throw new Error("Current PLC does not authorize the managed export signer");
    }
    return this.sql.begin(async (tx) => {
      const current = (await tx<{ state: string; account_id: string; source_custody_profile: string;
        owner_recovery_public_key: string | null; source_identity_public_key: string | null;
        destination_service_base: string; destination_rotation_public_key: string | null;
        destination_identity_public_key: string | null; destination_messaging_public_key: string | null }[]>`
        SELECT state,account_id,source_custody_profile,owner_recovery_public_key,source_identity_public_key,
          destination_service_base,destination_rotation_public_key,destination_identity_public_key,
          destination_messaging_public_key FROM provider_migration_fences
        WHERE did=${fence.did} AND transfer_id=${fence.transferId} FOR UPDATE`)[0];
      if (!current || current.account_id !== fence.accountId || current.source_custody_profile !== "managed" ||
        current.owner_recovery_public_key !== fence.ownerRecoveryPublicKey ||
        current.source_identity_public_key !== fence.sourceIdentityPublicKey ||
        current.destination_service_base !== fence.destinationServiceBase ||
        current.destination_rotation_public_key !== fence.destinationRotationPublicKey ||
        current.destination_identity_public_key !== fence.destinationIdentityPublicKey ||
        current.destination_messaging_public_key !== fence.destinationMessagingPublicKey) {
        throw new Error("Managed migration fence changed before export");
      }
      if (current.state === "exported") {
        const existing = (await tx<ExportRow[]>`SELECT manifest_bytes,manifest_digest,signature,
          source_messaging_public_key,custody_profile FROM provider_migration_exports
          WHERE transfer_id=${fence.transferId}`)[0];
        if (!existing || existing.custody_profile !== "managed") throw new Error("Managed export is missing");
        validateManagedTransferManifest(new Uint8Array(existing.manifest_bytes));
        return { bytes: new Uint8Array(existing.manifest_bytes), digest: new Uint8Array(existing.manifest_digest),
          signature: new Uint8Array(existing.signature), sourceMessagingPublicKey: existing.source_messaging_public_key };
      }
      if (current.state !== "fenced") throw new Error("Managed migration source has retired");
      const unacknowledged = await tx`SELECT 1 FROM grant_lineages lineage
        LEFT JOIN grant_publications publication ON publication.grant_id=lineage.grant_id
          AND publication.revision=lineage.current_revision
        WHERE lineage.local_account_id=${fence.accountId} AND lineage.local_role='grantor'
          AND lineage.current_status='active' AND (publication.state IS DISTINCT FROM 'acknowledged'
            OR publication.acknowledged_etag IS NULL OR publication.acknowledged_at IS NULL) LIMIT 1`;
      if (unacknowledged.length) throw new Error("Every active authoritative Grant needs an acknowledged predecessor");
      if ((await tx`SELECT 1 FROM serving_worker_leases WHERE account_id=${fence.accountId} LIMIT 1`).length) {
        throw new Error("Managed source workers were not drained before export");
      }
      const generation = Number((await tx<{ generation: number | bigint | string }[]>`
        SELECT generation FROM account_serving_generations WHERE account_id=${fence.accountId}`)[0]?.generation);
      if (!Number.isSafeInteger(generation) || generation < 1) throw new Error("Managed source generation is invalid");
      const tables = await collectManagedTables(tx, fence.did, fence.accountId);
      const base = { version: 4 as const, transferId: fence.transferId, did: fence.did, accountId: fence.accountId,
        sourceServiceBase: this.serviceBase, destinationServiceBase: fence.destinationServiceBase,
        ownerRecoveryPublicKey: fence.ownerRecoveryPublicKey, sourceIdentityPublicKey: fence.sourceIdentityPublicKey,
        destinationRotationPublicKey: fence.destinationRotationPublicKey,
        destinationIdentityPublicKey: fence.destinationIdentityPublicKey,
        destinationMessagingPublicKey: fence.destinationMessagingPublicKey, sourceGeneration: generation,
        custodyProfile: "managed" as const, capturedAt: this.now().toISOString(), tables };
      const manifest: ManagedTransferManifest = { ...base,
        historyCheckpointDigest: encodeBase64Url(historyCheckpoint(base)) };
      const bytes = new TextEncoder().encode(JSON.stringify(manifest));
      validateManagedTransferManifest(bytes);
      const hash = sha256(bytes);
      const secret = await this.encryptor.decrypt(fence.accountId, messaging.role, messaging.algorithm,
        messaging.publicKey, messaging);
      let signature: Uint8Array;
      try { signature = new Uint8Array(await crypto.subtle.sign("Ed25519",
        await importEd25519PrivateKey(secret), managedSnapshotSignatureInput(hash))); }
      finally { secret.fill(0); }
      await tx`INSERT INTO provider_migration_exports(transfer_id,did,manifest_bytes,manifest_digest,
        source_messaging_public_key,signature,signing_plc_document,signing_plc_data,signing_plc_operation_log,custody_profile)
        VALUES (${fence.transferId},${fence.did},${bytes},${hash},${messaging.publicKey},${signature},
          ${JSON.stringify(resolved.evidence.document)}::jsonb,${JSON.stringify(resolved.evidence.data)}::jsonb,
          ${JSON.stringify(resolved.evidence.log)}::jsonb,'managed')`;
      await tx`UPDATE provider_migration_fences SET state='exported',snapshot_digest=${hash},updated_at=clock_timestamp()
        WHERE transfer_id=${fence.transferId} AND state='fenced'`;
      return { bytes, digest: hash, signature, sourceMessagingPublicKey: messaging.publicKey };
    });
  }
}

async function collectManagedTables(tx: SQL, did: string, accountId: string): Promise<ManagedTransferTables> {
  const collect = async (query: Promise<{ row: Record<string, unknown> }[]>) => (await query).map((entry) => entry.row);
  const provider_accounts = await collect(tx`SELECT to_jsonb(t) AS row FROM provider_accounts t WHERE id=${accountId}`);
  const account_keys = await collect(tx`SELECT (to_jsonb(t)-'encrypted_private_key'-'encryption_nonce'-'encryption_version'-'kek_id') AS row
    FROM account_keys t WHERE account_id=${accountId} ORDER BY role`);
  const managed_custody_evidence = await collect(tx`SELECT to_jsonb(t) AS row FROM managed_custody_evidence t WHERE account_id=${accountId}`);
  const plc_operation_evidence = await collect(tx`SELECT to_jsonb(t) AS row FROM plc_operation_evidence t WHERE account_id=${accountId} ORDER BY created_at,id`);
  const address_bindings = await collect(tx`SELECT to_jsonb(t) AS row FROM address_bindings t WHERE account_id=${accountId} ORDER BY created_at,id`);
  const sender_profiles = await collect(tx`SELECT to_jsonb(t) AS row FROM sender_profiles t WHERE account_id=${accountId} ORDER BY revision`);
  const ownedGrants = await collect(tx`SELECT to_jsonb(t) AS row FROM grant_lineages t WHERE local_account_id=${accountId} ORDER BY grant_id`);
  const collocatedGrants = await collect(tx`SELECT to_jsonb(lineage)||jsonb_build_object('local_account_id',${accountId}::text,'local_role','grantee') AS row
    FROM grant_lineages lineage JOIN collocated_grant_receivers local USING(grant_id)
    WHERE local.grantee_account_id=${accountId} ORDER BY lineage.grant_id`);
  const ownedRevisions = await collect(tx`SELECT to_jsonb(t) AS row FROM grant_revisions t JOIN grant_lineages owner USING(grant_id)
    WHERE owner.local_account_id=${accountId} ORDER BY t.grant_id,t.revision`);
  const collocatedRevisions = await collect(tx`SELECT to_jsonb(t) AS row FROM grant_revisions t
    JOIN collocated_grant_receivers local USING(grant_id) WHERE local.grantee_account_id=${accountId} ORDER BY t.grant_id,t.revision`);
  const ownedConsent = await collect(tx`SELECT to_jsonb(t) AS row FROM grant_consent_evidence t JOIN grant_lineages owner USING(grant_id)
    WHERE owner.local_account_id=${accountId} ORDER BY t.grant_id,t.revision`);
  const collocatedConsent = await collect(tx`SELECT to_jsonb(t) AS row FROM grant_consent_evidence t
    JOIN collocated_grant_receivers local USING(grant_id) WHERE local.grantee_account_id=${accountId} ORDER BY t.grant_id,t.revision`);
  const grant_publications = await collect(tx`SELECT (to_jsonb(t)-'lease_token'-'lease_expires_at') AS row FROM grant_publications t JOIN grant_lineages owner USING(grant_id)
    WHERE owner.local_account_id=${accountId} ORDER BY t.grant_id,t.revision`);
  const detached_bodies = await collect(tx`SELECT to_jsonb(t) AS row FROM detached_bodies t WHERE sender_account_id=${accountId} ORDER BY digest`);
  const body_authorizations = await collect(tx`SELECT to_jsonb(t) AS row FROM body_authorizations t WHERE sender_account_id=${accountId} ORDER BY token_hash`);
  const sent_envelopes = await collect(tx`SELECT to_jsonb(t) AS row FROM sent_envelopes t WHERE sender_account_id=${accountId} ORDER BY sender_did,message_id`);
  const received_envelopes = await collect(tx`SELECT to_jsonb(t) AS row FROM received_envelopes t WHERE local_account_id=${accountId} ORDER BY sender_did,message_id`);
  const reply_capabilities = await collect(tx`SELECT to_jsonb(t) AS row FROM reply_capabilities t WHERE original_sender_did=${did} ORDER BY original_message_id`);
  const delivery_work = await collect(tx`SELECT (to_jsonb(t)-'lease_token'-'lease_expires_at') AS row FROM delivery_work t JOIN received_envelopes owner USING(sender_did,message_id)
    WHERE owner.local_account_id=${accountId} ORDER BY t.sender_did,t.message_id`);
  const verified_body_provenance = await collect(tx`SELECT to_jsonb(t) AS row FROM verified_body_provenance t WHERE recipient_did=${did} ORDER BY sender_did,digest`);
  const delivered_messages = await collect(tx`SELECT to_jsonb(t) AS row FROM delivered_messages t WHERE recipient_did=${did} ORDER BY sender_did,message_id`);
  const delivery_status_payloads = await collect(tx`SELECT to_jsonb(t) AS row FROM delivery_status_payloads t
    JOIN received_envelopes owner USING(sender_did,message_id) WHERE owner.local_account_id=${accountId}
    ORDER BY t.sender_did,t.message_id,t.revision`);
  const delivery_status_wrappers = await collect(tx`SELECT to_jsonb(t) AS row FROM delivery_status_wrappers t
    JOIN received_envelopes owner USING(sender_did,message_id) WHERE owner.local_account_id=${accountId}
    ORDER BY t.sender_did,t.message_id,t.revision,t.signing_public_key`);
  const terminal_status_publications = await collect(tx`SELECT (to_jsonb(t)-'lease_token'-'lease_expires_at') AS row FROM terminal_status_publications t
    JOIN received_envelopes owner USING(sender_did,message_id) WHERE owner.local_account_id=${accountId}
    ORDER BY t.sender_did,t.message_id`);
  const sent_delivery_status = await collect(tx`SELECT to_jsonb(t) AS row FROM sent_delivery_status t WHERE sender_did=${did} ORDER BY message_id`);
  const public_envelope_authority_evidence = await collect(tx`SELECT to_jsonb(t) AS row FROM public_envelope_authority_evidence t
    WHERE local_account_id=${accountId} ORDER BY sender_did,message_id,authority_did`);
  const public_grant_authority_evidence = await collect(tx`SELECT to_jsonb(t) AS row FROM public_grant_authority_evidence t
    WHERE local_account_id=${accountId} ORDER BY grant_id,revision,purpose`);
  const public_signing_authority_evidence = await collect(tx`SELECT to_jsonb(t) AS row FROM public_signing_authority_evidence t
    WHERE local_account_id=${accountId} ORDER BY action_type,representation_digest`);
  const public_plc_resolution_evidence = await collect(tx`SELECT to_jsonb(t) AS row FROM public_plc_resolution_evidence t WHERE evidence_digest IN(
    SELECT evidence_digest FROM public_envelope_authority_evidence WHERE local_account_id=${accountId}
    UNION SELECT evidence_digest FROM public_grant_authority_evidence WHERE local_account_id=${accountId}
    UNION SELECT evidence_digest FROM public_signing_authority_evidence WHERE local_account_id=${accountId}) ORDER BY evidence_digest`);
  return { provider_accounts, account_keys, managed_custody_evidence, plc_operation_evidence, address_bindings,
    sender_profiles, grant_lineages: [...ownedGrants, ...collocatedGrants],
    grant_revisions: [...ownedRevisions, ...collocatedRevisions],
    grant_consent_evidence: [...ownedConsent, ...collocatedConsent], grant_publications, detached_bodies,
    body_authorizations, sent_envelopes, received_envelopes, reply_capabilities, delivery_work,
    verified_body_provenance, delivered_messages, delivery_status_payloads, delivery_status_wrappers,
    terminal_status_publications, sent_delivery_status, public_plc_resolution_evidence,
    public_envelope_authority_evidence, public_grant_authority_evidence, public_signing_authority_evidence };
}
