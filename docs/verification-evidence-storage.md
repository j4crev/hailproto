# Verification evidence storage

## Production baseline, October 28, 2026

The read-only report from Haili at `2026-10-28 16:03:28.148069 UTC` measured
98,817,727 database bytes (94.24 MiB). The evidence category contained 81,526,784
bytes (77.75 MiB). `public_plc_resolution_evidence` alone used 80,977,920 bytes
(77.23 MiB): 74,498,048 table/TOAST/overhead bytes and 6,479,872 index bytes.
It accounts for 99.33% of the category and 81.95% of the database.

The other evidence tables used 548,864 bytes combined: PLC operations 196,608;
envelope authority 81,920; connection proofs 73,728; onboarding, grant authority
and signing authority 65,536 each. Their respective row counts were 10, 36, 11,
5, 53 and 54.

There were 33,527 resolution observations for 8 DIDs and 12 DID/head pairs.
One head had 16,430 observations. Full bundle payloads totaled 201,451,596 logical
bytes (192.12 MiB), averaging 6,009 bytes, with a maximum of 8,965 bytes.
Stored bundle datums totaled 54,916,418 bytes (52.37 MiB), excluding row/index
overhead. Complete October 22–27 days recorded 4,309–4,771 observations each.
These are observation dates, not insertion dates; imported history can predate import.

Only 137 observations were referenced by the four measured action-link tables;
33,390 (99.59%) were not. This is **not** a deletion eligibility test. The report
does not enumerate embedded JSON references, immutable signed snapshots, or latest
per-DID anti-regression checkpoints. Repeated heads also do not prove identical
audit history. Production byte-level sharing savings have not been measured.

The baseline query is `apps/server/deploy/public/measure-verification-storage.sql`.
It uses a read-only transaction and emits only aggregate information. Its logical
bundle metrics target the pre-80 inline layout; after migration, use the contents
view for reconstructed bytes and inspect shared payloads separately. Dashboard
classification automatically includes `public_plc_shared_evidence` in evidence;
the reconstruction view is not counted as physical storage.

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

A PostgreSQL fixture with 20 observations of one unchanged history used 59,600
logical bundle bytes before sharing and 10,023 shared-payload/fragment/reference
bytes afterward (83.18% reduction). This excludes PostgreSQL compression, indexes
and row overhead and is not a prediction of physical production savings.

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

No production deployment, compaction, evidence deletion or physical reclamation
was performed as part of implementing this change.

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
the baseline cannot attribute unlinked observations to individual callers.
