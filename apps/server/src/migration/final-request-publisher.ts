import type { SQL } from "bun";
import type { DiscoveryFetch, NetworkTargetValidator } from "../discovery/verifier.js";
import type { HailDidResolver } from "../plc/resolver.js";
import { verifyHandshake, type SignedHandshake } from "./handshake.js";
import { PreparedMigrationTarget } from "./target-keys.js";
import { finalRequestWire, TRANSFER_MEDIA_TYPE, MAX_TRANSFER_WIRE_BYTES } from "./wire.js";

interface PreparedRow {
  did: string; transfer_id: string; request_bytes: Uint8Array; request_signature: Uint8Array;
  final_request_bytes: Uint8Array | null; final_request_signature: Uint8Array | null;
  destination_service_base: string; rotation_public_key: string; messaging_public_key: string;
}
interface ReservationRow {
  selection_bytes: Uint8Array; selection_signature: Uint8Array;
  receipt_bytes: Uint8Array; receipt_signature: Uint8Array; state: string;
}

export class TransferFinalRequestPublisher {
  constructor(private readonly sql: SQL, private readonly resolver: HailDidResolver,
    private readonly target: PreparedMigrationTarget, private readonly fetch: DiscoveryFetch,
    private readonly validateTarget: NetworkTargetValidator) {}

  async publish(transferId: string): Promise<void> {
    if (!/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/.test(transferId)) {
      throw new Error("Transfer ID is not canonical");
    }
    const records = await this.sql.begin(async (tx) => {
      const invites = await tx<PreparedRow[]>`
        SELECT i.did, i.transfer_id, i.request_bytes, i.request_signature,
          i.final_request_bytes, i.final_request_signature,
          k.destination_service_base, k.rotation_public_key, k.messaging_public_key
        FROM received_transfer_invitations i JOIN prepared_migration_target_keys k
          ON k.transfer_id = i.transfer_id
        WHERE i.transfer_id = ${transferId} FOR UPDATE OF i`;
      const invite = invites[0];
      if (!invite) throw new Error("No prepared transfer offer");
      const reservations = await tx<ReservationRow[]>`
        SELECT selection_bytes, selection_signature, receipt_bytes, receipt_signature, state
        FROM transfer_address_reservations WHERE transfer_id = ${transferId} FOR UPDATE`;
      const reserved = reservations[0];
      if (!reserved) throw new Error("No authenticated address reservation");
      const offer: SignedHandshake = { payloadBytes: invite.request_bytes, signature: invite.request_signature };
      const selection: SignedHandshake = { payloadBytes: reserved.selection_bytes,
        signature: reserved.selection_signature };
      const receipt: SignedHandshake = { payloadBytes: reserved.receipt_bytes,
        signature: reserved.receipt_signature };
      const state = await this.resolver.resolve(invite.did);
      const prepared = { did: invite.did, transferId, destinationServiceBase: invite.destination_service_base,
        rotationPublicKey: invite.rotation_public_key, messagingPublicKey: invite.messaging_public_key };
      let request: SignedHandshake;
      if (invite.final_request_bytes && invite.final_request_signature) {
        request = { payloadBytes: invite.final_request_bytes, signature: invite.final_request_signature };
      } else {
        request = await this.target.finalRequest(prepared, offer, selection, receipt, state.identityDidKey);
        await tx`UPDATE received_transfer_invitations SET final_request_bytes = ${request.payloadBytes},
          final_request_signature = ${request.signature}, final_submitted_at = clock_timestamp(),
          next_final_attempt_at = clock_timestamp() + interval '30 seconds'
          WHERE transfer_id = ${transferId} AND final_request_bytes IS NULL`;
      }
      await tx`UPDATE transfer_address_reservations SET state = 'submitted'
        WHERE transfer_id = ${transferId} AND state = 'selected'`;
      return { offer, selection, receipt, request, did: invite.did,
        serviceBase: state.serviceBase, messagingKey: invite.messaging_public_key };
    });
    const offer = await verifyHandshake(records.offer, "hail.transfer-offer", records.messagingKey);
    if (records.serviceBase !== offer.source_service_base || offer.did !== records.did) {
      throw new Error("Current PLC source no longer matches the offer");
    }
    const url = new URL(`${offer.source_service_base}/transfers/requests`);
    await this.validateTarget(url);
    const bytes = finalRequestWire(records.selection, records.receipt, records.request);
    if (bytes.length > MAX_TRANSFER_WIRE_BYTES) throw new Error("Final transfer request is too large");
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error("Final transfer request timed out")), 10_000);
    try {
      const response = await this.fetch(new Request(url, { method: "POST", body: Uint8Array.from(bytes),
        signal: controller.signal, headers: { "Content-Type": TRANSFER_MEDIA_TYPE,
          "Cache-Control": "no-store" } }));
      if (response.status !== 204 || response.body || response.headers.has("location") ||
        response.headers.has("content-encoding")) {
        await response.body?.cancel().catch(() => {});
        throw new Error("Old provider did not durably acknowledge the final transfer request");
      }
      await this.sql`UPDATE received_transfer_invitations
        SET final_acknowledged_at = COALESCE(final_acknowledged_at, clock_timestamp()),
          next_final_attempt_at = NULL
        WHERE transfer_id = ${transferId} AND final_request_bytes = ${records.request.payloadBytes}`;
    } finally { clearTimeout(timer); controller.abort(); }
  }
}
