import type { SQL } from "bun";
import type { HailDidResolver } from "../plc/resolver.js";
import type { SignedHandshake } from "./handshake.js";
import { handshakeDigest, sameDigest } from "./handshake.js";
import { decodeDeterministic } from "@hailproto/codec";
import { PreparedMigrationTarget } from "./target-keys.js";

interface ReceivedRow {
  grant_digest: Uint8Array;
  invitation_digest: Uint8Array;
  nonce: string;
  transfer_id: string;
  request_bytes: Uint8Array;
  request_signature: Uint8Array;
  expires_at: Date;
}

export class TransferInvitationReceiver {
  constructor(private readonly sql: SQL, private readonly resolver: HailDidResolver,
    private readonly target: PreparedMigrationTarget) {}

  async receive(grantSigned: SignedHandshake, invitationSigned: SignedHandshake): Promise<SignedHandshake> {
    const { grant } = await this.target.validateInvitation(
      (await this.extractDid(grantSigned)), grantSigned, invitationSigned, this.resolver);
    const grantHash = handshakeDigest(grantSigned.payloadBytes);
    const invitationHash = handshakeDigest(invitationSigned.payloadBytes);
    return this.sql.begin(async (tx) => {
      // Serialize retries, including first-time preparation, without ever activating the DID.
      await tx`SELECT pg_advisory_xact_lock(684245102, hashtext(${grant.did}))`;
      await this.target.recycleRetiredSlots(tx,grant.did);
      const cancelled = await tx`SELECT 1 FROM cancelled_transfer_sessions
        WHERE did = ${grant.did} AND nonce = ${grant.nonce}`;
      if (cancelled.length) throw new Error("This user transfer was cancelled by the source");
      const rows = await tx<ReceivedRow[]>`
        SELECT grant_digest, invitation_digest, nonce, transfer_id, request_bytes,
          request_signature, expires_at FROM received_transfer_invitations
        WHERE did = ${grant.did} FOR UPDATE`;
      const row = rows[0];
      if (row && (row.nonce !== grant.nonce || !sameDigest(row.grant_digest, grantHash) ||
        !sameDigest(row.invitation_digest, invitationHash))) {
        throw new Error("Another transfer invitation already occupies this DID");
      }
      if (row && row.expires_at.getTime() <= Date.now()) {
        throw new Error("Transfer invitation expired; cleanup requires a new authorization");
      }
      if (row) {
        const previous = { payloadBytes: new Uint8Array(row.request_bytes),
          signature: new Uint8Array(row.request_signature) };
        const decoded: unknown = decodeDeterministic(previous.payloadBytes);
        if (!decoded || typeof decoded !== "object" || !("expires_at" in decoded) ||
          typeof decoded.expires_at !== "number") throw new Error("Stored transfer request is invalid");
        if (decoded.expires_at > Math.floor(Date.now() / 1000) + 15) return previous;
        const keys = await tx<{ did: string; destination_service_base: string;
          rotation_public_key: string; messaging_public_key: string }[]>`
          SELECT did, destination_service_base, rotation_public_key, messaging_public_key
          FROM prepared_migration_target_keys WHERE transfer_id = ${row.transfer_id}`;
        const stored = keys[0];
        if (!stored || stored.did !== grant.did) throw new Error("Prepared destination key was lost");
        const refreshed = await this.target.createOffer({ transferId: row.transfer_id, did: grant.did,
          destinationServiceBase: stored.destination_service_base,
          rotationPublicKey: stored.rotation_public_key, messagingPublicKey: stored.messaging_public_key },
        grantSigned, invitationSigned, this.resolver);
        await tx`UPDATE received_transfer_invitations SET request_bytes = ${refreshed.payloadBytes},
          request_signature = ${refreshed.signature} WHERE did = ${grant.did}`;
        return refreshed;
      }
      const prepared = await this.target.prepare(grant.did);
      const signed = await this.target.createOffer(prepared, grantSigned, invitationSigned, this.resolver);
      await tx`INSERT INTO received_transfer_invitations
        (did, nonce, grant_digest, invitation_digest, transfer_id,
         request_bytes, request_signature, grant_bytes, grant_signature,
         invitation_bytes, invitation_signature, expires_at)
        VALUES (${grant.did}, ${grant.nonce}, ${grantHash}, ${invitationHash},
          ${prepared.transferId}, ${signed.payloadBytes}, ${signed.signature},
          ${grantSigned.payloadBytes}, ${grantSigned.signature},
          ${invitationSigned.payloadBytes}, ${invitationSigned.signature},
          ${new Date(grant.expires_at * 1000)})`;
      return signed;
    });
  }

  private async extractDid(signed: SignedHandshake): Promise<string> {
    if (signed.payloadBytes.length > 4096) throw new Error("Grant exceeds limit");
    const value: unknown = decodeDeterministic(signed.payloadBytes);
    if (!value || typeof value !== "object" || !("did" in value) ||
      typeof value.did !== "string" || !/^did:plc:[a-z2-7]{24}$/.test(value.did)) {
      throw new Error("Invitation grant has no canonical DID");
    }
    return value.did;
  }
}
