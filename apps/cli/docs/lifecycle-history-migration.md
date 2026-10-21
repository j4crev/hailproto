# Lifecycle history foundation — local migration 36

Status: deployed as part of the [migration-39 release](milestone5-release.md). This is the expand stage
of the [custody/return design](custody-transitions.md), not a return-transfer or
post-export rollback implementation. Live POC providers run migration 39.

## Preserved shapes and authority

Migration 36 creates `account_serving_generations` alongside the existing account
table. It backfills generation `1` for every account and initializes the same
metadata when old or new runtime code inserts an account. Metadata for a removed
working account cascades away. The constraint permits only generation `1`:
generation advancement is blocked until admission, credentials/challenges and
workers enforce it and the corresponding transition proof passes.

Keeping this metadata separate is deliberate. `provider_accounts` is included
in signed v2 manifests and imported with `jsonb_populate_record(NULL, ...)`.
Adding a non-null generation column there would change new snapshot shapes and
make old snapshots produce a null field during import. This expansion changes
no existing account, credential, challenge, custody, Grant, binding, message,
outbox, fence or signed snapshot row. Current account IDs and scopes stay intact.

## Immutable retired evidence

`provider_retired_transfer_history` records each retired transfer under its
transfer ID, with its DID, original account ID and serving generation. It keeps
the exact fence, export and consumed authorization records. Historical account
identifiers do not reference mutable working rows, so projection cleanup cannot
cascade away evidence. The original working records remain in place.

The migration backfills existing retired transfers. A trigger archives future
retirements in the same transaction, including those performed by unchanged
runtime code. A retired transfer without a matching retained export/digest
cannot be archived or committed as a new retirement. Legacy consumed
authorization may be absent; that absence is retained rather than invented.

PostgreSQL `bytea` is preserved in reversible hex form inside JSONB. Manifest,
signature, handshake and retirement-receipt bytes are not decoded, re-encoded
as protocol objects or re-signed. SQL-row field ordering is not a signed domain.
This intentionally duplicates export storage, with approximately twice the
`bytea` size for hex fields; raw-bytea archive columns can replace that encoding
if snapshot volume warrants a separately verified storage migration.

Archive updates, deletes and truncation fail. Exact archival retries reuse the
same entry; conflicting evidence fails. A retired fence cannot be changed back
to an executable state or rewritten with conflicting archived metadata. These
guards preserve evidence; they do not authorize source resumption or make the
archive a second executable outbox.

## Compatibility and rollback

Old runtime SQL continues to use the original account/credential/snapshot shapes;
database triggers supply the new metadata and archival writes. Generation stays
at `1`, so there is no mixed-version generation transition to admit accidentally.
An application rollback may leave the additive schema in place. Local checks
exercise unchanged bearer authentication and legacy import SQL, not a live
restored-copy deployment rehearsal.

The provider includes a separately executable schema rollback at
`migrations/rollback/0036_serving_lifecycle_history.sql`. It locks the relevant
tables and verifies:

- the migration ledger identifies 36 and no later migration is applied;
- all serving metadata is still generation `1`;
- every archived fence/export/authorization still matches the original records.

Only then does it remove the additive tables/functions/triggers and ledger row.
If a legacy projection has been detached, changed or lost, the archive may be
the only complete copy and rollback is refused. Existing rows and signed bytes
are never restored from a guessed equivalent representation. The script runs
inside its own transaction; failure leaves the expansion intact. Schema rollback
is separate from PLC/data recovery and never releases an exported fence.

## Verification

`test/serving-history-migration.integration.test.ts` creates an isolated schema
at migration 35, seeds legacy retired/account/credential/challenge records and
checks ordered row hashes/counts for every pre-existing table. It proves:

1. Forward and repeat migration preserve those rows and existing bearer sessions.
2. Backfill and future retirement capture exact bytes and consumed authorization;
   exact archival replay creates no duplicate.
3. Immutable-history writes/truncation, retired-fence reopening and generation
   `2` are rejected.
4. Old snapshot-shaped account insertion still works and initializes metadata.
5. Rollback refuses after an original export diverges, succeeds once exact
   redundancy is restored, preserves all old rows, and permits exact re-upgrade.

Synthetic legacy rows isolate serialization preservation from cryptographic
validation. The real signed private-POC transfer fixture additionally verifies
that source retirement archives the exact authenticated snapshot, signature and
retirement receipt. Adjacent account-access fixtures retain an export for their
synthetic retired state rather than constructing an impossible orphan retirement.

The focused migration/transfer/fence/cleanup/account-API/account-access gate passed
**32 tests**, serially against disposable databases. Test schemas/databases are
removed after verification. No provider rollout or live database alteration was
performed.

## Next stage

The [generation-bound operation and return stage](generation-bound-return.md)
is now implemented locally as migrations 37/38, including a positive private
owner-controlled A → B → A proof. The generation-1-only constraints described
above belong to the reversible migration-36 expand stage; advancement becomes
available only through the new reviewed materialization path.

Bind credentials, owner-login challenges and every leased/admitted worker to a
serving generation before permitting advancement. Then implement transactional
archive/detachment and returning materialization with collocated ownership and
replay/state-preservation checks. Prove A → B → A using work created at B and
stale A tokens/workers. Protective PLC abandonment and active-target reverse
transfer still require their separate positive race/recovery tests. The roadmap's
return/rollback checkbox remains open.
