# Coordinated post-export recovery — private-POC proof

Status: local domain implementation and positive race proof. The coordinator is
not registered as public routes or a `hailp` command. Its migration/code is included
in the [private-POC migration-39 release](milestone5-release.md); the recovery race
proof remains a local integration result, not a live recovery ceremony.
This covers a durably staged destination that never became active. An active or
uncertain destination requires a new reverse transfer of its latest state.

## Authorization and durable stages

The owner explicitly signs purpose-separated P-256 recovery approvals for
abandonment and resumption. They bind DID/transfer, source/destination, original
source generation, snapshot digest, exact prepared cutover CID, nonce and a
one-hour acceptance window. Resumption also binds the target invalidation digest
and exact protective operation CID. Ordinary API tokens and provider identity
keys are not substitutes. Only the reviewed full-vault surface exposes this
signer; identity-only routine signing does not load recovery authority.

The provider's `PrivatePocTransferAbandonment` coordinator has three stages:

1. **Invalidate target.** Under the staged import-row lock, verify independent
   owner approval and known PLC authority, reject an active import, invalidate
   activation eligibility, and retain an exact signed prepared-target-key receipt.
   Reservation remains held. Retry returns the same receipt, never a new intent.
2. **Release target after protection.** The owner submits a separately reviewed
   protective PLC operation and resumption approval. The target verifies that the
   exact source-restoring operation is current and owner-signed before releasing
   its provisional address/slot. It signs and retains the exact release receipt,
   full import/handshake/public-key/observation evidence and nonce tombstone.
3. **Resume source.** Verify that release against the origin-confirmed destination
   key in the source fence, owner approval and the exact current protective PLC
   state. Verify the source binding and frozen generation/export, then atomically
   retain abandonment evidence, detach the obsolete fence/export/authorization,
   revoke old credentials, clear old leases and advance source serving generation.
   Append protective PLC evidence without altering accepted work/status/outbox
   state. A stored signed source receipt recovers a lost completion response.

The target's release is accepted only while the resumption approval is current.
Once durably accepted, its signed timestamp/digest permits exact source completion
recovery after approval expiry, like accepted cutover recovery. It does not
authorize a fresh PLC write after expiry. No original API credential is forwarded.
The source requires its original binding to remain verifiable; expiry/conflict
holds the fence rather than silently extending authorization.

## PLC and database races

PLC operations do not expire when local consent does. The protective operation
must preserve the owner's identity/recovery and complete original source state,
including unrelated methods/services/ordered aliases, and remove prepared target
authority. Only the recognized source predecessor or exact prepared cutover CID
is an allowed predecessor. Unknown intervening operations need separate recovery.

If the protective operation wins first, the delayed original cutover cannot
nullify it: PLC requires a strictly higher-priority signer than the first
nullified operation, and the same index-zero owner key has no such priority.
The integration proof invokes the official PLC `assureValidNextOp()` verifier,
not only an artificial stale-predecessor check.

If the cutover wins first, the source stays fenced. A protective operation signed
against the old source predecessor is not silently rebased or reused as a fork.
The owner explicitly signs a new normal append to that recognized cutover CID,
restoring source state. Neither provider may become writable before this exact
operation and the release receipt verify.

Private-POC submission now holds the staged import-row lock across its bounded
PLC request. Invalidation waits for that internal attempt; address publication
also locks/rechecks staging before writes. Activation already rechecks under the
same lock. A crashed/timed-out external request can still be delayed outside the
database; the protective PLC successor, not a lease timeout, prevents its replay.

## Migration 39 and preservation

Migration 39 adds durable source/target abandonment records and immutable retired
observation history. The latter fixes old-import slot recycling without dropping
its PLC observation evidence or changing migration-38 history shapes. Completed
records cannot be rewritten, deleted or truncated. Old source grant nonces are
blocked from reissue, and the target retains its cancellation tombstone after
slot release. Retained snapshots/receipts are exact bytes, not equivalent re-signings.
Prepared private ciphertext is excluded from history.

The migration's guarded schema rollback refuses after any accepted abandonment
or later migration, or if an observation archive is the sole remaining copy.
Empty, redundant expansion can roll back/re-upgrade while legacy rows remain
unchanged. This is schema rollback, not ownership or PLC recovery.

## Proof and boundaries

The existing full integration fixture exercises both race orders after a real
A → B → A return, using the current source's latest dataset. It proves import
invalidation blocks on an in-flight submission, source stays fenced without a
current protective operation, official PLC validation rejects delayed cutover,
and target/source exact receipts recover across coordinator restart. It also
rejects active-target abandonment and forged release receipts, prevents old
nonce reissue, preserves delivered work and snapshot evidence, advances source
generation and requires fresh source login.

Recorded gates: both client/provider typechecks and builds, 6 client tests,
108 general provider tests (66 database tests skipped without database variables),
and 48 focused PostgreSQL/TLS integrations on disposable databases. The schema
preservation fixture also proves empty/redundant migration-39 rollback and
re-upgrade; accepted recovery refuses that rollback.

The proof is private-PLC and cooperative-provider scoped. Public finality,
independent monitors, historical identity-key reconciliation and managed custody
execution remain their existing gates. Unstaged/unknown imports, unknown forks,
unavailable counterpart proof and expired/conflicting source bindings do not get
an automatic resumption path. Broader backup/restore and public-API recovery
ceremonies remain separate work; waiting for expiry or restoring a dump alone
never grants serving authority.
