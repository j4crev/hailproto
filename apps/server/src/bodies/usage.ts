import type { SQL } from "bun";

/** Logical retained received content, including Trash; never depends on other tenants.
 * Counts each digest once per recipient, even across senders/profiles/messages.
 * Excludes outgoing bodies, metadata, migration archives, and database overhead.
 * This is measurement, not quota enforcement or upload capacity reservation.
 */
export async function receivedContentUsage(sql: SQL, recipientDid: string): Promise<{ bytes: number; blobs: number }> {
  const [row] = await sql<{ bytes: number; blobs: number }[]>`
    SELECT coalesce(sum(b.byte_size), 0)::float8 AS bytes, count(*)::float8 AS blobs
    FROM shared_content_blobs b
    JOIN (SELECT DISTINCT digest FROM verified_body_provenance WHERE recipient_did = ${recipientDid}) p USING (digest)
  `;
  return row!;
}
