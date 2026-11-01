# Logical account history: portable v7 and managed v8

Status: Current alpha record schema, derived from the implemented collectors and
validated against synthetic exports. It specifies the existing manifest, not a
new transfer version. [Transfer formats](transfer-formats.md) defines its carrier,
signatures and ceremony; this document defines the history inside it.

## Storage independence

The normative machine-readable shape is
[account-history-v7-v8.json](schemas/account-history-v7-v8.json), JSON Schema draft 7.
It defines both manifests, both checkpoint domains, every exported record field,
field presence, scalar/array/object types and nullability. The schema is self-contained;
no database, ORM, TypeScript module or external schema fetch is required to use it.

`tables` is the historical wire name for a map of **logical record collections**.
An implementation MAY store them in documents, objects, a key-value store or SQL.
It MUST preserve the field names and semantics on this wire profile. Account/row
UUIDs are source-assigned correlation identifiers, not instructions to allocate
physical tables or reuse a source database primary key. An importer may map them
to internal keys if it preserves all original references and signed evidence.
The schema's `x-reference-storage` and `x-record-key` annotations explain the
reference mapping; they do not require that storage layout.

Do not translate signed protocol objects into reconstructed payloads. Preserve
original COSE, PLC operation and retained evidence bytes. Storage independence
changes storage representation, not historical identity, authority or signatures.

## Value and size rules

- Every manifest, collection map and record has a closed set of required fields.
  Nullable fields are present with JSON null; absent and null are distinct.
- Numbers are safe integers. Reference exports use JSON numbers for SQL integers,
  including bigint; a numeric string is not the current export representation.
- UUIDs are lowercase hyphenated text; DIDs, service bases, addresses and key
  identifiers follow their own protocol syntax and authority rules.
- Database-origin binary fields use the wire text `\x` followed by lowercase hex
  pairs. This spelling is retained for byte compatibility, not a SQL requirement.
  Never infer binary content from arbitrary strings. The schema identifies the
  binary fields; embedded CBOR signed objects still use native byte strings.
- Record timestamps are RFC 3339 strings, including fractional seconds and numeric
  offsets. Retain their text when hashing a checkpoint. Do not silently normalize
  `+00:00` to `Z`, round microseconds or convert timestamps into integers.
- Nested JSON evidence is a retained JSON value, not an extensibility slot for the
  containing record. Its authority is checked under the named PLC/consent profile.
  JSON Schema shape validation alone never proves a signature or current authority.
- The complete decoded manifest is 1–67108864 bytes. Checkpoint CBOR hashing permits
  at most 67108864 bytes, depth 32, 2000000 items, 100000 array elements,
  256 map entries, 16777216 text bytes and 1048576 native byte-string bytes.
  The outer completion request limit is 100000000 bytes. Fail closed when history
  exceeds a limit; there is no truncation, pagination or lossy fallback profile.

The manifest signature covers its exact saved JSON bytes. Checkpoint hashes cover
deterministic CBOR of the complete logical checkpoint object. Hex byte strings in
records remain **text** in that CBOR input. Do not decode them before hashing.
Array order is part of the digest. A peer need not reproduce the source's SQL
query order to verify a received snapshot: it preserves the received order.
Object key order matters for exact manifest JSON bytes but not for deterministic
CBOR checkpoint encoding.

## Record selection and scope

Both custody profiles include all common collections below. Portable adds
`portable_custody_evidence`; managed adds `managed_custody_evidence`. The enclosing
schema enumerates the complete table domain; missing empty collections are invalid.

