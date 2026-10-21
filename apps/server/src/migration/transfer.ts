import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { cidForCbor } from "@atproto/common";
import { assureValidSig, def, validateOperationLog, type DocumentData } from "@did-plc/lib";
import * as dagCbor from "@ipld/dag-cbor";
import { createWebCryptoVerifier, decodeDeterministic, decodePayload, inspectSignedPayload,
  verifySignedPayload, type HailValue } from "@hailproto/codec";
import type { SQL } from "bun";
import { ed25519PublicKeyFromDidKey } from "../identity/did-key.js";
import type { KeyEncryptor } from "../identity/key-encryption.js";
import { importEd25519PrivateKey } from "../identity/keys.js";
import type { OnboardingRepository } from "../onboarding/repository.js";
import { canonicalizeHailServiceBase, type HailDidResolver } from "../plc/resolver.js";
import { bodyDigest, validateBodyBytes } from "../bodies/service.js";
import { parseJsonWithoutDuplicateKeys } from "../discovery/strict-json.js";
import { verifyPortableMigrationConsent, type SignedPortableConsent } from "./consent.js";
import type { MigrationFence } from "./fence.js";
import { PreparedMigrationTarget } from "./target-keys.js";
import {validateReturningEvidence} from "./return.js";
import { PUBLIC_EVIDENCE_LIMITS } from "../plc/read-evidence.js";

const context = (version: 2 | 3) => new TextEncoder().encode(`hail-migration-snapshot-v${version}\0`);

export const TRANSFER_TABLES = [
  "provider_accounts", "account_keys", "portable_custody_evidence", "plc_operation_evidence", "address_bindings",
  "sender_profiles", "grant_lineages", "grant_revisions", "grant_consent_evidence",
  "grant_publications", "detached_bodies", "body_authorizations", "sent_envelopes",
  "received_envelopes", "reply_capabilities", "delivery_work", "verified_body_provenance",
  "delivered_messages", "delivery_status_payloads", "delivery_status_wrappers",
  "terminal_status_publications", "sent_delivery_status",
] as const;
export const TRANSFER_AUTHORITY_TABLES = [
  "public_plc_resolution_evidence", "public_envelope_authority_evidence",
  "public_grant_authority_evidence", "public_signing_authority_evidence",
] as const;
type TransferTable = (typeof TRANSFER_TABLES)[number];
type AuthorityTable = (typeof TRANSFER_AUTHORITY_TABLES)[number];
type TransferTables = Record<TransferTable, Record<string, unknown>[]> &
  Partial<Record<AuthorityTable, Record<string, unknown>[]>>;

export interface TransferManifest {
  version: 2 | 3;
  transferId: string;
  did: string;
  accountId: string;
  sourceServiceBase: string;
  destinationServiceBase: string;
  destinationRotationPublicKey: string;
  destinationMessagingPublicKey: string;
  custodyProfile: "portable";
  capturedAt: string;
  tables: TransferTables;
}

export interface SignedTransferSnapshot {
  bytes: Uint8Array;
  digest: Uint8Array;
  signature: Uint8Array;
  sourceMessagingPublicKey: string;
}

interface ExportRow {
  manifest_bytes: Uint8Array;
  manifest_digest: Uint8Array;
  signature: Uint8Array;
  source_messaging_public_key: string;
}

function digest(bytes: Uint8Array): Uint8Array { return new Uint8Array(createHash("sha256").update(bytes).digest()); }

function signatureInput(hash: Uint8Array, version: 2 | 3): Uint8Array<ArrayBuffer> {
  const prefix = context(version);
  const message = new Uint8Array(prefix.length + hash.length);
  message.set(prefix);
  message.set(hash, prefix.length);
  return message;
}

function decodeHex(value: unknown, label: string): Uint8Array {
  if (typeof value !== "string" || !/^\\x(?:[0-9a-f]{2})+$/i.test(value)) {
    throw new Error(`Transfer ${label} is not a PostgreSQL byte string`);
  }
  return new Uint8Array(Buffer.from(value.slice(2), "hex"));
}

function envelopeKey(row: Record<string, unknown>): string {
  return `${String(row.sender_did)}\0${String(row.message_id)}`;
}

function mustHaveRows(table: string, rows: Record<string, unknown>[], known: Set<string>): void {
  if (rows.some((row) => !known.has(envelopeKey(row)))) {
    throw new Error(`Transfer ${table} references an absent envelope`);
  }
}

function hexKey(value: unknown, label: string): string {
  return Buffer.from(decodeHex(value, label)).toString("hex");
}

