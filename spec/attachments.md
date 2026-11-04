# Message attachments

Status: Draft — current alpha format. Deploy matching codecs and providers together.

## Authenticated declaration

All three body profiles (`spt-1`, `spt-2`, `spt-3`) permit an optional
`attachments` array. Omit it when empty. Each of its 1–20 entries is a closed map:

```json
{"filename":"report.pdf","media_type":"application/pdf","size":12345,
 "digest":{"algorithm":"sha-256","value":"<32 bytes>"}}
```

The digest covers the exact detached file bytes. The authenticated envelope's
body digest binds the ordered list, filenames, sizes, media types, and file
digests. No file data or remote URL belongs in this list. Metadata counts toward
the existing 1 MiB encoded-body ceiling; detached file bytes do not.

The sum of declared sizes MUST be at most **26,214,400 bytes (25 MiB) per
message**, independent of recipient count. A single file may use the entire
budget. Each entry counts toward the sum, even when digests repeat. Files are
nonempty. Fan-out reuses the same body/list; it does not divide the budget by
recipients or permit each recipient to increase it.

Filenames are NFC UTF-8 text of at most 255 bytes, cannot start with `.`, cannot
contain `/`, `\`, U+0000–001F or U+007F, and must end in `.png`, `.jpg`, `.jpeg`, `.webp`, `.pdf`, `.txt`, or `.log`
(case insensitive). PDF uses `application/pdf` and begins with the ASCII bytes
`%PDF-`. TXT/LOG use `text/plain` and must decode as UTF-8 without NUL. These
checks classify bounded content; they do not certify that a PDF is harmless or
fully parseable. Providers MUST verify length, digest, and these content checks.
PNG uses `image/png`. Providers validate the signature, chunk bounds and CRCs,
IHDR profile, required image data and IEND, and valid dimensions (1–2,147,483,647
per axis), using the same non-animated structural checks as bundled PNG assets.
APNG is not supported. Files are not inflated or rendered by the provider; these
checks do not certify successful pixel decoding. PNG attachments use the 25 MiB
aggregate file budget, not the bundled header/avatar byte or pixel ceilings.
They are served as downloads, with the same safe headers as other attachments.
JPEG (`.jpg` and `.jpeg`) uses `image/jpeg`. The current subset is 8-bit baseline,
extended sequential, and progressive DCT (SOF0/1/2), with 1–4 components and
nonzero dimensions. Providers check SOI/EOI, bounded marker segments, frame and
scan headers, byte stuffing/restart markers, and the presence of scan data.
Truncated segments, unsupported coding modes, missing scans, and trailing bytes
after EOI are rejected. JFIF/Exif application metadata is retained unchanged.

WebP uses `image/webp`, with static lossy VP8 or lossless VP8L image data. Providers
check the RIFF/WEBP signature, exact declared container size, bounded chunks and
zero padding, and one image bitstream header with valid dimensions. Extended
VP8X canvases must match the image dimensions, with consistent metadata chunks
and flags. Transparency via ALPH/VP8L is supported; animation flags, ANIM and
ANMF chunks are rejected. Unknown bounded ancillary chunks are preserved.
The container format is described in [RFC 9649](https://www.rfc-editor.org/rfc/rfc9649.html).

JPEG and WebP checks, like PNG checks, are structural; providers do not decode
pixels, strip metadata, or recompress files. The full original bytes are hashed
and deduplicated. These formats use the same aggregate attachment budget and
forced-download behavior. Changing the extension or MIME type cannot bypass
content validation. Image headers and profile pictures remain PNG-only.
Archives, compression wrappers, inline execution, and arbitrary media types are
not supported. Existing bundled PNG header/avatar formats and limits are unchanged.

## Provider retrieval and delivery

After authenticating the body, the recipient provider retrieves each required
file using:

```
GET {current-sender-hail-service}/bodies/{body-digest}/attachments/{file-digest}
Authorization: Bearer {envelope-body-access-token}
Accept: application/octet-stream
Accept-Encoding: identity
```

Digests and tokens use canonical unpadded base64url. The body token authorizes
only files declared by that body's authenticated metadata. A digest alone is
not authority. Requests use the same active-token, expiry, migration-fence,
current PLC service resolution, and uniform unauthorized-404 behavior as body
retrieval. Query parameters are prohibited. The sender's body availability
commitment includes every declared file for the same period.

Successful responses use `application/octet-stream`, exact `Content-Length`,
`Content-Digest: sha-256=:<standard-base64>:`, and private/no-store caching.
Only identity encoding is supported for files; redirects are not followed.
Recipients bound each transfer by the declared size and verify exact bytes.
They MUST durably retain all required files with body provenance before committing
`delivered`. Retries restart files from byte zero; range/resume is not defined.
No partially retained file can count as delivery. No recipient user open or
subsequent download initiates a sender-provider request.

Existing body delivery reasons apply to the complete message: corrupt or
oversized files use `body-integrity-failed`; interrupted transfer uses
`body-transfer-interrupted`; 429 uses `sender-rate-limited`; authenticated
unavailability/503 uses `body-temporarily-unavailable`. Refresh sender discovery
after 404 as for bodies; unresolved authorization failure is terminal. Provider
resource failures remain retryable within the envelope delivery deadline.

## Retention, downloads, and portability

The reference provider stores immutable, digest-addressed bytes in PostgreSQL.
The live attachment blob table is shared across accounts, sent and received
messages, and filenames. SHA-256 identifies a candidate duplicate; an exact byte
comparison rejects inconsistent content on a digest conflict. Each owner retains
its own references and authority. This physical storage choice does not permit
skipping recipient-authorized retrieval because another account has the bytes.
Backups and retained migration snapshots have separate copy/retention lifecycles.
Outgoing bodies, received body provenance, and editable uploads retain explicit
references. References are transactional; one recipient's deletion cannot remove
another's retained file. Received files remain accessible in Trash for its normal
retention period. Permanent deletion removes that recipient's authority;
physical bytes are collected only after all owners release references. Existing
outgoing availability commitments and retained history may outlive mailbox
visibility. Database backups include file bytes; restore them with the database.

Authenticated account downloads require access to the containing message,
including normal sent/Trash visibility rules. Responses force attachment download,
encode filenames in `Content-Disposition: attachment; filename*=UTF-8''...`,
and send `nosniff`, a sandbox CSP, and private/no-store headers. Clients must not
embed PDFs or text as active application-origin content.

Migration/history exports include owned blobs and outgoing/received references.
Import validates owner scope, digest, declared size/type and complete body-to-file
coverage before activation. Shared blobs can already exist at the destination,
but global presence is never proof of the importing account's authority. Snapshot
size limits still apply; an oversized export fails rather than dropping files.

## Reference-provider and client policy

`POST /api/v1/account/attachments`, with `messages:write`, accepts closed JSON
`{"filename":"name.log","data":"<canonical-base64url>"}` and returns the body
metadata entry. The JSON request is capped at 35 MiB. A locked account transaction
limits outstanding editable upload references to 250 MiB. At most two uploads
are parsed/retained concurrently per provider process; excess requests receive
429 with Retry-After. Inbound upload reads have a 60-second deadline (408 on timeout). Uploads not retained
by drafts expire after 24 hours; durable outgoing body references survive.
Published messages cannot refer to another account's upload. Uploads are inert
and never publicly listed by digest.

`GET /api/v1/account/attachments/{sender}/{message-id}/{file-digest}` requires
`messages:read` and message visibility. Optional `?index=0` through `?index=19`
selects an exact declared entry (the digest must still match), preserving filenames
when multiple entries share bytes. Omission selects the first matching digest.
Reference-provider sent-list identities
may use `sent-category`, `sent-connections`, or `sent-message` in place of sender;
these are local API selectors, never protocol identities.

The web composer and reply forms accept multiple files. Drafts retain metadata;
forwarding re-authorizes and uploads files from the user's local received copy.
The CLI supports repeated `--attachment PATH` for `send`, `reply`, and
`connection send`; retries compare the attachment metadata with the original
saved request. Conversation CLI commands do not yet expose attachment flags.

This PostgreSQL implementation buffers bounded files during upload and transfer;
it is not a streaming/object-store implementation. Transfer timeouts are 60
seconds per file with a shared 120-second network deadline per retrieval attempt;
delivery leases are 180 seconds. General
malware scanning, resumable uploads, object storage, user storage quotas, and
larger formats require separate design and operational qualification.
