import type { SQL } from "bun";

/** Logical retained received content, including Trash; never depends on other tenants.
 * Counts each digest once per recipient, even across senders/profiles/messages.
 * Excludes outgoing bodies, metadata, migration archives, and database overhead.
 * This is measurement, not quota enforcement or upload capacity reservation.
 */
export async function receivedContentUsage(sql: SQL, recipientDid: string): Promise<{ bytes: number; blobs: number }> {
  const [row] = await sql<{ bytes: number; blobs: number }[]>`
    SELECT coalesce(sum(byte_size),0)::float8 AS bytes,count(*)::float8 AS blobs FROM (
      SELECT b.digest,b.byte_size FROM shared_content_blobs b
        JOIN (SELECT DISTINCT digest FROM verified_body_provenance WHERE recipient_did=${recipientDid}) p USING(digest)
      UNION
      SELECT b.digest,octet_length(b.bytes) AS byte_size FROM attachment_blobs b
        JOIN (SELECT DISTINCT digest FROM received_attachment_refs WHERE recipient_did=${recipientDid}) p USING(digest)
    ) content
  `;
  return row!;
}