| Collections | Logical meaning and selection |
| --- | --- |
| `provider_accounts` | Exactly one active account matching manifest account ID/DID; no closed/released address markers |
| `account_keys` | Source public role metadata only: portable rotation/messaging; managed rotation/identity/messaging; never encrypted private keys, nonces or KEK identifiers |
| `portable_custody_evidence`, `managed_custody_evidence` | Exact corresponding owner/recovery, custody and assurance evidence for that account |
| `plc_operation_evidence` | The account's retained signed PLC operations, lifecycle states and evidence |
| `address_bindings`, `sender_profiles` | The account's original signed identity/profile publication history |
| `grant_lineages`, `grant_revisions`, `grant_consent_evidence` | Owned and received Grant lineages, revisions and consent evidence; include co-located received Grants as local role `grantee` |
| `grant_publications` | Publication obligations for owned revisions; preserve acknowledgements, predecessor/ETag and retry state |
| `detached_bodies`, `body_authorizations` | Sender-owned exact body bytes and recipient/message-specific hashed-token authorizations |
| `sent_envelopes`, `received_envelopes` | Exact signed envelopes and durable per-envelope metadata, including authorization mode, parents and shared logical identity |
| `reply_capabilities` | Capabilities issued by this DID, their single-use claim/consumption state and exact original message references |
| `delivery_work` | Pending/terminal receiver work for this account's received envelopes and retry state |
| `verified_body_provenance` | Verified recipient-and-sender scoped body bytes; exports reconstruct the bytes even when local storage deduplicates blobs |
| `delivered_messages` | This DID's durably delivered message references |
| `delivery_status_payloads`, `delivery_status_wrappers` | Immutable status revisions and signed wrappers for received deliveries |
| `terminal_status_publications` | Retained terminal-status publication obligations |
| `sent_delivery_status` | Recipient-signed status received for this DID's sent envelopes |
| `public_plc_resolution_evidence` | Exactly the immutable evidence bundles referenced by the enclosing account authority links |
| `public_envelope_authority_evidence`, `public_grant_authority_evidence`, `public_signing_authority_evidence` | Account-scoped links from exact representations/actions to historical authority decisions |

The ordinary collections are ordered by their stable IDs/revisions in the reference
exporter. Co-located received Grant blocks follow the owned Grant blocks; consumers
MUST NOT assume the concatenation is globally sorted. Portable bindings are ordered
by ID; managed bindings by creation time then ID. These are producer choices,
not alternate signature canonicalization algorithms.

The two current profiles have real field differences, captured by separate schema
definitions: portable public-key metadata includes `encryption_version`, managed
omits it; managed publication/delivery/status work omits `lease_token` and
`lease_expires_at`, whereas portable retains them. These fields are historical
metadata, not destination worker ownership. Destination activation MUST establish
its own execution ownership and serving generation. Do not transfer live sessions,
credentials, passkey secrets, source operational private keys or reusable invitation
bearer secrets. They are outside the declared collection/field domains.

UI-only trash/read/presentation preferences and category-publication batch controls
are not silently added to this profile. Shared-conversation introduction policy,
leave state and replay evidence are included because they affect delivery authority.
The declared domain is protocol-continuity history, not a promise to clone every
piece of provider-local application state.

## Connection checkpoint v3

The checkpoint is exactly `{type,version,accountId,did,sourceGeneration,
sourceServiceBase,capturedAt,sharePolicy,tables}` with type
`hail.connection-history`, version 3 and `sharePolicy:"invalidate-at-cutover"`.
Owner, generation, service base and capture time MUST match the enclosing manifest.

| Collections | Preserved semantics |
| --- | --- |
| `connection_invitations`, `connection_approvals` | Historical invitation and owner-approved consent evidence only; source share codes are invalidated at cutover, not imported as active credentials |
| `account_connections` | Retained native pair IDs, party DIDs/generations, signed consent and terminal history |
| `federated_connection_pairs`, `federated_connection_attempts` | Pair/coordinator location, epoch, exact admission bundles and durable results |
| `federated_connection_events`, `federated_connection_results` | Coordinator events and their causal signed commands/results |
| `federated_connection_tombstones` | Terminal connection IDs/epochs; a later import cannot reopen one |
| `federated_connection_disconnects`, `federated_connection_outbox` | Completed disconnect and replication evidence; unfinished work cannot be discarded to permit a fence |
| `federated_connection_signatures`, `public_plc_resolution_evidence` | Exact controls and their historical signing decisions/bundles |
| `connection_message_batches`, `connection_message_targets` | Sealed private connection-message intent, body/audience and terminal per-recipient results |
| `connection_handover_barriers`, `connection_import_handovers`, `connection_transfer_aborts` | Retained authenticated peer freezes, transitions, releases and exact owner cancellation history |

