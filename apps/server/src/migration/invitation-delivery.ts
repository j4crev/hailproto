import type { SQL } from "bun";
import type { DiscoveryFetch, NetworkTargetValidator } from "../discovery/verifier.js";
import type { HailDidResolver } from "../plc/resolver.js";
import { handshakeDigest, sameDigest, verifyHandshake, type SignedHandshake } from "./handshake.js";
import { boundedTransferBody, invitationWire, parseRequestWire,
  TRANSFER_MEDIA_TYPE, MAX_TRANSFER_WIRE_BYTES } from "./wire.js";
import { decodeDeterministic } from "@hailproto/codec";

interface SourceRow {
  destination_service_base: string;
  expires_at: Date;
  grant_bytes: Uint8Array;
  grant_signature: Uint8Array;
  invitation_bytes: Uint8Array;
  invitation_signature: Uint8Array;
  consumed_transfer_id: string | null;
  origin_request_bytes: Uint8Array | null;
  origin_request_signature: Uint8Array | null;
  cancelled_at: Date | null;
}

export class TransferInvitationDelivery {
  constructor(private readonly sql: SQL, private readonly resolver: HailDidResolver,
    private readonly sourceBase: string, private readonly fetch: DiscoveryFetch,
    private readonly validateTarget: NetworkTargetValidator) {}

