# Connection History Portability — In Progress

Connections must move through the existing portable/managed account-transfer
snapshot, staged import and fenced cutover. There is no separate downloadable
backup format, automatic link forwarding, or new connection permission.

## Implemented Snapshot/Staging Path (Not Enabled For Connection Cutover)

`apps/server/src/migration/connection-history.ts` implements the shared
`hail.connection-history` version-1 checkpoint domain. New exports embed it in
portable snapshot **v5** and managed snapshot **v6**, with a deterministic
`connectionCheckpointDigest`. Both carry the source serving generation. Snapshot
signatures use distinct `hail-migration-snapshot-v5\0` / `v6\0` domains; managed
owner approval names the exact snapshot version and its history checkpoint also
binds the connection digest. Legacy portable v2/v3 and managed v4 snapshots retain
their original verification/signature domains. Old receivers reject new versions.

Existing source fence/generation/custody guards are unchanged: accounts with
retained connection consent still cannot begin a provider move. Accounts without
connection history can use the new snapshots through existing completion paths.
Import staging validates and retains the complete checkpoint in the exact signed
manifest bytes, without inserting its rows into live connection/approval tables.
Connection-authorized envelopes require a connection-history snapshot version
(the envelope itself remains v2); submitted batch targets must retain their exact
sent envelope. History cannot silently be dropped by relabeling an extended
snapshot as an older version. Nonempty connection history returns
`awaiting-connection-handover` before PLC submission, and direct submission and
activation paths independently refuse it. CLI completion retains pending state
instead of treating this phase as takeover or reporting an active destination.

The collector takes the existing export transaction, exact source account/DID,
serving generation, service base and capture time. Export integration must fence
and drain the source before collection; a read-only repeatable-read transaction
can exercise collection without granting cutover authority. It never changes
invitation revocation, pair state or serving generations and makes no network calls.

The closed serialization domain retains:

- Native pair IDs, both DIDs/generations, exact `grants-v1` or `joint-v1` consent,
  signing evidence and terminal disconnect history, including older relationships.
- Federated pairs, consent bundles, admissions/results, canonical events, causal
  signed commands, tombstones, completed disconnect/replication work and locally
  retained control-signature authority. Referenced public PLC evidence bundles are
  retained even when ordinary envelope/Grant history does not reference them.
- Invitation history, including revoked and source-active codes, as historical
  observations only. Token ciphertexts/nonces are excluded. The explicit policy is
  `invalidate-at-cutover`; these records must never become live destination codes.
- Account-local approvals without session IDs, credential IDs, challenges or
  encrypted pending tokens. They are historical evidence, not resumable approvals.
- Sealed connection-message batches, exact immutable audiences, message IDs/epochs,
  body bytes and terminal submission outcomes. Original signed envelopes, bodies,
  delivery/status and replay history remain in the enclosing account snapshot;
  this component does not duplicate or replace those existing domains.

Explicit column projections fail closed on unknown checkpoint fields. The
validator checks ownership, references, signed-payload linkage, digest integrity,
terminal-state consistency and exact batch intent/audience. The checkpoint digest
is SHA-256 over deterministic CBOR of the complete component; the future enclosing
snapshot signature must bind it together with the account and message history.
This is structural/integrity validation, **not** historical signature verification
or permission to materialize rows into live tables.

## Authenticated Handover Preparation

`POST /hail/connections/handover` is a provider-only, bounded JSON exchange under
the existing connection ingress checks. It accepts `{proposal,destinationSignature}`.
The proposal uses the existing detached signed-record wire shape; the destination
signature covers exactly the same deterministic CBOR bytes, without repeating the
payload. Browser cookies, bearer credentials, Origin, encoded bodies and redirects
are not part of this exchange.

`hail.connection-handover-prepare` v1 binds a request ID, transfer ID, both DIDs,
source/destination service bases, destination messaging key, source generation,
the full snapshot digest, the connection checkpoint digest, the pair frontier and
a lifetime of at most five minutes. Signature contexts are distinct:

- `hail.connection-handover.source.v1\0`
- `hail.connection-handover.destination.v1\0`
- `hail.connection-handover.peer-ack.v1\0`

