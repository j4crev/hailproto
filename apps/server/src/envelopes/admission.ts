import type { SQL } from 'bun';
import type { EnvelopeDecision } from './repository.js';

/** Reference-provider policy, not wire-format limits. Shared by all server processes. */
export const ENVELOPE_ADMISSION = {
  pendingSender: 16, pendingRecipient: 64, pendingProvider: 256,
  rejectedSender: 64, rejectedProvider: 4096,
  rejectedSenderBytes: 1_048_576, rejectedProviderBytes: 67_108_864,
};
export type EnvelopeAdmissionLimits = typeof ENVELOPE_ADMISSION;
export class EnvelopeCapacityError extends Error {}

export async function admitEnvelope(tx: SQL, input: EnvelopeDecision, accepted: boolean, limits: EnvelopeAdmissionLimits = ENVELOPE_ADMISSION): Promise<void> {
  // All admission decisions use the same lock; counts and insertion share a transaction.
  await tx`SELECT pg_advisory_xact_lock(684245104)`;
  const p = input.payload;
  // A concurrent identical submission may have committed while we waited.
  if ((await tx`SELECT 1 FROM received_envelopes WHERE sender_did=${p.from} AND message_id=${p.message_id}`).length) return;
  if (accepted) {
    const [usage] = await tx<{ total: number; sender: number; recipient: number }[]>`
      SELECT count(*)::int AS total,
        count(*) FILTER (WHERE work.sender_did=${p.from})::int AS sender,
        count(*) FILTER (WHERE received.recipient_did=${p.to})::int AS recipient
      FROM delivery_work work JOIN received_envelopes received USING(sender_did,message_id)
      WHERE work.state IN ('accepted','on-hold')`;
    if (!usage || usage.total >= limits.pendingProvider ||
      usage.sender >= limits.pendingSender || usage.recipient >= limits.pendingRecipient)
      throw new EnvelopeCapacityError('Outstanding delivery budget exhausted');
  } else {
    // Preserve existing replay/export representations, but bound both record count and
    // uncompressed evidence bytes. A long PLC history cannot bypass the byte budget.
    const [estimate] = await tx<{bytes:number}[]>`SELECT (${input.representation.length}
      + octet_length(${JSON.stringify(input.evidence.document)}::jsonb::text)
      + octet_length(${JSON.stringify(input.evidence.data)}::jsonb::text)
      + octet_length(${JSON.stringify(input.evidence.log)}::jsonb::text))::int AS bytes`;
    const bytes = estimate!.bytes;
    const [usage] = await tx<{ total: number; sender: number; bytes: string; sender_bytes: string }[]>`
      SELECT count(*)::int AS total,
        count(*) FILTER (WHERE sender_did=${p.from})::int AS sender,
        COALESCE(sum(admission_bytes),0)::text AS bytes,
        COALESCE(sum(admission_bytes) FILTER (WHERE sender_did=${p.from}),0)::text AS sender_bytes
      FROM received_envelopes WHERE outcome <> 'accepted'`;
    if (!usage || usage.total >= limits.rejectedProvider ||
      usage.sender >= limits.rejectedSender ||
      Number(usage.bytes) + bytes > limits.rejectedProviderBytes ||
      Number(usage.sender_bytes) + bytes > limits.rejectedSenderBytes)
      throw new EnvelopeCapacityError('Rejected replay budget exhausted');
  }
}
