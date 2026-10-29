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
restore the latest R2 dump into a new volume on its recorded PostgreSQL major,
reinstall the corresponding database overlay, then start services and verify the
managed canary. Do not change DNS until account, Grant, envelope and key counts
match the verified restore proof and all retained operational keys decrypt.

For suspected key disclosure, stop onboarding and outbound sends, preserve logs,
rotate the affected provider-controlled key through the existing PLC/custody
procedure, revoke host and R2 credentials, and notify affected owners. Never
delete evidence while responding to abuse.

## Access and key handling

The staged Tailscale/Cloudflare Tunnel migration and its console-only apply,
verification and rollback steps are in [VPS network hardening](vps-network-hardening.md).
The October 23 cutover is complete: SSH uses Tailscale; public Haili and monitor
HTTP use Cloudflare Tunnels; direct public TCP 22/80/443 was verified blocked on
both IPv4 and IPv6. Hosting firewalls deny new inbound traffic. Review the
hardening runbook's current checkpoint and release-adoption caveat before deploy.
The ingress release was committed/pushed and adopted on the provider with a clean
checkout. The monitor's separate [PostgreSQL update](monitor-postgres-update.md)
completed October 24: 14.24 is pinned in the active legacy override, data/volume
and application identity are retained, and encrypted off-host backups are verified.
The monitor subsequently completed 18.6 in a new volume with a higher-priority
database overlay; its post-cutover encrypted backup has passed an off-host restore.
Haili's separate 18.6 cutover is complete too: exact data/credentials and all 20
retained operational key pairs passed; its actual post-upgrade R2 backup was
downloaded, authenticated and restored off-host. Both app images stayed unchanged,
both original 14 volumes remain retained, and the POC VPS was untouched.

- SSH allows only the named `hailops` account with public-key authentication;
  root, passwords, keyboard-interactive authentication and X11 are disabled.
- Passwordless sudo for `hailops` is limited to the root-owned provider/monitor operations wrapper.
  Root recovery uses the VPS console, not remote root SSH.
- Provider secrets and R2 credentials are root-owned mode `0600`. Database
  operational private keys remain encrypted by `KEY_ENCRYPTION_KEY`.
- The backup host has only the OpenPGP public recipient. Keep the encrypted
  private recovery key, its passphrase and one current credential backup off the
  provider host and test them quarterly.

### SSH agent versus sudo

SSH key authentication and sudo authorization are separate. If an agent-run
command fails with `Permission denied (publickey)`, first check whether its
environment has the correct `SSH_AUTH_SOCK`. An existing agent may already hold
the authorized, unlocked key even when direct use of the private-key file fails.
Inspect existing agent socket addresses with `ss -xl` and verify the selected
agent with `SSH_AUTH_SOCK=<socket> ssh-add -l`; use that same socket for SSH.
Do not start a replacement agent, generate another key or disable host-key
checking merely because an automated session did not inherit the socket.

Granting `NOPASSWD:ALL` does not fix SSH authentication. Routine provider status,
deploy, restart and rollback use `sudo hail-provider-ops ...` under the restricted
rule. New privileged configuration changes need separately approved access.
The October 22 email rollout restored wrapper-only passwordless sudo and
verified that agent login and wrapper commands still work; unrestricted
noninteractive sudo is refused. SSH keys and `sshd` configuration were unchanged.

## Backup and restore

The nightly job creates a PostgreSQL custom-format dump plus the root-only
provider environment, encrypts the archive to fingerprint
`870DECF2F98318BCDE17D4B8333035D2650B0400`, uploads it to the private
`haili-production-backups` R2 bucket, downloads it again for a SHA-256 match, and
only then sends the backup heartbeat. Missing heartbeats alert after 26 hours.
No automatic deletion policy is enabled.

Quarterly, download a fresh object on a non-provider host, decrypt it, restore it
into a disposable instance of the recorded PostgreSQL major (both production
databases are now 18.6), compare schema and row counts, and
decrypt every retained account and prepared-transfer operational key. Record the object name, digest, counts and
result in `docs/haili-launch.md`; remove plaintext artifacts afterward.

