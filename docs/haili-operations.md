# Haili production operations

## Application rollout entry point

Use the [routine production rollout](release-process.md#routine-production-rollout--operators-and-agents)
for provider/GUI releases. Build and publish in CI, then deploy the verified digest
through the installed wrapper. Never run Docker, Vite or adapter-node builds on
the live provider. A Git push alone does not deploy. Public registration is the
current intended policy; preserve it during application rollouts.


## Pre-launch development policy — developers and agents

**Build the intended system, not compatibility layers for our test data.** Hail
is pre-launch, with only a few test accounts and the founder's `j4@haili.app`.
Public hosting and the "public alpha" label below do not imply stable APIs,
protocol formats, database schemas, or backward-compatibility guarantees.

- Prefer a clean breaking change over legacy adapters, dual implementations,
  old-format readers, or reconciliation machinery whose only purpose is keeping
  these pre-launch records usable. Do not add permanent technical debt for them.
- Deleting/resetting obsolete application records and recreating test connections
  is an acceptable migration strategy. Identify the affected records and what is
  lost, keep related data consistent, and back up hosted data before cleanup.
  If the destructive scope is unclear, ask; this is not permission for an
  unspecified database wipe or deletion of keys or recovery material. External
  PLC identity history is not resettable application data.
- Keep security and correctness for the **current** design: signature checks,
  account isolation, disconnect/replay protection, and portable history created
  under the new design are still requirements. Reject or explicitly clean up
  unsupported old data rather than pretending it satisfies those requirements.
- Document breaking changes and the required cleanup/upgrade steps. Remove
  superseded compatibility code and tests rather than maintaining them forever.
- Revisit this policy explicitly before real external users or independent
  providers depend on a stable release; do not assume that commitment exists yet.

For the current portability work, this means **no legacy-proof reconciliation
subsystem solely to rescue existing test relationships**. Unsupported records can
be explicitly cleaned up and those relationships recreated under the new design.

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

Haili administration uses ordinary key-based SSH over Tailscale. Public provider
and monitor HTTP use host Cloudflare Tunnels with loopback-only origins. Keep
unsolicited public ingress blocked in host and hosting firewalls for IPv4/IPv6,
while preserving outbound, established and private administration traffic.
The [provider setup guide](../apps/server/deploy/public/README.md#4-configure-https-ingress)
describes header trust, cache and browser-check boundaries. Monitor enrollment is a
public HTTPS transport with restricted admission, not a private-only tailnet API.

Provider PostgreSQL configuration lives in `/etc/hail-provider-postgres/compose.yaml`;
monitor configuration includes `/etc/hail-monitor-enrollment/compose.postgres.yaml`.
These select the PostgreSQL 18 storage independently of application releases.
Preserve overlays on every Compose operation and restore. Retained older volumes
are not rollback targets after either application has accepted new writes.

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
Routine access must retain wrapper-only sudo and key-only SSH authentication.

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
decrypt every retained account and prepared-transfer operational key. Record the
object name, digest, counts and result in protected operator records
with the backup; remove plaintext artifacts afterward.

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

Recalibrate after host, database, runtime or traffic-shape changes. Stop and
investigate failed readiness checks. Raising mutation limits requires measuring
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

The split-image source wrapper takes a commit plus separate provider and web-client
image digests. It must be installed through existing reviewed privileged access
before deploying the split; changing its checkout does not update the root-owned
installed wrapper. The hosted installation has not been transitioned merely by
editing this repository.

The wrapper retains both running image IDs under local rollback tags before
replacement and records five fields: previous commit, provider reference/ID and
client reference/ID. It preserves the existing verified three-field combined-image
record for recovery before the first split rollout; unverified two-field records
remain refused. Both images are verified before rollback changes checkout or
containers. Keep the record, retained images, release selection and database
overlays. Application rollback is never database rollback.

Provider and client share a reviewed release commit but have distinct image IDs.
Backups record both references. Haili keeps its existing `deploy/public` directory,
Compose project, `gui` service name and data volumes to preserve operational
identity. The independent fresh-install profile is `deploy/standalone`; do not
substitute it on the existing host.

Follow the [updated rollout procedure](release-process.md#routine-production-rollout--operators-and-agents)
for exact wrapper installation, publication, deployment and recovery sequencing.
Regression checks: `bun run --cwd apps/server test -- test/provider-ops.test.ts`.
