import { randomInt, randomUUID } from "node:crypto";
import type { SQL } from "bun";
import type { TransferInvitationDelivery } from "./invitation-delivery.js";
import type { TransferFinalRequestPublisher } from "./final-request-publisher.js";
import type { ManagedTransferDelivery } from "./managed-delivery.js";
import type { ManagedTransferFencePublisher } from "./managed-fence-publisher.js";

interface Claimed { token: string; attempts: number }
interface InvitationClaim extends Claimed { did: string }
interface FinalClaim extends Claimed { transfer_id: string }

function retrySeconds(attempts: number): number {
  return Math.min(300, 5 * 2 ** Math.min(attempts, 6)) + randomInt(0, 5);
}

export class TransferDeliveryWorker {
  constructor(private readonly sql: SQL,
    private readonly invitations: Pick<TransferInvitationDelivery, "deliver">,
    private readonly finalRequests: Pick<TransferFinalRequestPublisher, "publish">,
    private readonly managedInvitations?:Pick<ManagedTransferDelivery,"deliver">,
    private readonly managedFinalRequests?:Pick<ManagedTransferFencePublisher,"publish">) {}

  async runOnce(): Promise<"invitation" | "managed-invitation" | "final" | "managed-final" | "idle"> {
    const token = randomUUID();
    const invitations = await this.sql<InvitationClaim[]>`
      WITH due AS (
        SELECT did FROM provider_transfer_authorizations
        WHERE custody_profile = 'portable' AND origin_confirmed_at IS NULL AND consumed_transfer_id IS NULL AND cancelled_at IS NULL
          AND expires_at > clock_timestamp() AND next_invitation_attempt_at <= clock_timestamp()
          AND (invitation_lease_expires_at IS NULL OR invitation_lease_expires_at <= clock_timestamp())
        ORDER BY next_invitation_attempt_at FOR UPDATE SKIP LOCKED LIMIT 1
      )
      UPDATE provider_transfer_authorizations a
        SET invitation_lease_token = ${token},
          invitation_lease_expires_at = clock_timestamp() + interval '30 seconds',
          invitation_attempts = invitation_attempts + 1
      FROM due WHERE a.did = due.did RETURNING a.did, a.invitation_attempts AS attempts,
        a.invitation_lease_token AS token`;
    const invite = invitations[0];
    if (invite) {
      try {
        await this.invitations.deliver(invite.did);
        await this.sql`UPDATE provider_transfer_authorizations SET invitation_lease_token = NULL,
          invitation_lease_expires_at = NULL
          WHERE did = ${invite.did} AND invitation_lease_token = ${invite.token}`;
      } catch {
        const delay = retrySeconds(invite.attempts);
        await this.sql`UPDATE provider_transfer_authorizations SET invitation_lease_token = NULL,
          invitation_lease_expires_at = NULL,
          next_invitation_attempt_at = clock_timestamp() + ${delay} * interval '1 second'
          WHERE did = ${invite.did} AND invitation_lease_token = ${invite.token}`;
      }
      return "invitation";
    }

    if(this.managedInvitations) {
      const managedToken=randomUUID();
      const managed=await this.sql<InvitationClaim[]>`WITH due AS (
        SELECT did FROM provider_transfer_authorizations WHERE custody_profile='managed' AND origin_confirmed_at IS NULL
          AND consumed_transfer_id IS NULL AND cancelled_at IS NULL AND expires_at>clock_timestamp()
          AND next_invitation_attempt_at<=clock_timestamp()
          AND (invitation_lease_expires_at IS NULL OR invitation_lease_expires_at<=clock_timestamp())
        ORDER BY next_invitation_attempt_at FOR UPDATE SKIP LOCKED LIMIT 1)
        UPDATE provider_transfer_authorizations a SET invitation_lease_token=${managedToken},
          invitation_lease_expires_at=clock_timestamp()+interval '30 seconds',invitation_attempts=invitation_attempts+1
        FROM due WHERE a.did=due.did RETURNING a.did,
          a.invitation_attempts AS attempts,a.invitation_lease_token AS token`;
      const claim=managed[0];
      if(claim){
        try {
          await this.managedInvitations.deliver(claim.did);
          await this.sql`UPDATE provider_transfer_authorizations SET invitation_lease_token=NULL,
            invitation_lease_expires_at=NULL WHERE did=${claim.did} AND invitation_lease_token=${claim.token}`;
        } catch {
          const delay=retrySeconds(claim.attempts);
          await this.sql`UPDATE provider_transfer_authorizations SET invitation_lease_token=NULL,
            invitation_lease_expires_at=NULL,next_invitation_attempt_at=clock_timestamp()+${delay}*interval '1 second'
            WHERE did=${claim.did} AND invitation_lease_token=${claim.token}`;
        }
        return "managed-invitation";
      }
    }

    const finalToken = randomUUID();
    const finals = await this.sql<FinalClaim[]>`
      WITH due AS (
        SELECT i.transfer_id FROM received_transfer_invitations i
        JOIN transfer_address_reservations r ON r.transfer_id = i.transfer_id
        JOIN prepared_migration_target_keys prepared ON prepared.transfer_id=i.transfer_id
        WHERE i.final_request_bytes IS NOT NULL AND i.final_acknowledged_at IS NULL
          AND i.next_final_attempt_at <= clock_timestamp() AND r.state = 'submitted'
          AND prepared.custody_profile='portable'
          AND (i.final_lease_expires_at IS NULL OR i.final_lease_expires_at <= clock_timestamp())
        ORDER BY i.next_final_attempt_at FOR UPDATE OF i SKIP LOCKED LIMIT 1
      )
      UPDATE received_transfer_invitations i SET final_lease_token = ${finalToken},
        final_lease_expires_at = clock_timestamp() + interval '30 seconds',
        final_attempts = final_attempts + 1
      FROM due WHERE i.transfer_id = due.transfer_id
      RETURNING i.transfer_id, i.final_attempts AS attempts, i.final_lease_token AS token`;
    const final = finals[0];
    if (!final&&this.managedFinalRequests) {
      const managedFinalToken=randomUUID();
      const managedFinals=await this.sql<FinalClaim[]>`WITH due AS (
        SELECT i.transfer_id FROM received_transfer_invitations i
        JOIN transfer_address_reservations reservation ON reservation.transfer_id=i.transfer_id
        JOIN prepared_migration_target_keys prepared ON prepared.transfer_id=i.transfer_id
        WHERE i.final_request_bytes IS NOT NULL AND i.final_acknowledged_at IS NULL
          AND i.next_final_attempt_at<=clock_timestamp() AND reservation.state='submitted'
          AND prepared.custody_profile='managed'
          AND (i.final_lease_expires_at IS NULL OR i.final_lease_expires_at<=clock_timestamp())
        ORDER BY i.next_final_attempt_at FOR UPDATE OF i SKIP LOCKED LIMIT 1)
        UPDATE received_transfer_invitations i SET final_lease_token=${managedFinalToken},
          final_lease_expires_at=clock_timestamp()+interval '30 seconds',final_attempts=final_attempts+1
        FROM due WHERE i.transfer_id=due.transfer_id
        RETURNING i.transfer_id,i.final_attempts AS attempts,i.final_lease_token AS token`;
      const managedFinal=managedFinals[0];
      if(managedFinal){
        try {
          await this.managedFinalRequests.publish(managedFinal.transfer_id);
          await this.sql`UPDATE received_transfer_invitations SET final_lease_token=NULL,final_lease_expires_at=NULL
            WHERE transfer_id=${managedFinal.transfer_id} AND final_lease_token=${managedFinal.token}`;
        } catch {
          const delay=retrySeconds(managedFinal.attempts);
          await this.sql`UPDATE received_transfer_invitations SET final_lease_token=NULL,final_lease_expires_at=NULL,
            next_final_attempt_at=clock_timestamp()+${delay}*interval '1 second'
            WHERE transfer_id=${managedFinal.transfer_id} AND final_lease_token=${managedFinal.token}`;
        }
        return "managed-final";
      }
    }
    if (!final) return "idle";
    try {
      await this.finalRequests.publish(final.transfer_id);
      await this.sql`UPDATE received_transfer_invitations SET final_lease_token = NULL,
        final_lease_expires_at = NULL WHERE transfer_id = ${final.transfer_id}
        AND final_lease_token = ${final.token}`;
    } catch {
      const delay = retrySeconds(final.attempts);
      await this.sql`UPDATE received_transfer_invitations SET final_lease_token = NULL,
        final_lease_expires_at = NULL,
        next_final_attempt_at = clock_timestamp() + ${delay} * interval '1 second'
        WHERE transfer_id = ${final.transfer_id} AND final_lease_token = ${final.token}`;
    }
    return "final";
  }
}