PostgreSQL 14 reaches end of life November 12, 2026. Direct 14→18 encrypted-copy
rehearsals passed for both production databases; monitor-first console cutover
and write-safe rollback boundaries are in [PostgreSQL updates](monitor-postgres-update.md).
Both live cutovers and actual post-upgrade encrypted-backup restores passed.
The installed provider database
overlay at `/etc/hail-provider-postgres/compose.yaml` must accompany every Compose
operation, including application rollback. A major migration uses a new volume;
never attach 18 to a 14 directory or select an old volume after new writes.
Installed backup tooling includes the active DB image/version and database overlay
in its encrypted archive; restore on the recorded major, not a hardcoded 14 image.

## Monitoring and recovery thresholds

The Cloudflare Worker runs each minute. It alerts on state transitions and again
on recovery:

- `https://haili.app/health/ready` non-2xx or timeout after 10 seconds;
- no authenticated PLC-monitor heartbeat for 6 minutes;
- no verified encrypted provider backup for 26 hours.

Signed monitor alerts must be no more than seven days old and no more than five
minutes in the future. A Durable Object atomically claims each alert UUID,
retains completed IDs for 30 days and releases failed email claims for retry.
Treat Durable Object errors or repeated `503` delivery responses as alerting
failures; do not replace this claim with eventually consistent KV deduplication.

The monitor host sends a heartbeat only while its container health check passes.
Treat any alert as an incident. If no alert arrives during a quarterly simulated
failure, treat alerting itself as failed and use the Cloudflare Worker logs.

## Production limits

| Surface | Limit | Expected overload behavior |
| --- | --- | --- |
| Account API | 120 requests/minute/authenticated account or anonymous client | `429`, `Retry-After` |
| Envelope submission | 120 requests/minute/client; 16 KiB request | `429` or `413` |
| Grant publication | 120 requests/minute/client; 256 KiB request | `429` or `413` |
| Delivery status | 120 requests/minute/client; 16 KiB request | `429` or `413` |
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

Caddy is the trusted client-address boundary and must overwrite
`X-Hail-Trusted-Client-IP`; never forward a caller-supplied value. The provider
container must remain private to the Compose network. Transfer ingress also has
a separate, higher database-backed overload ceiling.

After an enrollment or migration incident, inspect passkeys, sessions,
invitations and prepared migration slots before cleanup. Unexpected passkeys and
orphan slots are not deleted automatically because bulk removal could destroy
legitimate recovery or standalone preparation state.

## Retained application images for rollback

The provider operations wrapper retains the running image under
`hail-server-ts:rollback-<full-image-digest>` **before** a replacement build takes
over `hail-server-ts:public`. Saving only the container's image ID is insufficient:
with the containerd image store, rebuilding the same public tag can make the
old ID unavailable without a prune operation. The October 29 CLI rollout exposed
this failure; rebuilding the previous commit restored service.

Deploy and rollback share an exclusive lock. A successful deploy atomically saves
three fields in `/var/lib/hail-provider-previous`: the previous commit, retained
image reference, and expected image ID. Both automatic failure recovery and
manual rollback verify the image identity before changing the checkout or public
tag, restore GUI and provider with builds/pulls disabled, and check readiness.
The PostgreSQL overlay and data volume remain in place; this is an application
rollback, not permission to undo incompatible database changes.

Existing two-field rollback records are rejected before any release change. They
must not be treated as proven recovery artifacts. A successful deployment using
the updated wrapper creates the new verified record. Retained tags are not
removed automatically; preserve the recorded recovery image during any separately
reviewed image cleanup.

The installed `/usr/local/sbin/hail-provider-ops` is root-owned and independent of
the repository checkout. Pushing or deploying source does **not** update that
installed file. Install the reviewed wrapper through the operator's authenticated
sudo session or VPS console, preserving its previous copy and checking the new
file's SHA-256. Wrapper-only passwordless sudo does not authorize self-updating
or arbitrary privileged installation. After installation, use its read-only
`status` command, then the next approved deployment to establish a retained
rollback image and record.

Regression checks: `bun run --cwd apps/server test -- test/provider-ops.test.ts`.
The tests cover retention before build, build/readiness failures, both-service
restoration, and refusal of missing, mismatched or legacy image records.