function validateAuthorityHistory(manifest: TransferManifest): void {
  const resolutions = manifest.tables.public_plc_resolution_evidence!;
  const envelopes = manifest.tables.public_envelope_authority_evidence!;
  const grants = manifest.tables.public_grant_authority_evidence!;
  const signing = manifest.tables.public_signing_authority_evidence!;
  const links = [...envelopes, ...grants, ...signing];
  if (links.some((row) => row.local_account_id !== manifest.accountId)) {
    throw new Error("Transfer authority history contains another account");
  }
  const referenced = new Set(links.map((row) => hexKey(row.evidence_digest, "authority evidence digest")));
  const retained = new Map<string, Record<string, unknown>>();
  for (const row of resolutions) {
    const digestKey = hexKey(row.evidence_digest, "resolution evidence digest");
    const bytes = decodeHex(row.bundle_bytes, "resolution evidence bundle");
    if (!Buffer.from(digest(bytes)).equals(Buffer.from(decodeHex(row.evidence_digest, "resolution evidence digest")))) {
      throw new Error("Transfer resolution evidence digest does not match its bundle");
    }
    const bundle = decodeDeterministic(bytes, PUBLIC_EVIDENCE_LIMITS) as Record<string, HailValue>;
    if (bundle.type !== "hail.public-plc-resolution" || bundle.version !== 1 ||
      bundle.policy !== "strict-public-v1" || bundle.did !== row.did ||
      bundle.operation_cid !== row.operation_cid || typeof bundle.verified_at !== "string" ||
      typeof row.verified_at !== "string" || Date.parse(bundle.verified_at) !== Date.parse(row.verified_at) ||
      retained.has(digestKey)) {
      throw new Error("Transfer resolution evidence metadata is invalid or duplicated");
    }
    retained.set(digestKey, row);
  }
  if (retained.size !== referenced.size || [...referenced].some((key) => !retained.has(key))) {
    throw new Error("Transfer authority history has missing or unreferenced resolution evidence");
  }
  for (const row of links) {
    const resolution = retained.get(hexKey(row.evidence_digest, "authority evidence digest"));
    if (!resolution || resolution.did !== row.authority_did) {
      throw new Error("Transfer authority link names the wrong retained DID evidence");
    }
  }
  const representations = {
    envelope: new Set([...manifest.tables.sent_envelopes, ...manifest.tables.received_envelopes]
      .map((row) => Buffer.from(digest(decodeHex(row.envelope_cose, "envelope representation"))).toString("hex"))),
    grant: new Set(manifest.tables.grant_revisions.map((row) => hexKey(row.representation_digest, "Grant authority digest"))),
    "address-binding": new Set(manifest.tables.address_bindings.map((row) => Buffer.from(digest(decodeHex(row.cose, "Address Binding representation"))).toString("hex"))),
    "sender-profile": new Set(manifest.tables.sender_profiles.map((row) => Buffer.from(digest(decodeHex(row.cose, "Sender Profile representation"))).toString("hex"))),
    "delivery-status": new Set(manifest.tables.delivery_status_wrappers.map((row) => Buffer.from(digest(decodeHex(row.cose, "Delivery Status representation"))).toString("hex"))),
  };
  if (envelopes.some((row) => !representations.envelope.has(hexKey(row.representation_digest, "envelope authority digest"))) ||
    grants.some((row) => !representations.grant.has(hexKey(row.representation_digest, "Grant authority digest"))) ||
    signing.some((row) => !representations[row.action_type as keyof typeof representations]?.has(
      hexKey(row.representation_digest, "signing authority digest")))) {
    throw new Error("Transfer authority history does not match a retained signed representation");
  }
}