The explicit projections in the schema omit admission token ciphertext/nonces and
session/passkey challenge state. The history may retain old consent formats as
historical evidence, but new admission uses the current coordinator protocol.
Terminal history is not converted into a fresh connection or a new epoch.

## Conversation checkpoint v1

This is exactly `{type,version,accountId,did,sourceGeneration,sourceServiceBase,
capturedAt,tables}`, type `hail.conversation-history`, version 1. It has a separate
digest; do not merge it into or change the connection-v3 digest domain.

| Collections | Preserved semantics |
| --- | --- |
| `account_conversation_preferences`, `connection_conversation_preferences` | Explicit global/per-connection introduction overrides; absence retains the default, not an invented explicit override |
| `conversation_descriptors` | Immutable signed descriptor, exact representation hash, roster, timestamps and historical signing evidence |
| `conversation_memberships` | Admission, expiry, last activity and manual leave state |
| `conversation_revival_receipts` | Creator/request-ID replay key, exact signed request hash, replay retention deadline and retained outcome |
| `conversation_revival_batches`, `conversation_revival_targets` | Creator-owned operation identity and terminal signed per-recipient revival results |
| `connection_message_batches`, `connection_message_targets` | Sealed shared-message intent, body, complete roster audience and terminal per-recipient delivery results |
| `public_plc_resolution_evidence` | Exactly the descriptor signing-evidence bundles referenced by this checkpoint |

A membership's stored state is `active` or `left`. `expired` is derived from
`expires_at`, not a third stored enum. Leave requires a retained `left_at` value;
active requires null. Importing expired history MUST NOT reset the lease.
Each descriptor belongs to an account membership and includes the owner DID in
its roster. The descriptor identity is `(creator_did,conversation_id)` and its
hash covers complete signed bytes. Shared batch targets belong to that fixed
roster; a submitted target references its exact sent envelope and logical ID.
Connection/checkpoint batches are partitioned by whether conversation context is
present; an importer must not duplicate a shared batch into the private domain.

Current source preferences and memberships replace stale mutable destination
state on return. An absent source membership cannot reactivate an old destination
grant. Preserve original admission time and descriptor identity while updating
source-authoritative expiry/activity/leave state. Existing immutable evidence with
conflicting bytes is an error, not a last-write-wins merge.

## Mandatory semantic validation

Schema validity is necessary but not sufficient. Before staging and activation:

1. Verify the exact manifest digest and source signature, the source's current or
   retained authorized signing decision, exact destination keys/intent, owner
   approval and matching custody profile. Current PLC cutover and monitor gates
   remain separate from archived proof verification.
2. Match every owner-scoped record to the manifest account/DID. Correlation IDs
   referring to other parties do not authorize importing their accounts. Reject
   future serving generations, duplicate logical keys and missing dependencies.
3. Check each Grant revision's original COSE, full representation digest and
   predecessor/current pointer; consent/publication rows reference retained
   revisions. Do not re-sign or recreate Grants as a migration repair.
4. Validate exact body profile bytes and SHA-256; body authorizations reference
   the correct sender-owned body. Received cache provenance remains scoped to
   both recipient and sender, even if physical blob storage is shared.
5. Verify every envelope's signature/history and exact payload digest, parties,
   message ID and stored authorization metadata. Shared envelopes require the
   exact descriptor in the conversation checkpoint. Connection envelopes retain
   the exact connection ID/epoch. Submitted targets cannot lose their envelopes.
