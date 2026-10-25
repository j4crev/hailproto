# Connection History Portability — In Progress

Connections must move through the existing portable/managed account-transfer
snapshot, staged import and fenced cutover. There is no separate downloadable
backup format, automatic link forwarding, or new connection permission.

## Implemented Snapshot/Staging Path (Not Enabled For Connection Cutover)

`apps/server/src/migration/connection-history.ts` implements the shared
`hail.connection-history` version-2 checkpoint domain. New exports embed it in
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
activation paths require retained peer commits before materialization. Source
fencing and PLC submission still refuse connection-bearing moves. CLI completion retains pending state
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
The checkpoint parser is structural/integrity validation, not permission to
materialize rows into live tables. Import and handover staging now additionally
run the historical authority verification below.

## Historical Signature Verification

`connection-history-verification.ts` checks original COSE bytes against the exact
retained signing-role decision. It validates each retained PLC chain and its full
state/document, then requires that chain to remain a prefix of the current
canonical chain obtained through the configured resolver. Legitimate later key
rotation therefore does not rewrite or invalidate old consent. A recovered or
nullified branch is refused, even if its signatures are mathematically valid.
Public authority references require the exact retained bundle, matching metadata,
validated witness audit, and exact signed DAG-CBOR operation bytes. Current public
authority must be fresh; historical evidence is not subjected to today's consent
expiry window. Receipt issuance timestamps can describe the historical event,
not when an operational wrapper was signed, so keys are not inferred from a
payload timestamp.

The pass verifies native invitations/confirmations and both original `grants-v1`
signatures where applicable. For federation it verifies the retained signed
proofs, invitation/address-binding/confirmation linkage, reviewed snapshot,
admission and activation receipts, causal commands, disconnect results and
digest-bound delivery acknowledgements. It rejects identity/messaging role
substitution and missing historical peer signing decisions rather than trying
every past key. Structural validation still owns IDs, account isolation, immutable
batch audiences and terminal-state consistency. Neither pass grants live authority.

Migration 67 adds an account-scoped `connection_proof_signatures` ledger for
accepted consent and peer control verification. Accepted bundles retain identity
and reviewed-coordinator evidence in their account transaction. Peer control
evidence is retained for known pairs; arbitrary unsolicited probes do not create
proof rows. The same remote standing invitation can be retained independently by
multiple local accounts. The old local-control ledger and its conflict key remain
unchanged for mixed-version lifecycle writers. Collection merges both ledgers
into the existing checkpoint signature domain, preferring original local signing
evidence for duplicate COSE. The checkpoint digest uses account-history resource
limits, not the 256 KiB single-envelope budget.