  async deliver(did: string): Promise<SignedHandshake> {
    if (!/^did:plc:[a-z2-7]{24}$/.test(did)) throw new Error("Invalid transfer DID");
    const state = await this.resolver.resolve(did);
    if (state.did !== did || state.serviceBase !== this.sourceBase) {
      throw new Error("Source service is no longer current");
    }
    const rows = await this.sql<SourceRow[]>`
      SELECT destination_service_base, expires_at, grant_bytes, grant_signature,
        invitation_bytes, invitation_signature, consumed_transfer_id,
        origin_request_bytes, origin_request_signature, cancelled_at
      FROM provider_transfer_authorizations WHERE did = ${did}`;
    const row = rows[0];
    if (!row || row.cancelled_at || row.expires_at.getTime() <= Date.now()) {
      throw new Error("Transfer grant expired, cancelled or absent");
    }
    const grantSigned = { payloadBytes: row.grant_bytes, signature: row.grant_signature };
    const invitationSigned = { payloadBytes: row.invitation_bytes, signature: row.invitation_signature };
    const grant = await verifyHandshake(grantSigned, "hail.transfer-grant", state.identityDidKey);
    const invitation = await verifyHandshake(invitationSigned, "hail.transfer-invitation", state.messagingDidKey);
    if (grant.did !== did || grant.source_service_base !== this.sourceBase ||
      grant.destination_service_base !== row.destination_service_base ||
      grant.expires_at !== Math.floor(row.expires_at.getTime() / 1000) ||
      invitation.did !== did || invitation.nonce !== grant.nonce ||
      invitation.source_service_base !== this.sourceBase ||
      invitation.destination_service_base !== grant.destination_service_base ||
      invitation.expires_at !== grant.expires_at ||
      !sameDigest(invitation.grant_digest, handshakeDigest(grantSigned.payloadBytes))) {
      throw new Error("Stored invitation does not match the current user grant");
    }
    if (row.origin_request_bytes && row.origin_request_signature) {
      const previous = { payloadBytes: new Uint8Array(row.origin_request_bytes),
        signature: new Uint8Array(row.origin_request_signature) };
      const decoded: unknown = decodeDeterministic(previous.payloadBytes);
      if (!decoded || typeof decoded !== "object" || !("expires_at" in decoded) ||
        typeof decoded.expires_at !== "number") throw new Error("Stored origin response is invalid");
      if (decoded.expires_at > Math.floor(Date.now() / 1000) + 15) {
        await this.verifyResponse(previous, grantSigned, invitationSigned, invitation.challenge,
          grant.destination_service_base, state.messagingDidKey, did);
        return previous;
      }
    }
    if (row.consumed_transfer_id) throw new Error("Transfer authorization was already consumed");

    // The destination is *only* derived from the user-signed, source-verified
    // service base. The safe transport pins public DNS addresses while TLS
    // verifies that exact hostname; redirects are never followed.
    const url = new URL(`https://${grant.destination_domain}/.well-known/hail/transfers/invitations`);
    await this.validateTarget(url);
    const body = invitationWire(grantSigned, invitationSigned);
    if (body.length > MAX_TRANSFER_WIRE_BYTES) throw new Error("Invitation wire body exceeds limit");
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error("Transfer invitation timed out")), 10_000);
    let response: Response;
    try {
      response = await this.fetch(new Request(url, { method: "POST", body: Uint8Array.from(body),
        signal: controller.signal, headers: { "Content-Type": TRANSFER_MEDIA_TYPE,
          "Cache-Control": "no-store" } }));
      if (response.status !== 200 || response.headers.get("content-type") !== TRANSFER_MEDIA_TYPE ||
        response.headers.has("content-encoding") || response.headers.has("location")) {
        await response.body?.cancel().catch(() => {});
        throw new Error("Target HTTPS origin did not acknowledge the invitation");
      }
      const signed = parseRequestWire(await boundedTransferBody(response.body,
        response.headers.get("content-length")));
      const request = await this.verifyResponse(signed, grantSigned, invitationSigned,
        invitation.challenge, grant.destination_service_base, state.messagingDidKey, did);
      await this.sql.begin(async (tx) => {
        const current = await tx<SourceRow[]>`
          SELECT destination_service_base, expires_at, grant_bytes, grant_signature,
            invitation_bytes, invitation_signature, consumed_transfer_id,
            origin_request_bytes, origin_request_signature, cancelled_at
          FROM provider_transfer_authorizations WHERE did = ${did} FOR UPDATE`;
        const stored = current[0];
        if (!stored || stored.cancelled_at || stored.expires_at.getTime() <= Date.now() ||
          stored.destination_service_base !== grant.destination_service_base ||
          !sameDigest(stored.grant_bytes, grantSigned.payloadBytes) ||
          !sameDigest(stored.grant_signature, grantSigned.signature) ||
          !sameDigest(stored.invitation_bytes, invitationSigned.payloadBytes) ||
          !sameDigest(stored.invitation_signature, invitationSigned.signature) ||
          stored.consumed_transfer_id && stored.consumed_transfer_id !== request.transfer_id) {
          throw new Error("Source invitation changed during HTTPS delivery");
        }
        if (stored.origin_request_bytes || stored.origin_request_signature) {
          if (!stored.origin_request_bytes || !stored.origin_request_signature) {
            throw new Error("Incomplete origin response state");
          }
          if (!sameDigest(stored.origin_request_bytes, signed.payloadBytes) ||
            !sameDigest(stored.origin_request_signature, signed.signature)) {
            const prior: unknown = decodeDeterministic(stored.origin_request_bytes);
            if (!prior || typeof prior !== "object" || !("expires_at" in prior) ||
              typeof prior.expires_at !== "number" ||
              prior.expires_at > Math.floor(Date.now() / 1000) + 15 || stored.consumed_transfer_id) {
              throw new Error("Conflicting destination responses for one invitation");
            }
          } else return;
        }
        await tx`UPDATE provider_transfer_authorizations
          SET origin_request_bytes = ${signed.payloadBytes},
            origin_request_signature = ${signed.signature}, origin_confirmed_at = clock_timestamp()
          WHERE did = ${did}`;
      });
      return signed;
    } finally { clearTimeout(timer); controller.abort(); }
  }

  private async verifyResponse(signed: SignedHandshake, grantSigned: SignedHandshake,
    invitationSigned: SignedHandshake, challenge: Uint8Array, destination: string,
    sourceMessagingKey: string, did: string) {
    // The key alone is self-asserted; it gains destination-origin provenance
    // only by arriving as the response from the pinned HTTPS destination.
    const raw: unknown = decodeDeterministic(signed.payloadBytes);
    if (!raw || typeof raw !== "object" || !("destination_messaging_key" in raw) ||
      typeof raw.destination_messaging_key !== "string") throw new Error("Invalid destination key claim");
    const request = await verifyHandshake(signed, "hail.transfer-offer", raw.destination_messaging_key);
    const { grant } = await this.readInvitation(grantSigned, invitationSigned, sourceMessagingKey, did);
    if (request.did !== did || request.nonce !== grant.nonce ||
      request.source_service_base !== this.sourceBase ||
      request.destination_service_base !== destination ||
      !sameDigest(request.grant_digest, handshakeDigest(grantSigned.payloadBytes)) ||
      !sameDigest(request.invitation_digest, handshakeDigest(invitationSigned.payloadBytes)) ||
      !sameDigest(request.invitation_challenge, challenge) ||
      request.issued_at > Math.floor(Date.now() / 1000) + 300 ||
      request.expires_at <= Math.floor(Date.now() / 1000) ||
      request.expires_at > grant.expires_at) {
      throw new Error("Target response did not bind the user grant and invitation challenge");
    }
    return request;
  }

  private async readInvitation(grantSigned: SignedHandshake, invitationSigned: SignedHandshake,
    sourceMessagingKey: string, did: string) {
    const state = await this.resolver.resolve(did);
    const grant = await verifyHandshake(grantSigned, "hail.transfer-grant", state.identityDidKey);
    const invitation = await verifyHandshake(invitationSigned, "hail.transfer-invitation", sourceMessagingKey);
    return { grant, invitation };
  }
}
