# PLC Replica Deployment Plan

Hail should use the official [`go-didplc` read replica](https://github.com/did-method-plc/go-didplc/tree/main/cmd/plc-replica) rather than implement a second replication engine in TypeScript. The canonical write destination remains `https://plc.directory`; replicas are read-only independent witnesses.

## Phase 1 — Prove Hail Compatibility Using Existing Mirrors

Modify `hail-server-ts`, not the replica:

1. Accept both `application/did+json` and `application/did+ld+json`.
2. Normalize relative versus absolute verification-method and service IDs.
3. Continue deriving authority from validated `data`, `log`, and `audit`, not the rendered document.
4. Add reader health and freshness checks using `/_health`.
5. Fail closed on stale health, malformed timestamps, outage, or disagreement.
6. Add focused tests using the official replica's document shape.
7. Add an opt-in live smoke test against `plc.wtf` and `plc.eurosky.network`.

Acceptance: a Hail DID represented identically in both replicas resolves successfully; stale, conflicting, or unavailable replicas cannot authorize anything.

## Phase 2 — Package the Official Replica for Independent Operators

Create a small deployment repository, tentatively `hail-plc-replica-deploy`. It should contain configuration, not a replacement implementation:

- Official `plc-replica` pinned to an exact commit.
- SQLite persistent volume initially; upstream reports it backfills faster than PostgreSQL.
- Caddy or another standard TLS reverse proxy.
- Public read API only.
- Metrics bound privately.
- Disk, process, ingestion-lag, TLS, and endpoint monitoring.
- Filesystem or volume snapshots to independent storage.
- Restore and full-resync runbook.
- A Bun smoke-check script that validates a known DID through the Hail validator.

The official replica currently has no tagged release, so pinning an audited commit is important.

## Phase 3 — Backfill and Qualify a Deployment

1. Start from sequence zero—no arbitrary cursor bootstrap.
2. Allow the official replica to backfill and validate all history.
3. Keep it out of Hail production configuration until caught up.
4. Verify representative DIDs, including legacy genesis, updates, nullified recovery branches, tombstones, and Hail-specific keys and service.
5. Restart it and prove cursor durability and stream resumption.
6. Record operator, origin, software commit, database mode, and backup policy.

## Phase 4 — Connect Two Genuinely Independent Readers

Configure `PLC_PUBLIC_READERS` with two reviewed operators:

```dotenv
PLC_AUTHORITY_PROFILE=strict-public-v1
PLC_DIRECTORY_URL=https://plc.directory
PLC_PUBLIC_READERS=[{"origin":"https://reader-one.example","operator":"operator-one"},{"origin":"https://reader-two.example","operator":"operator-two"}]
PLC_PROVIDER_OPERATORS=["hail-provider-operator"]
```

A Hail-provider-operated replica cannot count as independent from that provider. Two hostnames or regions owned by one operator also do not count as two witnesses.

Existing public replicas can be used initially if their operators and operating commitments are reviewed.

## Phase 5 — Canary and Operations

Before public Hail activation:

- Run disagreement and reader-outage exercises.
- Stop ingestion and prove stale reads are refused.
- Restore a snapshot and prove catch-up.
- Confirm writes still go exclusively to `plc.directory`.
- Run one disposable public Hail DID through onboarding and resolution.
- Retain the exact reader evidence already supported by Hail.

## Initial Non-Goals

- A custom TypeScript replication or validation engine.
- Proxying PLC writes.
- A web dashboard.
- New checkpoint or consensus protocols.
- Merging the monitor and replica.
- `/export` support on the mirror. The official replica does not expose it, so `hail-plc-monitor-ts` continues consuming `plc.directory` directly.
