# Shared content storage and future attachments

## Implemented: received message bodies

Migration 79 stores received body bytes once per SHA-256 digest in
`shared_content_blobs`. `verified_body_provenance` retains the independent
recipient DID, sender DID, digest, media type, profile, and verification time.
`delivered_messages` still records each recipient's message and delivery result.
Sharing does not grant access or establish another recipient's provenance.

The provenance table's `body_bytes` column is a write/import interface, not a
second stored copy. Its trigger checks the body size and SHA-256 digest, inserts
or verifies the shared bytes, and clears the column before storage. Inserts
must supply independently verified bytes even if a matching blob exists. The
application remains responsible for validating the body profile and envelope.
The `verified_body_contents` view reconstructs the previous complete row shape
for authenticated message reads and portable exports. Do not read the ingress
column for message content or change the trigger to accept digest-only inserts.

The delivery worker still retrieves and verifies each recipient's body. No
cross-recipient cache reuse, token redemption shortcut, or public digest-based
download endpoint is introduced. Shared bytes carry no sender, recipient,
filename, body profile, or authorization semantics of their own.

Sender-side `detached_bodies`, publication drafts, connection batches, and
historical migration snapshots retain their existing storage. This change
shares received content; it does not promise one physical copy across every
server subsystem. PostgreSQL backups and replicas also retain physical copies.

## Ownership, accounting, and collection

`receivedContentUsage` measures retained received bytes once per distinct digest
per recipient, independent of sender and profile. References held by Trash count
until purged. Two recipients each count the full logical size; several messages
referencing the same bytes within one recipient count it once. The measurement
excludes sent content, metadata, history, and PostgreSQL overhead. It is an
internal accounting primitive, not a quota API or quota enforcement mechanism.

The operator storage breakdown includes the shared blob table as message
content. Physical PostgreSQL allocation and logical user usage are different
metrics; deleting records does not immediately shrink database files.

Existing message deletion removes provenance only after the recipient's last
message reference disappears. The periodic Trash cleanup also collects up to
500 shared blobs with no remaining provenance references. Import rollback and
account migration can release references too; collection is independent of
which operation removed them. Shared-blob upserts hold row locks through the
reference transaction. Collection skips locked blobs and rechecks references;
a restrictive foreign key prevents deletion of referenced bytes. A failed
transaction cannot leave a partially committed body/reference pair.

Keep blobs immutable. Future owners of shared blobs must add explicit retained
references and participate in collection before using this store. Do not point
attachments or outgoing availability commitments at it without extending that
ownership model. Reference counts alone are insufficient unless updates are
transactional and reconcilable against authoritative references.

## Upgrade, rollback, and portable migration

This is a coordinated application/schema upgrade, not a rolling mixed-version
upgrade. Old application readers access the ingress column directly and are
incompatible after migration 79. Stop all API processes, workers, and migration
jobs; back up the database; apply migrations with the new release; start only
new application processes. The migration runs transactionally under the normal
migration lock. Allow space for the backfill and PostgreSQL WAL/old row versions.
Normal vacuum can reclaim obsolete row space for reuse after commit; no online
file-shrinking operation is part of this change.

Backfill verifies SHA-256 and preserves exact bytes, all provenance keys, and
verification timestamps, including accounts already fenced for migration.
Duplicate digest/byte inconsistencies fail the transaction rather than silently
choosing a copy. The migration temporarily disables only the provenance fence
trigger for its representation update and restores it within the transaction.

Portable and managed exports use `verified_body_contents` to include complete
body bytes in each existing portable provenance row. No blob IDs or local
storage paths escape into portable manifests. Existing manifest validators,
signatures, import formats, and account-level fences remain authoritative.
Imports write the old row format; the database normalizes it into shared bytes
and a recipient reference. Retained snapshots may still contain duplicate bytes.

To roll back, stop all application processes and run
`apps/server/migrations/rollback/0079_shared_received_bodies.sql`, then restore
the previous application version. The transaction materializes body bytes back
into every provenance row before removing shared storage. Ensure capacity for
those copies. Restart the new release only after reapplying migration 79.

## Attachment design direction (not implemented)

Attachments are deferred. The existing body/asset profiles and their limits
remain unchanged. The following decisions should guide the future protocol and
implementation work; they are not new wire requirements today.

- Represent each attachment as a declared resource whose digest, byte length,
  and media type are bound by the authenticated message body. Keep filenames,
  roles, and display metadata on message-to-attachment references, so different
  filenames do not force duplicate file bytes. Do not use arbitrary external
  URLs as attachment authority.
- Store attachment bytes separately from the deterministic message body. Reuse
  content addressing and explicit ownership, with recipient/sender retrieval
  provenance appropriate to the attachment profile. Body storage and attachment
  storage can share a blob mechanism without sharing authorization semantics.
- Put storage behind a small byte-store interface when adding a second backend.
  PostgreSQL is the current backend; filesystem or object storage is a future
  choice, not a protocol requirement. Persist opaque storage keys, not public
  paths. Preserve integrity verification regardless of backend.
- Specify authorized attachment retrieval, expiry and sender availability,
  retry/resume behavior, and whether all required attachment bytes must be
  durably retained before a message becomes `delivered`. An optional download
  after delivery needs explicitly different retention and failure semantics.
  Retrieval must not become sender-visible evidence of a user opening a message.
- Define per-file and per-message limits, bounded streaming, timeouts, and
  decompression policy. Avoid loading whole attachments into memory. Reserve
  logical quota and physical capacity for concurrent transfers; release failed
  reservations. Keep user quotas independent of other users' deduplication.
- Maintain separate owner references for received messages, drafts, outgoing
  availability commitments, Trash, and any migration pins. One user's permanent
  deletion releases that user's access; shared bytes remain while another owner
  retains them. Define backup and historical-snapshot retention separately.
- For an external byte store, publish verified durable bytes before committing
  a visible message/reference. Handle crashes between blob publication and
  database commit with staging and orphan collection. Never mark delivery
  complete when a required blob is only temporary. Coordinate database/blob
  backups, restore verification, corruption detection, and migration exports.
- Serve downloads through account/message authorization. A digest is not a
  capability. Use safe download headers and filenames; never render arbitrary
  uploaded HTML or other active content in the trusted application origin.
  Specify content-policy/quarantine behavior before enabling general uploads.
- Revisit deduplication scope if adding end-to-end encryption or per-account
  encryption keys. Different ciphertext generally cannot share bytes. Do not
  introduce convergent encryption merely to preserve storage savings.

Before attachment launch, verify shared-file deletion across users, quota
reservation races, interrupted upload/retrieval, missing or corrupt blobs,
backup restore, account migration, and authorization isolation. Storage
optimization must not decide any of these protocol questions implicitly.