6. Bind each delivery/status record to its original envelope. Preserve monotonic
   revisions, terminal results and immutable status payloads. A wrapper's payload
   must equal the retained revision. Reply claims reference the original signed
   invitation and accepted reply; no duplicate available capability is created.
7. Validate all checkpoint hashes and signed-object linkage. Verify historical
   identity/messaging authority using retained PLC chains and current canonical
   history; a nullified branch or missing authority evidence is rejected. A valid
   archived key does not become today's authority.
8. Preserve terminal connection IDs, coordinator epochs and complete local consent.
   Require drained admissions/disconnects/replication and terminal message/revival
   batches before export. Peer handover is required before a new provider may
   activate nonempty connection history. A snapshot alone cannot move location pins.
9. Preserve leave, replay outcomes and lease timestamps atomically with import.
   Validate exact signed revival binding and immutable shared-message intent.
   Never derive permission from possession of a descriptor or conversation ID.
10. Activate only after the fenced source snapshot, owner PLC cutover, destination
    import, peer handover and observation gates all agree. Repeated import must
    preserve bytes and outcome; timeout/expiry never independently releases the
    source fence. Fresh destination login/credentials are separate.

These requirements are exercised by the existing transfer, connection-history,
conversation reconstruction and historical-authority tests. The published vectors
add independently reproducible representation and rejection checks; they do not
replace live authority, concurrency or recovery tests.

## Managed history checkpoint digest

Compute SHA-256 over deterministic CBOR of this map, preserving source array order:

- `type:"hail.managed-migration-history-checkpoint"`, `version:1`, `did`,
  `source_generation`, `connection_checkpoint_digest`, `conversation_checkpoint_digest`.
  Both component digest fields are the manifest's base64url **text**, not bytes.
- `plc`: for each PLC evidence row, `{id,operation_cid,previous_cid,state,
  dag_cbor_sha256}`. Use `previous_cid` or empty string; `state` is
  `submission_state`; the final field is base64url SHA-256 of decoded `dag_cbor`.
- `grants`: for each revision, `{grant_id,revision,status,digest,signer,
  publication,etag}`. Digest is base64url decoded `representation_digest`;
  signer is `signing_public_key`; publication/etag come from the matching
  `(grant_id,revision)` publication, defaulting to `"none"` and `""`.
- `bindings`: `{id,digest,selected_at,published_at}` for each binding. Digest is
  base64url decoded representation digest; absent timestamps become `""`.
- `authority`: `{did,operation_cid,evidence_digest,bundle_sha256}` for each
  resolution row; digest fields are base64url decoded evidence digest and
  SHA-256 of decoded bundle bytes respectively.
- `authority_links`: concatenate envelope links, Grant links, then signing links;
  project `{authority_did,representation_digest,evidence_digest}` and convert
  both digest values from wire hex to base64url text.

Store the resulting hash as base64url `historyCheckpointDigest`. This digest
supplements rather than replaces the signed exact manifest digest.

## Implementation evidence and drift protection

The schema was extracted from the fully migrated reference database and the
actual collector projections. `scripts/export-account-history-schema.ts --check`
creates a fresh disposable database, applies migrations and detects mapping drift.
It never reads account data from the supplied administrative database. Actual
portable/managed exports and nonempty connection/conversation checkpoints are also
schema-checked by integration tests. Updating a database column does not implicitly
amend the protocol: review the projection/schema and vectors in the same change.

[Conformance vectors](vectors/README.md) include fixed actual synthetic exports,
nonempty collected checkpoints, complete signed transfer/handover records and
connection/revival HTTP bodies. TypeScript exercises the real server validators;
Go independently decodes, hashes, verifies signatures and validates record shapes
without importing the server implementation. This establishes cross-language
format evidence, not a claim of a second independently deployed Hail provider.
