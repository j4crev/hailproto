# Haili production operations

## Ownership and response

| Role | Public contact | Owner | Acknowledge | Act |
| --- | --- | --- | --- | --- |
| Availability, keys and recovery | `ops@haili.app` | Jason / primary operator | 30 minutes | 2 hours |
| Abuse and legal reports | `abuse@haili.app` | Jason / primary operator | 1 business day | Immediately for credible active harm |

Both role addresses route through Cloudflare Email Routing to the verified
operator mailbox. The catch-all is disabled. Until a second operator is named,
there is no 24×7 human coverage; automated checks provide detection only.

Follow-up, not a launch blocker:

- [ ] Name a backup incident/abuse operator, grant only the access needed for the
  role, and complete one alert acknowledgement and recovery handoff drill.

For a provider outage, inspect `sudo hail-provider-ops status` and `logs`, then
use `restart`. If a release caused the outage, use `rollback`. If the host is
lost, provision Ubuntu with Docker, copy the repository and root-only `.env`,
restore the latest R2 dump, then start the public Compose profile and verify the
managed canary. Do not change DNS until account, Grant, envelope and key counts
match the backup manifest and all retained account keys decrypt.

For suspected key disclosure, stop onboarding and outbound sends, preserve logs,
rotate the affected provider-controlled key through the existing PLC/custody
procedure, revoke host and R2 credentials, and notify affected owners. Never
delete evidence while responding to abuse.

## Access and key handling

- SSH allows only the named `hailops` account with public-key authentication;
  root, passwords, keyboard-interactive authentication and X11 are disabled.
- `hailops` may invoke only the root-owned provider/monitor operations wrapper.
  Root recovery uses the VPS console, not remote root SSH.
- Provider secrets and R2 credentials are root-owned mode `0600`. Database
  operational private keys remain encrypted by `KEY_ENCRYPTION_KEY`.
- The backup host has only the OpenPGP public recipient. Keep the encrypted
  private recovery key, its passphrase and one current credential backup off the
  provider host and test them quarterly.

## Backup and restore

The nightly job creates a PostgreSQL custom-format dump plus the root-only
provider environment, encrypts the archive to fingerprint
`870DECF2F98318BCDE17D4B8333035D2650B0400`, uploads it to the private
`haili-production-backups` R2 bucket, downloads it again for a SHA-256 match, and
only then sends the backup heartbeat. Missing heartbeats alert after 26 hours.
No automatic deletion policy is enabled.

Quarterly, download a fresh object on a non-provider host, decrypt it, restore it
into a disposable PostgreSQL 14 instance, compare schema and row counts, and
decrypt every `account_keys` row. Record the object name, digest, counts and
result in `docs/haili-launch.md`; remove plaintext artifacts afterward.

## Monitoring and recovery thresholds

The Cloudflare Worker runs each minute. It alerts on state transitions and again
on recovery:

- `https://haili.app/health/ready` non-2xx or timeout after 10 seconds;
- no authenticated PLC-monitor heartbeat for 5 minutes;
- no verified encrypted provider backup for 26 hours.

The monitor host sends a heartbeat only while its container health check passes.
Treat any alert as an incident. If no alert arrives during a quarterly simulated
failure, treat alerting itself as failed and use the Cloudflare Worker logs.

## Production limits

| Surface | Limit | Expected overload behavior |
| --- | --- | --- |
| Account API | 120 requests/minute/provider process | `429`, `Retry-After: 60` |
| Envelope submission | 120 requests/minute/provider process; 16 KiB request | `429` or `413` |
| Grant publication | 120 requests/minute/provider process; 256 KiB request | `429` or `413` |
| Delivery status | 120 requests/minute/provider process; 16 KiB request | `429` or `413` |
| Body storage/retrieval | 256 KiB body | `413` at bounded request surfaces |
| Sender Profile retrieval | 64 KiB response | Verification failure |

October 21, 2026 calibration against the database-backed public readiness route
on the 2-vCPU, 1.9-GiB host produced 20.9 requests/s at one connection, 86.6 at
four, and 339.0 at sixteen. At sixteen connections p50 was 45.7 ms, p99 125.1 ms,
maximum 281.6 ms, with no HTTP or transport errors. The public mutation limits
are therefore policy limits, not observed capacity limits. Recalibrate after a
host, database, runtime or traffic-shape change. Stop and investigate if the
external readiness check fails; do not raise mutation limits without measuring
the protected 500-ms response schedule and database contention separately.