Each signature covers its context followed by the same exact encoded plan.
The source must still be designated by current PLC authority. The destination
proves possession of the messaging key bound by the source's proposal; staging
checks that it is the key in the already authenticated transfer manifest. The
peer uses its own current messaging authority and local account transaction to
check native IDs/states and the canonical federated ID/state/epoch and terminal ID
set. Existing provider location pins remain enforced. Replica-local tombstone
observation epochs may differ: an initiating provider can tombstone at the active
epoch before learning the coordinator's close epoch. The checkpoint retains those
exact rows; the peer comparison does not mistake them for different canonical
frontiers. A changed canonical epoch or missing terminal ID is still refused.

`POST /hail/transfers/connection-handovers`, using the existing transfer media
type and ingress rate limiter, accepts `{proposal,destinationSignature,preparation}`
after ordinary transfer staging. It verifies all three signatures, exact staged
snapshot/checkpoint/destination selection, current source/peer authority and
location, then durably retains immutable preparation evidence (migration 66).
Exact retries do not duplicate or replace evidence. A stale preparation must be
renewed; persisted preparation is not an evergreen permission. The response is
`phase:"prepared",cutoverAuthorized:false`.

Preparation does **not** freeze the peer, change a provider location, revoke a
code, advance an epoch, materialize a live connection, or authorize PLC cutover.
It is not an owner migration approval or a commit certificate. This stage exposes
verification/receipt endpoints, not automatic source-to-peer orchestration or
destination proof issuance; those still need the fenced cutover workflow.
Proposal/frontier sizes are bounded and oversized histories fail closed rather
than being truncated. Code rollback must retain migration 66 and its receipts;
schema rollback refuses retained preparation evidence.

Version one refuses unfinished native/passkey consent, outbound admissions,
unresolved disconnects, unacknowledged replication and pending message targets.
Expired unused reviews can remain as history. An admitted inbound proof without a
locally committed result must finish or pass its admission window; expiry is not
invented evidence of a remote failure. No work is silently cancelled by collection.

## Remaining Activation Gates

1. Verify historical identity/provider signatures against authenticated retained
   PLC evidence, not just today's rotated keys. Missing historical peer authority
   must block migration, not be reconstructed from an unauthenticated assertion.
2. Reconstruct live projections from the inert staged history only after commit.
   Account isolation, duplicate IDs, conflicting bytes and return migrations must
   be checked before any live authority is granted. Existing session/passkey
   approvals do not carry authority to the destination.
3. Orchestrate preparation and implement fenced, durable pair checkpoint commit
   with peers before source-to-destination ownership handover. Recheck or freeze
   the prepared frontier so a disconnect after preparation cannot be lost. A moved
   coordinator continues the
   exact epoch/event/result history; it must not synthesize an empty pair. Convert
   native pairs becoming remote without changing IDs, message epoch 1, either
   consent format, or prior disconnect/reconnect history. Frozen peers/coordinators
   must hold delivery during unavailable or ambiguous authority.
4. Warn explicitly before cutover that **all old QR codes and share links stop
   working, including the permanent personal code**. Invalidate them only at the
   committed cutover, retain historical revocations, and require fresh
   identity-authorized codes after destination activation. Preview/review or a
   cancelled preparation must not revoke source codes.
5. Prove interruption, exact retries, restart, rollback, stale admission/sync replay,
   simultaneous moves, mixed-version refusal and no double-serving before relaxing
   any fence/generation/custody guard. Do not enable custody transitions merely
   because provider transfer preservation becomes available.

Code rollback must retain extended snapshot bytes and preparation receipts and
refuse incompatible activation, never erase history or reset epochs. No legacy
signed bytes or connection/message tables have been rewritten.

## Verification

Unit checks exercise signed native consent, account/generation substitution,
secret-field rejection, terminal-state preservation, altered authority bundles and
immutable private batch audiences. The existing independent-provider PostgreSQL
integration additionally captures real native/federated/message history twice,
compares checkpoint digests, checks source invitations are unchanged, rejects
foreign ownership and unfinished consent, and confirms cutover remains blocked.
The extended fixture also obtains real native/federated peer preparations, rejects
wrong-purpose destination signatures and changed frontiers, retains exact retries
at the inert import boundary, and proves graph state is unchanged. Ordinary
portable/managed migration fixtures exercise new snapshot signing, staging,
completion and returning-history behavior for accounts without connections.
