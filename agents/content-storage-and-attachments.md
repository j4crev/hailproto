# Shared content storage and attachments

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

## Implemented attachment lifecycle

See [the attachment specification](../spec/attachments.md). Migration 102 stores
file bytes separately in `attachment_blobs`, with `attachment_uploads`,
`body_attachment_refs`, and `received_attachment_refs` as authoritative owners.
Uploads are account-scoped; outgoing refs follow detached bodies; received refs
cascade with received provenance. Drafts protect uploaded files from the 24-hour
editable-upload cleanup. Trash uses normal message provenance retention. The
periodic cleanup collects only blobs without any remaining owners under row
locks; restrictive foreign keys prevent deletion while another owner retains bytes.

Received usage includes file bytes once per digest per recipient; physical
operator accounting includes the attachment tables. Migration exports include
owned file bytes and references, validate completeness and integrity, and import
shared bytes before owner references. Database backups retain both metadata and
files. Matching current-alpha software is required; older exports must be
regenerated. Rollback refuses while message references remain.

The first implementation uses bounded in-memory buffers and PostgreSQL bytea,
not an external streaming store. The 35 MiB upload JSON cap includes base64
expansion; file payloads still total at most 25 MiB per message, regardless of
recipient count. Editable uploads have a 250 MiB per-account allowance protected
by the account lock. This is not a retained-user-storage quota. Capacity/load
testing, malware scanning, external object storage, chunk/resume, and additional
file formats remain separate operational/design work.

## Deduplication audit (2026-11-03)

The live attachment byte store is provider-wide: `attachment_blobs.digest` is the
primary key, and PostgreSQL checks SHA-256 against `bytes`. `storeAttachment`
compares the complete existing bytes on a digest conflict and rejects a mismatch.
Concurrent uploads, different filenames, different senders, outgoing bodies,
and received messages all reuse this table. Names and media types belong to the
authenticated body entries; account and body references carry ownership. Deleting
one owner's references leaves other owners intact. Global existence does not
bypass independent upload/retrieval verification or message authorization.

The regression in `apps/server/test/attachments.integration.test.ts` exercises
concurrent cross-account uploads with different filenames, separate bodies,
one live file row, loss of one owner's access, and collection after the last
owner releases the bytes. The maximum-size case also covers shared outgoing and
received references and migration import of already-present bytes.

Current image storage has different sharing boundaries:

| Content | Current sharing | Remaining duplicate bytes |
| --- | --- | --- |
| Received message bodies | `shared_content_blobs` stores one complete body per digest across recipients and senders. | Different bodies remain distinct. |
| Outgoing bodies | `detached_bodies` deduplicates a complete body within a sender account. | Other senders, publication/batch records, received storage, and retained history can hold copies. |
| Header images | Bundled inside SPT-3; identical complete received bodies share their embedded image. | Reusing a PNG in a different message or alongside different attachment metadata repeats its bytes. No independent PNG store exists. |
| Profile pictures | Bundled inside signed Sender Profile representations; revision/representation constraints prevent duplicate profile records within their existing scope. | The image repeats across changed revisions and accounts, and also appears in the diagnostic `profile_payload` JSON cache alongside the retained COSE representation. Local and verified-remote profile tables are separate. |

Sources: migrations 6, 8, 79 and 102; `src/onboarding/repository.ts` profile
writes; `src/bodies/attachments.ts` immutable upserts. Whole-object deduplication
is not image-level deduplication. A digest stored on an image is an integrity
binding and does not itself imply physical sharing.

Storage optimization need not change the wire format. A useful first candidate
is deriving profile JSON from the retained signed representation instead of
persisting the bundled image in both. Independent header/avatar sharing requires
a lossless internal representation that reconstructs the exact authenticated body
or signed profile, including representation-digest checks, retained history,
migration, and owner references. Merely adding an image cache would keep the
existing bundled copies and add storage. Such a representation migration merits
its own change and round-trip proof; it is not part of attachment delivery.

“One live attachment blob” does not mean one copy across database backups,
retained migration snapshot manifests, WAL, or temporary PostgreSQL MVCC versions.
Those have separate durability/retention lifecycles. Logical recipient usage also
counts independently of whether another account shares the physical blob.

## Core Internet-Draft audit (2026-11-03)

Attachment work did not change the core body/envelope representation ceilings,
COSE/signature domains, PNG limits, bearer authorization, core delivery states,
or recipient-scoped provenance rules described by
`drafts/draft-creviston-racr-00.xml`. All 13 definitions in its body/asset CDDL
excerpt match the current specification after removing the attachment extension's
optional body members. The XML remains the pinned core draft; its historical
feature inventory describes that pinned snapshot. Attachment declarations,
retrieval, and the expanded migration record collections belong to companion
extensions, so this audit does not add them to the core draft or repin its source.
