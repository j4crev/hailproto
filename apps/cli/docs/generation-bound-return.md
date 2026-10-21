# Generation-bound operation and owner-controlled return

Status: deployed private-POC implementation with [real HTTPS proof](milestone5-release.md).
This builds on [migration 36's history foundation](lifecycle-history-migration.md).
Live hosts run migration 39. Managed/custody changes and public post-export recovery are
still separate gated work.

## Generation enforcement — migration 37

Provider-local side tables bind each credential, owner-login challenge and
worker lease to its original serving generation. Existing generation-1 rows
are backfilled without modifying credential values/scopes, signed challenge
payloads, account rows or v2 snapshots. New bindings are supplied by database
triggers and cannot be updated into another generation.

Authentication requires the credential's generation to match the current
account. Issuance cannot reuse a stale-generation token even if its revocation
flag was cleared. Owner-login completion checks the stored challenge generation
under the account lock; an old signature cannot issue access for a returned
account simply because identity/recovery public keys are unchanged.

HTTP and background-worker entry points capture admitted generations. The native
SQL transaction adapter carries that admission in transaction-local settings,
rechecks it before reads, and checks the relevant account again at the existing
account-row write serialization point. A request/worker paused across a return
cannot read returned keys and then commit against the new projection. Work lease
tokens also retain their generation; imported leases are cleared, while attempts,
effective deadlines and stored retry schedules remain intact.

The private-POC implementation captures a provider-wide generation vector at
entry, costing O(accounts). An unrelated generation change may invalidate a
concurrent admission conservatively. Per-DID capture is the upgrade path if that
cost becomes material. Separate provider HTTP entries establish separate vectors,
including in the in-process tests. Only a successfully committed lifecycle
materialization updates that operation's own admission to the new generation.

Mixed-version operation is supported at generation 1. Upgrade every serving
process and worker before enabling returns; old unscoped writers are refused at
generation 2+, but this is not a claim that an old binary implements the new read
admission rules. Do not roll back application code after advancement.

## Return materialization — migration 38

Migration 38 retains immutable incoming import/invitation/reservation/public-key
evidence when an imported account later retires. Prepared private ciphertext is
excluded from this history. Retired slots can be recycled only when their exact
current records match the retained evidence; they are not overwritten in place.

The returning provider enables `POC_SELF_SERVICE_RETURN=true` alongside
`POC_SELF_SERVICE_TRANSFER=true`. The return gate is private-PLC only. Use the
same `offer`, `select`, `export`, `sign-cutover` and `complete` commands, with the
current provider's credential and a new private transfer state. This initial
return profile preserves the same owner identity and recovery keys and requires
a newly available username: retired canonical addresses are not automatically
reclaimed or revived as aliases.

Before staging, the destination requires an exactly archived retired account,
fence/export/consumed authorization and matching owner custody. The latest source
snapshot must preserve known immutable envelope, Grant, consent, PLC, body and
status evidence; it cannot omit or rewind delivery/reply/publication obligations,
received statuses, terminal states or acknowledged checkpoints. Missing retained
evidence blocks the move rather than being filled from an older snapshot.
Grant arrival time is a receiver-local observation, not a signed checkpoint field;
its prior value remains in the immutable archive when a grantee replica differs.

After the exact owner-signed PLC operation and destination binding verify, one
account-locked transaction detaches archived legacy fence/export/authorization
records, revokes old credentials, replaces only the returning DID's working
projection and advances its generation by one. The logical account/DID IDs stay
stable. Collocated counterpart Grant ownership/evidence is retained; conflicts
abort the whole transaction. New operational keys remain destination-local.

The immutable outgoing and incoming histories survive detachment. Old account
keys, queues and tokens are not reopened. Current address discovery follows the
new canonical address/provisional reservation, while older binding IDs remain
historical representations. Fresh destination access uses explicit owner login.

## Proof and rollback

The full private-POC integration fixture now proves A → B → A with a collocated
peer, work delivered/accepted at B, a pending retrieval lease, a publication
acknowledgement, a lost return-activation response and a fresh returning login.
It verifies:

- one executable provider owner and generation 2 at returning A;
- retained old snapshots, signatures/receipts and incoming lifecycle evidence;
- stale token rejection independent of its revocation flag, stale owner challenge
  rejection, and a request actually paused across the moves;
- old delivery/publication lease rejection and generation-2 resumed work;
- preserved attempts, delivered state, outbox acknowledgements, reply/Grant
  ownership guards and unchanged status payloads rewrapped under the new key;
- continued operation of the collocated peer and no automatic old-address revival.

Recorded gates: provider typecheck/build, 108 general provider tests (65 database
tests skipped without database environment), and 47 focused PostgreSQL/TLS tests
on fresh disposable databases. The focused gate includes return, migration,
owner access, account API, fences, cancellation/cleanup, Grant updates/repository
and envelope repository regressions. Disposable databases are removed afterward.

The migration preservation fixture covers legacy SQL/authentication and repeated
upgrade plus schema rollback/re-upgrade at generation 1. Provider rollback script
`migrations/rollback/0037_generation_admission.sql` removes 38/37 only when there
is no later migration, every generation is 1, and every incoming archive still
has an exact legacy copy. It refuses rollback after advancement or detachment.
Migration 36's earlier guarded rollback remains separate. Neither script is PLC
recovery or permission to reopen a fence.

The [post-export recovery proof](post-export-recovery.md) now separately implements
protective owner-signed PLC state and coordinated invalidation/release/resumption
for a staged never-active target. A return transfer itself does not implement
that protocol; the coordinator remains internal. Historical identity-key reconciliation and
managed/custody transitions remain disabled; this proof does not establish
public-PLC/independent-monitor guarantees.
