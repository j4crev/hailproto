import {
  createWebCryptoSigner, createWebCryptoVerifier, encodePayload, signPayload,
  verifySignedPayload, inspectSignedPayload, type HailDeliveryStatus,
} from "@hailproto/codec";
import type { SQL } from "bun";
import { ed25519PublicKeyFromDidKey } from "../identity/did-key.js";
import type { KeyEncryptor } from "../identity/key-encryption.js";
import { importEd25519PrivateKey } from "../identity/keys.js";
import type { AccountKeyRecord } from "../onboarding/repository.js";
import type { HailDidResolver } from "../plc/resolver.js";
import { retainPublicSigningAuthority } from "../plc/signing-authority.js";
import { deliveryDeadline } from "./repository.js";

interface StatusRow {
  sender_did: string;
  message_id: string;
  recipient_did: string;
  local_account_id: string;
  envelope_digest: Uint8Array;
  envelope_cose: Uint8Array;
  accepted_at: Date;
  state: HailDeliveryStatus["state"];
  reason: string | null;
  status_revision: number;
  next_attempt_at: Date;
  transitioned_at: Date;
}

export interface StatusSigningAccounts {
  getKey(accountId: string, role: AccountKeyRecord["role"]): Promise<AccountKeyRecord>;
}

export class DeliveryStatusSigner {
  constructor(
    private readonly sql: SQL,
    private readonly accounts: StatusSigningAccounts,
    private readonly encryptor: KeyEncryptor,
    private readonly resolver: HailDidResolver,
    private readonly serviceBase: string,
  ) {}

  async signCurrent(senderDid: string, messageId: string): Promise<Uint8Array | null> {
    const rows = await this.sql<StatusRow[]>`
      SELECT received.sender_did, received.message_id, received.recipient_did,
        received.local_account_id, received.envelope_digest, received.envelope_cose, received.accepted_at,
        work.state, work.reason, work.status_revision, work.next_attempt_at, work.transitioned_at
      FROM received_envelopes received JOIN delivery_work work
        ON work.sender_did = received.sender_did AND work.message_id = received.message_id
      WHERE received.sender_did = ${senderDid} AND received.message_id = ${messageId}
        AND received.outcome = 'accepted'
    `;
    const row = rows[0];
    if (!row || !row.accepted_at) return null;
    const occurredAt = Math.floor((row.status_revision === 1 ? row.accepted_at : row.transitioned_at).getTime() / 1000);
    const common = {
      type: "hail.delivery-status" as const, version: 1 as const,
      message_id: messageId,
      envelope_digest: { algorithm: "sha-256" as const, value: new Uint8Array(row.envelope_digest) },
      from: row.recipient_did, to: row.sender_did,
      occurred_at: occurredAt,
    };
    let payload: HailDeliveryStatus;
    switch (row.state) {
      case "accepted":
        payload = { ...common, revision: 1, state: "accepted" }; break;
      case "on-hold":
        const deadline = deliveryDeadline(inspectSignedPayload("hail.envelope", row.envelope_cose).payload);
        payload = { ...common, revision: row.status_revision, state: "on-hold",
          reason: row.reason as Extract<HailDeliveryStatus, { state: "on-hold" }>["reason"],
          retry_at: Math.max(occurredAt, Math.min(deadline, Math.ceil(row.next_attempt_at.getTime() / 1000))) }; break;
      case "delivered":
        payload = { ...common, revision: row.status_revision, state: "delivered" }; break;
      case "failed":
        payload = { ...common, revision: row.status_revision, state: "failed",
          reason: row.reason as Extract<HailDeliveryStatus, { state: "failed" }>["reason"] }; break;
      case "cancelled":
        payload = { ...common, revision: row.status_revision, state: "cancelled",
          reason: row.reason as Extract<HailDeliveryStatus, { state: "cancelled" }>["reason"] }; break;
    }
    // An immutable status payload remains stable across messaging-key rotation.
    const payloadBytes = encodePayload("hail.delivery-status", payload);
    const account = await this.sql<{ id: string }[]>`
      SELECT id FROM provider_accounts WHERE id = ${row.local_account_id} AND did = ${row.recipient_did}
        AND onboarding_state = 'active' AND activation_verification_mode = 'public'
    `;
    if (!account[0]) throw new Error("Status signer is not publicly active");
    const key = await this.accounts.getKey(row.local_account_id, "hail-messaging");
    const resolved = await this.resolver.resolve(row.recipient_did);
    if (key.algorithm !== "ed25519" || key.publicKey !== resolved.messagingDidKey ||
      resolved.serviceBase !== this.serviceBase) throw new Error("Current PLC does not authorize status signing");
    const secret = await this.encryptor.decrypt(row.local_account_id, key.role, key.algorithm, key.publicKey, key);
    let cose: Uint8Array;
    try {
      cose = await signPayload("hail.delivery-status", payload,
        createWebCryptoSigner(`${row.recipient_did}#hail-messaging`, await importEd25519PrivateKey(secret)));
    } finally { secret.fill(0); }
    await verifySignedPayload("hail.delivery-status", cose,
      createWebCryptoVerifier(async (kid) => {
        if (kid !== `${row.recipient_did}#hail-messaging`) throw new Error("Wrong status signer");
        return ed25519PublicKeyFromDidKey(key.publicKey);
      }));
    if (cose.length > 16_384) throw new Error("Signed status exceeds 16 KiB");
    await this.sql.begin(async (tx) => {
      const existing = await tx<{ payload_bytes: Uint8Array }[]>`
        INSERT INTO delivery_status_payloads (sender_did, message_id, revision, payload_bytes)
        VALUES (${senderDid}, ${messageId}, ${payload.revision}, ${payloadBytes})
        ON CONFLICT (sender_did, message_id, revision) DO NOTHING
        RETURNING payload_bytes
      `;
      if (!existing[0]) {
        const stored = await tx<{ payload_bytes: Uint8Array }[]>`
          SELECT payload_bytes FROM delivery_status_payloads
          WHERE sender_did = ${senderDid} AND message_id = ${messageId} AND revision = ${payload.revision}
        `;
        if (!stored[0] || !Buffer.from(stored[0].payload_bytes).equals(Buffer.from(payloadBytes))) {
          throw new Error("Status revision conflicts with persisted payload");
        }
      }
      await tx`
        INSERT INTO delivery_status_wrappers (sender_did, message_id, revision, signing_public_key,
          cose, signing_plc_document, signing_plc_data, signing_plc_operation_log)
        VALUES (${senderDid}, ${messageId}, ${payload.revision}, ${key.publicKey}, ${cose},
          ${JSON.stringify(resolved.evidence.document)}::jsonb, ${JSON.stringify(resolved.evidence.data)}::jsonb,
          ${JSON.stringify(resolved.evidence.log)}::jsonb)
        ON CONFLICT (sender_did, message_id, revision, signing_public_key) DO NOTHING
      `;
      await retainPublicSigningAuthority(tx, {
        actionType: "delivery-status",
        localAccountId: row.local_account_id,
        did: row.recipient_did,
        role: "hail-messaging",
        key: key.publicKey,
        serviceBase: this.serviceBase,
        representation: cose,
        evidence: resolved.evidence,
      });
    });
    return cose;
  }
}
