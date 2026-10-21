# Independent Hail PLC Monitor

Reference monitor for the Hail portable-custody profile. The deployed public
alpha runs on a separate VPS with PostgreSQL, validates and retains complete
per-DID `plc.directory` audit logs,
records unexpected operations and lost coverage, and signs bounded coverage
attestations for a provider migration. Migration 3 adds reviewed bootstrap
checkpoint retention and durable polling readiness; see the candidate
[PLC read-evidence policy](https://github.com/j4crev/hailproto/blob/main/spec/plc-read-evidence.md).
It currently monitors the `hailproto.app` and `hailproto.dev` canaries every four
minutes. Signed alerts go to a Cloudflare Worker that pins the monitor key and
sends external email; the Worker returned `204` and delivered live enrollment
alerts. Hosting the monitor on infrastructure controlled by a Hail provider is
still a **bootstrap convenience**, not independent coverage under
`../hailproto/spec/account-onboarding.md`.

The deployed public profile is documented in
[`deploy/public`](deploy/public/README.md).

This project is intentionally a sibling of `hailproto`, `hail-server-ts`, and
the pinned official `did-method-plc` checkout. Historical POC DIDs remain only
in their private directory; the private URL is used in isolated tests and the
explicitly non-independent [same-VPS POC deployment](deploy/poc/README.md).

## Implemented Boundary

For each enrolled DID, the monitor retains the complete canonical audit across
restarts and rejects omitted, changed, reordered, or de-nullified history. It
replays the audit into the current state and CID. Every unexpected operation creates a
durable alert without silently changing the user's expected state. A poll
after more than 24 hours without coverage records a separate lost-coverage
alert, including enrollment that never completed its first healthy poll.
Failed or invalid polls clear readiness; one fresh successful poll is required.
Alerts are queued before a DNS-pinned, certificate-validating HTTPS
webhook attempt, and retry durably until a `2xx` response. The webhook
receives a domain-separated Ed25519 signature and the monitor public DID key.
No token is sent in a URL or ordinary log.

On a **user-run host**, the user reviews a complete PLC document-data JSON
snapshot and explicitly approves an observed new CID via the local
`monitor:approve` command. After the unexpected-operation alert has reached
the user's webhook and no coverage-gap alert exists, `monitor:attest` can sign
the current operation and coverage period. The signed CBOR payload verifies
with the provider-side `verifyMonitorAttestation` implementation, but the
provider never receives the monitor private key. A provider-operated bootstrap
instance does **not** satisfy independent-monitor requirements because its
operator can suppress coverage or alerts.

## Local Commands

Build the pinned sibling library and codec, then install dependencies:

```bash
bun run --cwd ../hailproto/packages/hail-codec-ts build
pnpm --dir ../did-method-plc build
bun install
```

Create a private monitor Ed25519 key file outside this repository. The
command creates a new mode-`0600` PKCS8 file without printing the private
bytes; record its printed public `did:key` for the provider's user-controlled
monitor evidence:

```bash
bun run monitor:keygen -- /secure/user-controlled/monitor-ed25519.pkcs8
```

Set `DATABASE_URL`, `PLC_DIRECTORY_URL`, `MONITOR_PRIVATE_KEY_FILE`, and
`MONITOR_ORIGIN` on the independent host. Never commit populated environment
files. Use a durable PostgreSQL database, not one of the provider databases.
After independently verifying a DID's current full state and expected CID:

```bash
bun run monitor:migrate
bun run monitor:enroll -- "$did" "$current_operation_cid" "$user_https_webhook" reviewed-plc-data.json
bun run monitor:run
```

The process polls each enrolled DID's canonical audit every four minutes and attempts
one due webhook notification every five seconds. For an isolated attempt use
`monitor:poll` or `monitor:notify`. For a user-reviewed update, supply the
*complete* reviewed PLC document-data JSON and the exact observed CID:

```bash
bun run monitor:approve -- "$did" "$new_operation_cid" reviewed-plc-data.json
bun run monitor:attest -- "$did" "$transfer_id" "$new_operation_cid"
```

For a newly registered DID whose reviewed bootstrap is still the current genesis,
deliver the enrollment notification and complete a
fresh healthy poll, then produce the separate onboarding artifact:

```bash
umask 077
bun run monitor:attest-onboarding -- "$did" "$genesis_cid" > onboarding-attestation.json
```

This attestation has no transfer ID or prior checkpoint. It binds the reviewed
genesis state digest under `hail.independent-plc-onboarding-monitor.v2\0`. It
refuses stale health, changed state, regressed history or any recorded coverage/
invalid-log gap.

The monitor refuses an attestation if notification has not completed, the
operation is not current/approved, the last healthy poll is stale, or it has
detected a coverage or export gap. It prints only the signed attestation and
the public monitor key, never provider or user identity private keys.

HTTPS-directory enrollment requires the reviewed state file before key/database/
network access. It is bounded at 1 MiB, uses strict JSON/PLC state validation and
must match the exact CID and complete validated state. The original bootstrap
CID/state/time is retained separately; later approval does not overwrite it.
The three-argument form remains private-HTTP-POC convenience, not reviewed public
bootstrap evidence. Existing enrollments are not retroactively relabeled.

Reviewed enrollment plus fresh per-DID polling produces **v3** coverage,
using `hail.independent-plc-monitor.v3\0`: the existing fields plus original
bootstrap CID and SHA-256/deterministic-CBOR full-state digest. Public cutover requires
reviewed coverage and a canonical pre-cutover checkpoint matching
the validated audit, and observation within five minutes. Legacy enrollments produce
the original v1 payload/context, which remains verifiable but is rejected by the
public gate. Legacy export sequence fields are not emitted by per-DID coverage.

### Migrations 3-5 and rollback

Stop the old monitor/attestation processes before upgrading; deploy one consistent
runtime before using v3 evidence. Mixed-version production attestation is not a
supported rollout. `monitor:migrate` preserves all existing cursors, enrollment,
observation, alert and approval rows and starts `caught_up=false`. It creates no
reviewed bootstrap records for old enrollments. Repeated migration is checksum
checked and does not reset a later successful catch-up.

With all processes stopped, `migrations/rollback/0003_backfill_readiness.sql`
permits a legacy rollback only when enrolled monitors are caught up, no later
migration exists and no reviewed checkpoint would be lost. It refuses incomplete
backfill and any sole reviewed-bootstrap record. Re-upgrade preserves legacy
rows but requires new catch-up; rollback is not production-readiness proof.
Preserve old enrollment history when planning any new reviewed ceremony rather
than deleting it to manufacture a v3 label.

Migration 4 expands the closed alert category set for the delivered onboarding
enrollment notification. Its guarded rollback refuses while any such notification
evidence exists or a later monitor migration is installed.

Migration 5 adds retained per-DID audits and poll timestamps without deleting the
legacy cursor. New observations no longer need a global sequence. Its rollback
refuses after any per-DID evidence has been recorded.

## Production Work Still Required

External dead-man supervision is still needed to alert while the monitor process
itself is offline. The public alpha is deployed on a separate VPS and its email
receiver is external, but same-hosting-provider failure and restore exercises
remain open; this is not complete production independence.
Review and operation approval are local commands rather than a
cross-device user interface. A service hosted by the Hail provider may help
users bootstrap but cannot satisfy the portable-custody rule that the monitor
be outside the provider's administrative control.

The remaining portable migration prerequisites are recorded in
`../hailproto/docs/production-portable-custody.md`. Test the monitor against a
fresh disposable PostgreSQL 14.4 database with:

```bash
DATABASE_URL=postgresql://monitor:password@127.0.0.1:5432/hail_monitor_test \
  bun --bun vitest run test/monitor.integration.test.ts
```