Older checkpoints without the necessary peer evidence remain inert and fail this
pass. No migration silently backfills a guessed role decision or relabels a missing
proof as verified. Per the [pre-launch development policy](../README.md#pre-launch-development-policy--developers-and-agents),
do **not** build a legacy-proof reconciliation subsystem to rescue existing test
relationships. Identify and explicitly clean up unsupported records, then recreate
those relationships under the intended design. This does not relax verification
or preservation requirements for history created under that design.

The implementation currently retains migration 67 and refuses schema rollback with
proof authority present; existing fence/custody/generation guards remain unchanged.
Any planned breaking cleanup must define its affected records and referentially
consistent migration explicitly, not bypass these guards ad hoc.

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

## Durable Peer Freeze And Pre-Cutover Abort

Migration 68 adds an immutable peer-side `connection_handover_barriers` journal.
`POST /hail/connections/handover-freeze` accepts the same plan bytes as preparation
but requires distinct `source-freeze` and `destination-freeze` signature contexts;
ordinary preparation signatures cannot cause a freeze. The source signature
attests a fixed, drained, fenced export. The peer checks its exact current
frontier under the account lock and records a `peer-freeze` receipt before replying.
An unresolved freeze cannot be replaced by another plan for the same pair.

The freeze is durable **without a lease expiry**. Exact retries recover the
stored result after restart or transport expiry, without admitting a new action.
Native/federated activation and final delivery checks serialize against the
same account lock. The existing permission predicate remains responsible for
connection IDs/epochs and terminal state; a separate pause check prevents delivery.
An authenticated envelope for an otherwise permitted relationship can still be
accepted durably, but body retrieval/delivery stays on hold. A freeze during body
retrieval prevents final delivery without converting a temporary pause into a
permanent policy rejection. Disconnected relationships remain permanent rejections.
Other peers and subscription permissions are unaffected.

`POST /hail/connections/handover-abort` accepts an exact, fresh
`hail.connection-handover-abort` command naming the stored plan digest, transfer
and both DIDs. It requires `source-abort` and `destination-abort` signatures.
Current PLC must still designate the original source; the old source cannot
release the hold after location cutover. The peer durably records a `peer-release`
receipt. Abort does not rewrite epochs, consent or tombstones. Disconnects can
continue while frozen, and abort never revives them. Replaying the original freeze
after release returns the terminal released result rather than freezing again.
These contexts all use the existing `hail.connection-handover.<role>.v1\0` prefix.

Automatic source orchestration remains unfinished. Checkpoint v2 preserves
released/completed journals and their original scoped signatures and authority;
unfinished journals fail collection. Source cutover/custody guards remain until
subsequent-move preservation is proven. Schema rollback refuses any journal rows;
code rollback must retain the table and the SQL pause/activation protections.
No source transfer guard has been removed, and no hosted records have been reset.

## Federated Commit And Reconstruction Components (Not End-To-End Enabled)

Migration 69 adds destination handover progress and immutable history archives.
`POST /hail/transfers/connection-progress/freeze` binds the dual-signed freeze to
the exact staged snapshot and prepared destination messaging key, contacts the
peer and retains its durable receipt. This consumes signatures; it does not yet
issue them from an authenticated source export or prepared destination key.

After PLC designates that exact destination service and messaging key,
`POST /hail/connections/handover-commit` accepts a `destination-commit` signature
binding the held plan and destination address binding. The peer updates location
pins without changing IDs, consent or epochs and retains a `peer-commit` receipt.
Messaging stays held. Native records are explicitly refused by reconstruction;
this is not an adapter for older native consent.

`POST /hail/transfers/connection-progress/transition` verifies the destination
command and peer receipt against current authority and retains exact artifacts.
A peer result issued within its command window remains importable after transport
expiry; accepting that historical result cannot execute a new peer action.
Account materialization requires every peer commit, reconstructs federated state
and private batch intent, archives historical approvals/codes without making them
live, and applies terminal IDs learned during the freeze. Original signed bytes
are unchanged. Duplicate IDs with conflicting bytes or account ownership fail.

`POST /hail/connections/handover-complete` requires a `destination-complete`
signature and the exact account activation receipt bound to snapshot, destination
and address. Its `peer-complete` receipt supplies the final terminal overlay.
Destination messaging remains held until that receipt is imported. Exact retries
recover retained results after restart; committed/completed states cannot abort.
Disconnects during the hold remain terminal and require an explicit reconnect.

Replication now retains one proof-bound result per accepted connect request,
including crossed requests sharing one canonical event. Freeze refuses unresolved
replication. This avoids leaving a valid consent attempt permanently pending when
replication recovered a lost commit reply.

The three-provider fixture seeds ordinary authenticated import/base-account
materialization boundaries, performs a real PLC key/location change and exercises
peer RPC, reconstruction, lost commit/completion replies, disconnect during hold,
reconnect, historical reads and new messaging. It does **not** prove source
orchestration, actual connection-bearing account completion, native conversion,
simultaneous moves or returning imports with previously retained journals.

CLI cutover signing warns that all old codes, including permanent personal codes,
stop working. Source retirement revokes invitation rows; changed PLC authority
already prevents the old provider from serving them. Destination materialization
does not import tokens and revokes prior-generation codes. Cancellation and exact
invalidation timing still need proof through the complete account-transfer flow.

### Pre-launch Cleanup Boundary — No Cleanup Executed

Checkpoint v1 and records lacking required retained signing evidence are not
silently upgraded. Native `account_connections` currently cannot reconstruct at
the destination. Keep these moves blocked; do not invent past signatures or PLC
roles to rescue test relationships. Before an explicitly approved reset, inventory
the exact account/pair IDs and dependent invitation/approval, federation proof,
message-target and envelope references, take and verify a hosted backup, and
specify a transaction preserving referential consistency. Existing messages,
accounts, keys and recovery material are outside any implicit cleanup scope.
Relationships removed by an approved reset must be recreated through fresh consent.
No reset script or hosted data deletion is authorized by this document.

## Remaining Activation Gates

1. Define the breaking cleanup/upgrade boundary for unsupported pre-launch data;
   do not add legacy-proof reconciliation. Reverify supported history's authority
   at final commit; a successful staging pass is not an evergreen authorization
   after PLC recovery or changed peer state.
2. Reconstruct live projections from the inert staged history only after commit.
   Account isolation, duplicate IDs, conflicting bytes and return migrations must
   be checked before any live authority is granted. Existing session/passkey
   approvals do not carry authority to the destination.
3. Wire source-side preparation/freeze orchestration and implement post-PLC pair
   checkpoint commit, peer location updates and final release. Carry terminal
   changes learned while frozen into destination activation and preserve the
   complete freeze/release journal on later moves. A moved coordinator continues the
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
Historical-authority unit checks use real PLC chains and cover key rotation,
forged signatures, wrong signing roles, noncanonical recovery branches,
`grants-v1` preservation, missing public bundles and tampered witness/operation
bytes. The independent-provider fixture now also uses real PLC genesis chains,
shares one remote code across two local accounts, verifies complete native and
federated history at handover staging, and refuses missing peer proof authority.
The barrier checks cover explicit freeze/abort purpose separation, durable lost
freeze/abort replies, fresh service instances, transport expiry without auto-release,
peer-scoped holds, accepted-but-held envelopes, freeze during body retrieval,
native/federated activation refusal, changed-PLC abort refusal, disconnect during
freeze, terminal replay and retained-journal rollback refusal.