export function validateTransferManifest(bytes: Uint8Array): TransferManifest {
  if (bytes.length < 1 || bytes.length > 67_108_864) throw new Error("Transfer manifest exceeds its size limit");
  const value = parseJsonWithoutDuplicateKeys(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid transfer manifest");
  const manifest = value as TransferManifest;
  const tables = manifest.version === 3 ? [...TRANSFER_TABLES, ...TRANSFER_AUTHORITY_TABLES] : TRANSFER_TABLES;
  if (![2, 3].includes(manifest.version) ||
    !/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/.test(manifest.transferId) ||
    !/^did:plc:[a-z2-7]{24}$/.test(manifest.did) ||
    !/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/.test(manifest.accountId) ||
    typeof manifest.capturedAt !== "string" ||
    manifest.custodyProfile !== "portable" ||
    typeof manifest.destinationRotationPublicKey !== "string" ||
    !manifest.destinationRotationPublicKey.startsWith("did:key:z") ||
    typeof manifest.destinationMessagingPublicKey !== "string" ||
    !manifest.tables || typeof manifest.tables !== "object" || Array.isArray(manifest.tables) ||
    Object.keys(manifest.tables).length !== tables.length ||
    tables.some((table) => !Array.isArray(manifest.tables[table]))) {
    throw new Error("Transfer manifest has an invalid or incomplete serialization domain");
  }
  if (canonicalizeHailServiceBase(manifest.sourceServiceBase) !== manifest.sourceServiceBase ||
    canonicalizeHailServiceBase(manifest.destinationServiceBase) !== manifest.destinationServiceBase ||
    manifest.sourceServiceBase === manifest.destinationServiceBase) {
    throw new Error("Transfer service bases are invalid");
  }
  const account = manifest.tables.provider_accounts;
  if (account.length !== 1 || account[0]?.id !== manifest.accountId || account[0]?.did !== manifest.did ||
    account[0]?.onboarding_state !== "active" || account[0]?.activation_verification_mode !== "public") {
    throw new Error("Transfer does not contain one active local account");
  }
  const keys = manifest.tables.account_keys;
  if (keys.length !== 2 || new Set(keys.map((key) => key.role)).size !== 2 ||
    ["plc-rotation", "hail-messaging"].some((role) => !keys.some((key) => key.role === role)) ||
    keys.some((key) => key.account_id !== manifest.accountId ||
      "encrypted_private_key" in key || "encryption_nonce" in key || "kek_id" in key)) {
    throw new Error("Portable transfer contains an unexpected private key or missing provider key");
  }
  const custody = manifest.tables.portable_custody_evidence;
  if (custody.length !== 1 || custody[0]?.account_id !== manifest.accountId ||
    typeof custody[0].user_recovery_public_key !== "string" ||
    typeof custody[0].user_identity_public_key !== "string" ||
    custody[0].user_identity_public_key === keys.find((key) => key.role === "hail-messaging")?.public_key ||
    !["independent", "poc-local"].includes(String(custody[0].monitor_verification_mode)) ||
    typeof custody[0].monitor_origin !== "string" ||
    typeof custody[0].monitor_public_key !== "string" ||
    !custody[0].monitor_confirmed_at || !custody[0].backup_confirmed_at) {
    throw new Error("Portable transfer lacks independent user custody evidence");
  }
  for (const table of ["address_bindings", "sender_profiles", "plc_operation_evidence"] as const) {
    if (manifest.tables[table].some((row) => row.account_id !== manifest.accountId)) {
      throw new Error(`Transfer ${table} contains another account`);
    }
  }
  const grants = new Set(manifest.tables.grant_lineages.map((row) => row.grant_id));
  if (manifest.tables.grant_lineages.some((row) => row.local_account_id !== manifest.accountId) ||
    ["grant_revisions", "grant_consent_evidence", "grant_publications"].some((table) =>
      manifest.tables[table as "grant_revisions"].some((row) => !grants.has(row.grant_id)))) {
    throw new Error("Transfer Grant lineage is incomplete or belongs to another account");
  }
  for (const row of manifest.tables.grant_revisions) {
    const representation = decodeHex(row.cose, "Grant representation");
    const signed = inspectSignedPayload("hail.grant", representation).payload;
    if (signed.grant_id !== row.grant_id || signed.revision !== row.revision ||
      !Buffer.from(digest(representation)).equals(Buffer.from(decodeHex(row.representation_digest, "Grant digest")))) {
      throw new Error("Transfer Grant representation does not match its lineage");
    }
  }
  const revisions = new Set(manifest.tables.grant_revisions.map((row) => `${row.grant_id}\0${row.revision}`));
  for (const lineage of manifest.tables.grant_lineages) {
    const current = manifest.tables.grant_revisions.find((row) => row.grant_id === lineage.grant_id &&
      row.revision === lineage.current_revision);
    if (!current || current.status !== lineage.current_status ||
      !Buffer.from(decodeHex(current.representation_digest, "current Grant digest")).equals(
        Buffer.from(decodeHex(lineage.current_digest, "lineage digest")))) {
      throw new Error("Transfer Grant pointer does not identify its current revision");
    }
  }
  if (manifest.tables.grant_consent_evidence.some((row) => !revisions.has(`${row.grant_id}\0${row.revision}`)) ||
    manifest.tables.grant_publications.some((row) => !revisions.has(`${row.grant_id}\0${row.revision}`))) {
    throw new Error("Transfer Grant evidence or publication lacks its revision");
  }
  const bodies = new Set<string>();
  for (const row of manifest.tables.detached_bodies) {
    const body = decodeHex(row.body_bytes, "body bytes");
    validateBodyBytes(body);
    const bodyHash = decodeHex(row.digest, "body digest");
    if (row.sender_account_id !== manifest.accountId ||
      !Buffer.from(bodyDigest(body)).equals(Buffer.from(bodyHash))) throw new Error("Transfer body integrity failed");
    bodies.add(Buffer.from(bodyHash).toString("hex"));
  }
  for (const row of manifest.tables.body_authorizations) {
    if (row.sender_account_id !== manifest.accountId ||
      !bodies.has(Buffer.from(decodeHex(row.body_digest, "authorized body digest")).toString("hex"))) {
      throw new Error("Transfer body authorization lacks local provenance");
    }
  }
  for (const [table, accountField, partyField] of [
    ["sent_envelopes", "sender_account_id", "sender_did"],
    ["received_envelopes", "local_account_id", "recipient_did"],
  ] as const) {
    for (const row of manifest.tables[table]) {
      const cose = decodeHex(row.envelope_cose, "envelope representation");
      const signed = inspectSignedPayload("hail.envelope", cose);
      if (row[accountField] !== manifest.accountId || row[partyField] !== manifest.did ||
        signed.payload.message_id !== row.message_id ||
        signed.payload.from !== row.sender_did || signed.payload.to !== row.recipient_did ||
        !Buffer.from(digest(signed.payloadBytes)).equals(Buffer.from(decodeHex(row.envelope_digest, "envelope digest"))) ||
        (table === "received_envelopes" && !Buffer.from(digest(signed.payloadBytes)).equals(
          Buffer.from(decodeHex(row.payload_digest, "replay payload digest"))))) {
        throw new Error(`Transfer ${table} has an invalid owner or signed payload`);
      }
    }
  }
  const sent = new Set(manifest.tables.sent_envelopes.map(envelopeKey));
  const received = new Set(manifest.tables.received_envelopes.map(envelopeKey));
  mustHaveRows("delivery_work", manifest.tables.delivery_work, received);
  mustHaveRows("delivered_messages", manifest.tables.delivered_messages, received);
  mustHaveRows("delivery_status_payloads", manifest.tables.delivery_status_payloads, received);
  mustHaveRows("delivery_status_wrappers", manifest.tables.delivery_status_wrappers, received);
  mustHaveRows("terminal_status_publications", manifest.tables.terminal_status_publications, received);
  mustHaveRows("sent_delivery_status", manifest.tables.sent_delivery_status, sent);
  const provenance = new Set<string>();
  for (const row of manifest.tables.verified_body_provenance) {
    const bytes = decodeHex(row.body_bytes, "verified body");
    const bodyHash = decodeHex(row.digest, "verified body digest");
    if (row.recipient_did !== manifest.did ||
      !Buffer.from(bodyDigest(bytes)).equals(Buffer.from(bodyHash))) {
      throw new Error("Transfer verified body lacks valid recipient provenance");
    }
    validateBodyBytes(bytes);
    provenance.add(`${row.sender_did}\0${Buffer.from(bodyHash).toString("hex")}`);
  }
  for (const row of manifest.tables.delivered_messages) {
    const bodyHash = decodeHex(row.body_digest, "delivered body digest");
    if (row.recipient_did !== manifest.did ||
      !provenance.has(`${row.sender_did}\0${Buffer.from(bodyHash).toString("hex")}`)) {
      throw new Error("Transfer delivered message lacks verified body provenance");
    }
  }
  const payloads = new Map<string, Uint8Array>();
  for (const row of manifest.tables.delivery_status_payloads) {
    const bytes = decodeHex(row.payload_bytes, "status payload");
    const status = decodePayload("hail.delivery-status", bytes);
    if (status.from !== manifest.did || status.to !== row.sender_did ||
      status.message_id !== row.message_id || status.revision !== row.revision) {
      throw new Error("Transfer status payload does not match its accepted envelope");
    }
    payloads.set(`${envelopeKey(row)}\0${row.revision}`, bytes);
  }
  for (const row of manifest.tables.delivery_status_wrappers) {
    const signed = inspectSignedPayload("hail.delivery-status", decodeHex(row.cose, "status wrapper"));
    const original = payloads.get(`${envelopeKey(row)}\0${row.revision}`);
    if (!original || !Buffer.from(original).equals(Buffer.from(signed.payloadBytes))) {
      throw new Error("Transfer status wrapper does not match the immutable revision");
    }
  }
  for (const row of manifest.tables.sent_delivery_status) {
    const signed = inspectSignedPayload("hail.delivery-status", decodeHex(row.cose, "received status"));
    const sentRow = manifest.tables.sent_envelopes.find((item) => envelopeKey(item) === envelopeKey(row));
    if (!sentRow || signed.payload.from !== row.recipient_did || signed.payload.to !== manifest.did ||
      signed.payload.message_id !== row.message_id || signed.payload.revision !== row.current_revision ||
      signed.payload.state !== row.current_state ||
      !Buffer.from(signed.payloadBytes).equals(Buffer.from(decodeHex(row.payload_bytes, "received status payload"))) ||
      !Buffer.from(decodeHex(sentRow.envelope_digest, "sent envelope digest")).equals(
        Buffer.from(signed.payload.envelope_digest.value))) {
      throw new Error("Transfer received status does not correlate to its sent envelope");
    }
  }
  for (const row of manifest.tables.reply_capabilities) {
    const original = manifest.tables.sent_envelopes.find((entry) => entry.sender_did === row.original_sender_did &&
      entry.message_id === row.original_message_id);
    if (!original || row.original_sender_did !== manifest.did ||
      original.recipient_did !== row.permitted_recipient_did) {
      throw new Error("Transfer reply invitation lacks its signed original");
    }
    const payload = inspectSignedPayload("hail.envelope", decodeHex(original.envelope_cose, "reply invitation")).payload;
    if (!payload.reply.allowed || payload.reply.until !== Number(row.reply_until) ||
      (row.state !== "available" && !received.has(`${row.claimed_sender_did}\0${row.claimed_message_id}`))) {
      throw new Error("Transfer reply claim conflicts with its signed permission or accepted reply");
    }
  }
  if (manifest.version === 3) validateAuthorityHistory(manifest);
  return manifest;
}

export class MigrationTransferService {
  constructor(
    private readonly sql: SQL,
    private readonly accounts: Pick<OnboardingRepository, "getKey">,
    private readonly encryptor: KeyEncryptor,
    private readonly resolver: HailDidResolver,
    private readonly serviceBase: string,
    private readonly allowReturns=false,
  ) {}

  async exportFenced(fence: MigrationFence): Promise<SignedTransferSnapshot> {
    const resolved = await this.resolver.resolve(fence.did);
    if (resolved.did !== fence.did || resolved.serviceBase !== this.serviceBase) {
      throw new Error("Current PLC does not designate this export source");
    }
    const messagingKey = await this.accounts.getKey(fence.accountId, "hail-messaging");
    if (messagingKey.algorithm !== "ed25519" || messagingKey.publicKey !== resolved.messagingDidKey) {
      throw new Error("Current PLC does not authorize the source messaging key");
    }
    return this.sql.begin(async (tx) => {
      const current = await tx<{ state: string; account_id: string; destination_service_base: string;
        destination_rotation_public_key: string; destination_messaging_public_key: string }[]>`
        SELECT state, account_id, destination_service_base, destination_rotation_public_key,
          destination_messaging_public_key FROM provider_migration_fences
        WHERE did = ${fence.did} AND transfer_id = ${fence.transferId} FOR UPDATE
      `;
      if (!current[0] || current[0].account_id !== fence.accountId ||
        current[0].destination_service_base !== fence.destinationServiceBase ||
        current[0].destination_rotation_public_key !== fence.destinationRotationPublicKey ||
        current[0].destination_messaging_public_key !== fence.destinationMessagingPublicKey) {
        throw new Error("Migration fence changed");
      }
      if (current[0].state === "exported") {
        const existing = await tx<ExportRow[]>`
          SELECT manifest_bytes, manifest_digest, signature, source_messaging_public_key
          FROM provider_migration_exports WHERE transfer_id = ${fence.transferId}
        `;
        if (!existing[0]) throw new Error("Exported migration snapshot is missing");
        return { bytes: new Uint8Array(existing[0].manifest_bytes), digest: new Uint8Array(existing[0].manifest_digest),
          signature: new Uint8Array(existing[0].signature), sourceMessagingPublicKey: existing[0].source_messaging_public_key };
      }
      if (current[0].state !== "fenced") throw new Error("Migration source has retired");
      const tables = await this.collect(tx, fence.did, fence.accountId);
      const manifest: TransferManifest = { version: 3, did: fence.did, accountId: fence.accountId,
        transferId: fence.transferId, sourceServiceBase: this.serviceBase,
        destinationServiceBase: fence.destinationServiceBase,
        destinationRotationPublicKey: fence.destinationRotationPublicKey,
        destinationMessagingPublicKey: fence.destinationMessagingPublicKey,
        custodyProfile: "portable", capturedAt: new Date().toISOString(), tables };
      const bytes = new TextEncoder().encode(JSON.stringify(manifest));
      validateTransferManifest(bytes);
      const hash = digest(bytes);
      const secret = await this.encryptor.decrypt(fence.accountId, messagingKey.role, messagingKey.algorithm,
        messagingKey.publicKey, messagingKey);
      let signature: Uint8Array;
      try {
        const key = await importEd25519PrivateKey(secret);
        signature = new Uint8Array(await crypto.subtle.sign("Ed25519", key, signatureInput(hash, manifest.version)));
      } finally { secret.fill(0); }
      await tx`
        INSERT INTO provider_migration_exports (transfer_id, did, manifest_bytes, manifest_digest,
          source_messaging_public_key, signature, signing_plc_document, signing_plc_data, signing_plc_operation_log)
        VALUES (${fence.transferId}, ${fence.did}, ${bytes}, ${hash}, ${messagingKey.publicKey},
          ${signature}, ${JSON.stringify(resolved.evidence.document)}::jsonb,
          ${JSON.stringify(resolved.evidence.data)}::jsonb, ${JSON.stringify(resolved.evidence.log)}::jsonb)
      `;
      await tx`UPDATE provider_migration_fences SET state = 'exported', snapshot_digest = ${hash},
        updated_at = clock_timestamp() WHERE transfer_id = ${fence.transferId}`;
      return { bytes, digest: hash, signature, sourceMessagingPublicKey: messagingKey.publicKey };
    });
  }

  async stageImport(snapshot: SignedTransferSnapshot, userConsent: SignedPortableConsent,
    operationBytes: Uint8Array, destinationBinding: Uint8Array): Promise<TransferManifest> {
    const hash = digest(snapshot.bytes);
    if (hash.length !== 32 || !Buffer.from(hash).equals(Buffer.from(snapshot.digest)) ||
      snapshot.signature.length !== 64) throw new Error("Transfer digest or signature has an invalid shape");
    const manifest = validateTransferManifest(snapshot.bytes);
    if (manifest.destinationServiceBase !== this.serviceBase) throw new Error("Snapshot names another destination");
    const resolved = await this.resolver.resolve(manifest.did);
    if (resolved.did !== manifest.did || resolved.serviceBase !== manifest.sourceServiceBase ||
      resolved.messagingDidKey !== snapshot.sourceMessagingPublicKey) {
      throw new Error("Current PLC state does not authenticate the source snapshot");
    }
    const key = await ed25519PublicKeyFromDidKey(snapshot.sourceMessagingPublicKey);
    if (!await crypto.subtle.verify("Ed25519", key, Uint8Array.from(snapshot.signature), signatureInput(hash, manifest.version))) {
      throw new Error("Migration snapshot source signature is invalid");
    }
    const consent = await verifyPortableMigrationConsent(userConsent, resolved.identityDidKey, Math.floor(Date.now() / 1000));
    const custody = manifest.tables.portable_custody_evidence[0]!;
    if (destinationBinding.length < 1 || destinationBinding.length > 16_384) {
      throw new Error("Destination Address Binding exceeds the COSE size limit");
    }
    const binding = await verifySignedPayload("hail.address-binding", destinationBinding,
      createWebCryptoVerifier(async (kid) => {
        if (kid !== `${manifest.did}#hail-identity`) throw new Error("Unexpected Address Binding signer");
        return ed25519PublicKeyFromDidKey(resolved.identityDidKey);
      }));
    const now = Math.floor(Date.now() / 1000);
    if (binding.payload.address !== consent.destination_address || binding.payload.did !== manifest.did ||
      binding.payload.issued_at > now + 300 || binding.payload.expires_at <= now) {
      throw new Error("User-signed destination Address Binding does not match migration consent");
    }
    const bindingDigest = digest(destinationBinding);
    const cutoverOperationDigest = await this.validateCutoverOperation(operationBytes, manifest, resolved);
    if (consent.did !== manifest.did || consent.transfer_id !== manifest.transferId ||
      !Buffer.from(consent.snapshot_digest).equals(Buffer.from(hash)) ||
      !Buffer.from(consent.plc_operation_sha256).equals(Buffer.from(cutoverOperationDigest)) ||
      consent.source_service_base !== manifest.sourceServiceBase ||
      consent.destination_service_base !== manifest.destinationServiceBase ||
      consent.destination_rotation_key !== manifest.destinationRotationPublicKey ||
      consent.destination_messaging_key !== manifest.destinationMessagingPublicKey ||
      consent.user_recovery_key !== custody.user_recovery_public_key ||
      consent.user_identity_key !== custody.user_identity_public_key) {
      throw new Error("User migration consent does not match the exact snapshot and destination");
    }
    await new PreparedMigrationTarget(this.sql, this.encryptor, this.serviceBase).assertOwnership({
      transferId: manifest.transferId, did: manifest.did,
      destinationServiceBase: manifest.destinationServiceBase,
      rotationPublicKey: manifest.destinationRotationPublicKey,
      messagingPublicKey: manifest.destinationMessagingPublicKey,
    });
    await this.sql.begin(async (tx) => {
      const reservation = await tx<{ canonical_address: string; state: string }[]>`
        SELECT canonical_address, state FROM transfer_address_reservations
        WHERE transfer_id = ${manifest.transferId} AND did = ${manifest.did} FOR UPDATE`;
      if (reservation[0]?.canonical_address !== consent.destination_address ||
        reservation[0].state !== "submitted") {
        throw new Error("Destination address has no authenticated submitted reservation");
      }
      const targetKey = await tx<{ state: string; did: string; rotation_public_key: string;
        messaging_public_key: string }[]>`
        SELECT state, did, rotation_public_key, messaging_public_key
        FROM prepared_migration_target_keys WHERE transfer_id = ${manifest.transferId} FOR UPDATE
      `;
      if (!targetKey[0] || !["prepared", "staged"].includes(targetKey[0].state) ||
        targetKey[0].did !== manifest.did ||
        targetKey[0].rotation_public_key !== manifest.destinationRotationPublicKey ||
        targetKey[0].messaging_public_key !== manifest.destinationMessagingPublicKey) {
        throw new Error("Destination operational key preparation changed before staging");
      }
      const existingAccount = await tx<{ id: string }[]>`SELECT id FROM provider_accounts WHERE did = ${manifest.did}`;
      if (existingAccount.length) {
        if(!this.allowReturns)throw new Error("Migration target already serves this DID");
        await validateReturningEvidence(tx,manifest);
      }
      const existing = await tx<{ manifest_bytes: Uint8Array; signed_plc_operation_bytes: Uint8Array | null;
        destination_binding_cose: Uint8Array | null;
        state: string }[]>`
        SELECT manifest_bytes, signed_plc_operation_bytes, destination_binding_cose, state FROM pending_migration_imports
        WHERE transfer_id = ${manifest.transferId}
      `;
      if (existing[0]) {
        if (existing[0].state !== "staged" ||
          !Buffer.from(existing[0].manifest_bytes).equals(Buffer.from(snapshot.bytes)) ||
          !existing[0].signed_plc_operation_bytes ||
          !Buffer.from(existing[0].signed_plc_operation_bytes).equals(Buffer.from(operationBytes)) ||
          !existing[0].destination_binding_cose ||
          !Buffer.from(existing[0].destination_binding_cose).equals(Buffer.from(destinationBinding))) {
          throw new Error("Migration import conflicts with previously staged bytes");
        }
        return;
      }
      await tx`
        INSERT INTO pending_migration_imports (transfer_id, did, source_service_base,
          destination_service_base, manifest_bytes, manifest_digest, source_messaging_public_key,
          signature, state, verified_plc_document, verified_plc_data, verified_plc_operation_log,
          user_consent_payload, user_consent_signature, user_identity_public_key,
          signed_plc_operation_bytes, signed_plc_operation_digest,
          destination_address, destination_binding_cose, destination_binding_digest)
        VALUES (${manifest.transferId}, ${manifest.did}, ${manifest.sourceServiceBase},
          ${manifest.destinationServiceBase}, ${snapshot.bytes}, ${hash}, ${snapshot.sourceMessagingPublicKey},
          ${snapshot.signature}, 'staged', ${JSON.stringify(resolved.evidence.document)}::jsonb,
          ${JSON.stringify(resolved.evidence.data)}::jsonb,
          ${JSON.stringify(resolved.evidence.log)}::jsonb,
          ${userConsent.payloadBytes}, ${userConsent.signature}, ${consent.user_identity_key},
          ${operationBytes}, ${cutoverOperationDigest}, ${consent.destination_address},
          ${destinationBinding}, ${bindingDigest})
      `;
      await tx`UPDATE prepared_migration_target_keys SET state = 'staged'
        WHERE transfer_id = ${manifest.transferId} AND state = 'prepared'`;
    });
    return manifest;
  }

  async invalidateStaged(transferId: string): Promise<void> {
    const rows = await this.sql`
      UPDATE pending_migration_imports SET state = 'invalidated', invalidated_at = clock_timestamp()
      WHERE transfer_id = ${transferId} AND state = 'staged' RETURNING transfer_id
    `;
    if (rows.length !== 1) throw new Error("No staged migration import can be invalidated");
  }

  private async validateCutoverOperation(bytes: Uint8Array, manifest: TransferManifest,
    resolved: Awaited<ReturnType<HailDidResolver["resolve"]>>): Promise<Uint8Array> {
    if (bytes.length < 1 || bytes.length > 16_000) throw new Error("Signed PLC cutover operation exceeds its limit");
    const parsed = parseJsonWithoutDuplicateKeys(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    const operation = def.operation.parse(parsed);
    const before = resolved.evidence.data as DocumentData;
    const log = resolved.evidence.log.map((entry) => def.compatibleOpOrTombstone.parse(entry));
    const last = log[log.length - 1];
    const oldRotation = manifest.tables.account_keys.find((key) => key.role === "plc-rotation")?.public_key;
    if (!last || typeof oldRotation !== "string" ||
      operation.prev !== (await cidForCbor(last)).toString() ||
      before.rotationKeys[0] !== manifest.tables.portable_custody_evidence[0]?.user_recovery_public_key) {
      throw new Error("Signed PLC cutover operation has an invalid predecessor or recovery key");
    }
    const rotationKeys = [...before.rotationKeys.filter((key) => key !== oldRotation),
      manifest.destinationRotationPublicKey];
    if (!isDeepStrictEqual(operation.rotationKeys, rotationKeys) ||
      !isDeepStrictEqual(operation.verificationMethods, {
        ...before.verificationMethods, "hail-messaging": manifest.destinationMessagingPublicKey,
      }) || !isDeepStrictEqual(operation.services, {
        ...before.services, hail: { type: "HailMessaging", endpoint: manifest.destinationServiceBase },
      }) || !isDeepStrictEqual(operation.alsoKnownAs, before.alsoKnownAs)) {
      throw new Error("PLC cutover changed unapproved identity state");
    }
    await assureValidSig([before.rotationKeys[0]!], operation);
    const result = await validateOperationLog(manifest.did, [...log, operation]);
    if (!result || result.verificationMethods["hail-identity"] !==
      manifest.tables.portable_custody_evidence[0]?.user_identity_public_key ||
      result.services.hail?.endpoint !== manifest.destinationServiceBase) {
      throw new Error("Signed PLC cutover does not validate to the requested destination");
    }
    const cbor = new Uint8Array(dagCbor.encode(operation));
    if (cbor.length > 7_500) throw new Error("Signed PLC cutover exceeds the directory operation limit");
    return digest(cbor);
  }

  private async collect(tx: SQL, did: string, accountId: string): Promise<TransferManifest["tables"]> {
    const collect = async (query: Promise<{ row: Record<string, unknown> }[]>) => (await query).map((entry) => entry.row);
    const account = await collect(tx`SELECT to_jsonb(t) AS row FROM provider_accounts t WHERE id = ${accountId}`);
    // Retain the old provider's public role metadata only. Neither old
    // operational secrets nor user-controlled key material is transferable.
    const keys = await collect(tx`SELECT (to_jsonb(t) - 'encrypted_private_key' - 'encryption_nonce' - 'kek_id') AS row
      FROM account_keys t WHERE account_id = ${accountId} ORDER BY role`);
    const custody = await collect(tx`SELECT to_jsonb(t) AS row FROM portable_custody_evidence t
      WHERE account_id = ${accountId}`);
    const plc = await collect(tx`SELECT to_jsonb(t) AS row FROM plc_operation_evidence t WHERE account_id = ${accountId} ORDER BY created_at, id`);
    const bindings = await collect(tx`SELECT to_jsonb(t) AS row FROM address_bindings t WHERE account_id = ${accountId} ORDER BY id`);
    const profiles = await collect(tx`SELECT to_jsonb(t) AS row FROM sender_profiles t WHERE account_id = ${accountId} ORDER BY revision`);
    const grants = await collect(tx`SELECT to_jsonb(t) AS row FROM grant_lineages t WHERE local_account_id = ${accountId} ORDER BY grant_id`);
    const receivedCollocated = await collect(tx`
      SELECT to_jsonb(lineage) || jsonb_build_object('local_account_id', ${accountId}::text,
        'local_role', 'grantee') AS row
      FROM grant_lineages lineage JOIN collocated_grant_receivers local USING (grant_id)
      WHERE local.grantee_account_id = ${accountId} ORDER BY lineage.grant_id`);
    const grantRevisions = await collect(tx`SELECT to_jsonb(t) AS row FROM grant_revisions t JOIN grant_lineages owner USING (grant_id)
      WHERE owner.local_account_id = ${accountId} ORDER BY t.grant_id, t.revision`);
    const receivedCollocatedRevisions = await collect(tx`SELECT to_jsonb(t) AS row FROM grant_revisions t
      JOIN collocated_grant_receivers local USING (grant_id)
      WHERE local.grantee_account_id = ${accountId} ORDER BY t.grant_id, t.revision`);
    const consent = await collect(tx`SELECT to_jsonb(t) AS row FROM grant_consent_evidence t JOIN grant_lineages owner USING (grant_id)
      WHERE owner.local_account_id = ${accountId} ORDER BY t.grant_id, t.revision`);
    const receivedCollocatedConsent = await collect(tx`SELECT to_jsonb(t) AS row FROM grant_consent_evidence t
      JOIN collocated_grant_receivers local USING (grant_id)
      WHERE local.grantee_account_id = ${accountId} ORDER BY t.grant_id, t.revision`);
    const grantOutbox = await collect(tx`SELECT to_jsonb(t) AS row FROM grant_publications t JOIN grant_lineages owner USING (grant_id)
      WHERE owner.local_account_id = ${accountId} ORDER BY t.grant_id, t.revision`);
    const bodies = await collect(tx`SELECT to_jsonb(t) AS row FROM detached_bodies t WHERE sender_account_id = ${accountId} ORDER BY digest`);
    const bodyAuth = await collect(tx`SELECT to_jsonb(t) AS row FROM body_authorizations t WHERE sender_account_id = ${accountId} ORDER BY token_hash`);
    const sent = await collect(tx`SELECT to_jsonb(t) AS row FROM sent_envelopes t WHERE sender_account_id = ${accountId} ORDER BY sender_did, message_id`);
    const received = await collect(tx`SELECT to_jsonb(t) AS row FROM received_envelopes t WHERE local_account_id = ${accountId} ORDER BY sender_did, message_id`);
    const replies = await collect(tx`SELECT to_jsonb(t) AS row FROM reply_capabilities t WHERE original_sender_did = ${did} ORDER BY original_message_id`);
    const work = await collect(tx`SELECT to_jsonb(t) AS row FROM delivery_work t JOIN received_envelopes owner
      ON owner.sender_did = t.sender_did AND owner.message_id = t.message_id
      WHERE owner.local_account_id = ${accountId} ORDER BY t.sender_did, t.message_id`);
    const provenance = await collect(tx`SELECT to_jsonb(t) AS row FROM verified_body_provenance t WHERE recipient_did = ${did} ORDER BY sender_did, digest`);
    const messages = await collect(tx`SELECT to_jsonb(t) AS row FROM delivered_messages t WHERE recipient_did = ${did} ORDER BY sender_did, message_id`);
    const statuses = await collect(tx`SELECT to_jsonb(t) AS row FROM delivery_status_payloads t JOIN received_envelopes owner
      ON owner.sender_did = t.sender_did AND owner.message_id = t.message_id
      WHERE owner.local_account_id = ${accountId} ORDER BY t.sender_did, t.message_id, t.revision`);
    const wrappers = await collect(tx`SELECT to_jsonb(t) AS row FROM delivery_status_wrappers t JOIN received_envelopes owner
      ON owner.sender_did = t.sender_did AND owner.message_id = t.message_id
      WHERE owner.local_account_id = ${accountId} ORDER BY t.sender_did, t.message_id, t.revision, t.signing_public_key`);
    const terminal = await collect(tx`SELECT to_jsonb(t) AS row FROM terminal_status_publications t JOIN received_envelopes owner
      ON owner.sender_did = t.sender_did AND owner.message_id = t.message_id
      WHERE owner.local_account_id = ${accountId} ORDER BY t.sender_did, t.message_id`);
    const sentStatus = await collect(tx`SELECT to_jsonb(t) AS row FROM sent_delivery_status t WHERE sender_did = ${did} ORDER BY message_id`);
    const envelopeAuthority = await collect(tx`SELECT to_jsonb(t) AS row FROM public_envelope_authority_evidence t
      WHERE local_account_id = ${accountId} ORDER BY sender_did, message_id, authority_did`);
    const grantAuthority = await collect(tx`SELECT to_jsonb(t) AS row FROM public_grant_authority_evidence t
      WHERE local_account_id = ${accountId} ORDER BY grant_id, revision, purpose`);
    const signingAuthority = await collect(tx`SELECT to_jsonb(t) AS row FROM public_signing_authority_evidence t
      WHERE local_account_id = ${accountId} ORDER BY action_type, representation_digest`);
    const resolutionAuthority = await collect(tx`SELECT to_jsonb(t) AS row FROM public_plc_resolution_evidence t
      WHERE evidence_digest IN (
        SELECT evidence_digest FROM public_envelope_authority_evidence WHERE local_account_id = ${accountId}
        UNION SELECT evidence_digest FROM public_grant_authority_evidence WHERE local_account_id = ${accountId}
        UNION SELECT evidence_digest FROM public_signing_authority_evidence WHERE local_account_id = ${accountId}
      ) ORDER BY evidence_digest`);
    return {
      provider_accounts: account, account_keys: keys, portable_custody_evidence: custody,
      plc_operation_evidence: plc,
      address_bindings: bindings, sender_profiles: profiles,
      grant_lineages: [...grants, ...receivedCollocated],
      grant_revisions: [...grantRevisions, ...receivedCollocatedRevisions],
      grant_consent_evidence: [...consent, ...receivedCollocatedConsent],
      grant_publications: grantOutbox, detached_bodies: bodies,
      body_authorizations: bodyAuth, sent_envelopes: sent,
      received_envelopes: received, reply_capabilities: replies, delivery_work: work,
      verified_body_provenance: provenance, delivered_messages: messages,
      delivery_status_payloads: statuses, delivery_status_wrappers: wrappers,
      terminal_status_publications: terminal, sent_delivery_status: sentStatus,
      public_plc_resolution_evidence: resolutionAuthority,
      public_envelope_authority_evidence: envelopeAuthority,
      public_grant_authority_evidence: grantAuthority,
      public_signing_authority_evidence: signingAuthority,
    };
  }
}
