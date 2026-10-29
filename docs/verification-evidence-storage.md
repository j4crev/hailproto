# Verification evidence storage

## Storage design

Fresh resolution still performs the full bounded network/audit verification and
persists a distinct observation. The complete encoded witness array is shared by
its exact SHA-256 digest; the observation stores a digest reference and the exact
prefix/suffix surrounding that encoded array. Reads concatenate these three byte
sequences, preserving the original bundle digest and bytes without rewriting CBOR,
changing policy identifiers, refreshing timestamps or weakening history checks.

The original evidence table remains the stable foreign-key target. Its full-byte
column remains an accepted legacy import interface. New routine resolutions use
shared storage, while retained full-byte rows remain readable. All application
authority/export readers use `public_plc_resolution_contents`, which exposes only
the original portable columns. Snapshot v3 remains self-contained: neither shared
digests nor storage fragments are exported.

## Coordinated rollout

1. Take and verify the normal backup. Stop all provider/GUI/worker/CLI processes
   using the old evidence reader. Old readers select the now-null inline byte
   column and cannot read compact observations. Mixed old/new serving is unsupported.
2. Apply migration 80 using the new release, then start only the updated processes.
   Schema migration does not rewrite historical rows. New routine observations use
   shared storage immediately; monitor normal authority and transfer operations.
3. To estimate remaining historical compaction, run from `apps/server` with the
   intended database URL in the environment:
   `bun src/cli/compact-plc-evidence.ts`. The default performs read-only queries.
   It reports logical byte estimates, not disk-space reclamation.
4. To compact retained legacy rows, run
   `bun src/cli/compact-plc-evidence.ts --apply`. This is an explicit representation
   rewrite, not deletion. Batches contain at most 250 observations, with 30-second
   statement and 2-second lock timeouts. Each batch commits independently; rerun
   after interruption to resume. Every rewrite is guarded by exact reconstructed
   bytes, original digest and unchanged metadata. Fresh observations and action
   references are preserved. The operation needs write privileges and migration 80.
5. Compare row counts, action links and bundle hashes; inspect both the observation
   and shared-evidence relation sizes. Allocated space may remain reusable after
   updates, so dashboard disk size need not fall immediately. Physical table
   reclamation is a separate operational task, not part of compaction.

## Rollback

Stop all application processes. Ensure enough free space to materialize every
full bundle again, then run `migrations/rollback/0080_shared_plc_evidence.sql` with
`psql -X -v ON_ERROR_STOP=1`. It locks both storage tables, restores exact inline
bytes under the preservation guard, restores the old schema/immutability trigger,
and removes migration 80 from the ledger in one transaction. Later migrations must
be rolled back first. Start the old release only after successful schema rollback.
Foreign-key references and portable evidence remain unchanged.

## Retention follow-up

This change reduces repeated payload storage while retaining every observation.
It deliberately introduces no TTL. A later deletion policy must enumerate direct
and embedded references, retain the latest history needed to detect regression,
honor grant/consent and delivery-history lifetimes, and preserve migration/restore
proof. The current schema does not record a reliable use-case label for each lookup;
storage totals cannot attribute unlinked observations to individual callers.
