# Shared content storage and future attachments

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

## Current body expansion

Migration 98 expands body storage to 1 MiB without rewriting retained content.
Use matching codecs, provider, and web-client readers/writers for this alpha
change; older peers can reject larger bodies. The rollback script refuses while
any detached, shared received, publication, or connection-batch body exceeds
256 KiB, including unreferenced shared blobs. Never truncate content to roll back.
Existing 192 KiB header-image and pixel limits remain unchanged. The 2 MiB gzip
wire cap and local JSON API budgets are separate from stored body size. These
are body limits, not attachment support or an aggregate detached-resource budget.

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
