# Public alpha monitor

The staged public enrollment Cloudflare Tunnel migration, console-only apply and
rollback are in [Monitor tunnel hardening](../../../../docs/monitor-tunnel-hardening.md).
This changes ingress only; independent-provider admission remains a separate task.

This profile runs the monitor worker and its private PostgreSQL database. It polls
each enrolled DID's canonical `https://plc.directory/<did>/log/audit` endpoint.

The alpha deployment runs this stack on a separate VPS from both providers and
uses an external signed-alert email receiver. A deployment beside a provider or
within the same failure domain remains bootstrap evidence, not independent
production monitoring.

The host heartbeat timer runs every three minutes and the external receiver
alerts after six minutes without a successful authenticated heartbeat. Install
`heartbeat.sh` as root-owned `/usr/local/sbin/hail-monitor-heartbeat`, install
the included service and timer in `/etc/systemd/system`, then daemon-reload and
enable the timer. The DID audit poll remains independent at four minutes.

## Prepare, but do not start yet

Keep sibling `hailproto`, `did-method-plc` and `hail-plc-monitor-ts` checkouts in
one workspace because the image build uses pinned local libraries.

```bash
cd hail-plc-monitor-ts/deploy/public
cp .env.example .env
chmod 600 .env
install -d -m 700 secrets
install -d -m 700 reviewed
docker compose --env-file .env build monitor
docker run --rm --network none --user root \
  --mount "type=bind,src=$(pwd)/secrets,dst=/keys" \
  hail-plc-monitor-ts:public bun src/cli/generate-key.ts /keys/monitor.pkcs8
chown -R 1000:1000 secrets
```

Store the printed public `did:key` and an encrypted copy of
`secrets/monitor.pkcs8` away from the VPS. Set `MONITOR_ORIGIN` to the reviewed
HTTPS operator identifier. The worker itself exposes no public port; enrolled
alert destinations are outbound HTTPS webhooks.

## Start and inspect

Start after DNS, the monitor key and alert webhook are ready:

```bash
docker compose --env-file .env up -d --wait
docker compose --env-file .env logs -f monitor
docker compose --env-file .env exec db \
  psql -U monitor -d monitor -c 'SELECT last_seq,caught_up,last_healthy_at FROM monitor_cursor'
```

No global PLC backfill is required. A fresh successful poll must validate every
enrolled DID before the monitor can attest.

## Enroll the canary

After the first `hailp account create` call returns the DID and genesis CID,
derive a public reviewed state file from the private signup state on the user
workstation:

```bash
jq '{did,rotationKeys:.operation.rotationKeys,verificationMethods:.operation.verificationMethods,
  alsoKnownAs:.operation.alsoKnownAs,services:.operation.services}' \
  /secure/hail-canary/signup.json > reviewed-plc-data.json
```

Copy only `reviewed-plc-data.json` to `deploy/public/reviewed/` on the monitor
host, then run:

```bash
docker compose --env-file .env exec monitor bun src/cli/enroll.ts \
  "$DID" "$GENESIS_CID" "$ALERT_WEBHOOK" /reviewed/reviewed-plc-data.json
```

After complete catch-up, healthy polling and delivery of the enrollment alert:

```bash
docker compose --env-file .env exec monitor bun src/cli/attest-onboarding.ts \
  "$DID" "$GENESIS_CID" > onboarding-attestation.json
```

Copy the attestation to the user workstation and resume the exact saved `hailp`
signup command. Do not copy the monitor private key, database password, user vault,
recovery secret or provider credential between trust domains.

## Automatic Reduced-Assurance Alpha Enrollment

The private API and Haili provider connection are deployed and verified as of
October 23, 2026 UTC. They remain **disabled by default** for other deployments;
public alpha account creation and the browser wizard are not enabled. The legacy
CLI ceremony above remains available. Automatic enrollment does not change
existing canaries or claim independent monitoring for a same-operator service.

The existing monitor process can optionally serve an authenticated private API.
Configure the monitor's protected environment with:

```dotenv
MONITOR_ENROLLMENT_TOKEN=<random canonical 32-byte base64url service secret>
MONITOR_ENROLLMENT_PROVIDER=https://haili.app
MONITOR_ENROLLMENT_ALERT_ORIGIN=https://alerts.plcmonitor.us
```

`MONITOR_ORIGIN` remains the monitor identity origin used in signed attestations.
`PLC_DIRECTORY_URL` must be exactly `https://plc.directory` when the API is enabled;
a private registry cannot be relabeled public. Without enrollment declarations,
the existing worker starts without an API listener.

The listener defaults to `127.0.0.1:3001`. `MONITOR_API_HOST` can select loopback
or `0.0.0.0` for a private container network; `MONITOR_API_PORT` can select a
nonprivileged port. The checked-in Compose file deliberately publishes **no new
ports**. Before deployment, review HTTPS termination, provider-only ingress and
any loopback container-port mapping. Never expose the plaintext listener or put
the service secret in browser code, URLs or logs.

On the provider, retain its existing signup-email configuration and add:

```dotenv
SIGNUP_MONITOR_API_ORIGIN=https://enroll.monitor.example.com
SIGNUP_MONITOR_TOKEN=<same secret as MONITOR_ENROLLMENT_TOKEN>
SIGNUP_MONITOR_PUBLIC_KEY=did:key:z...
```

The API origin is a pinned transport address and may differ from the monitor
identity origin. The public key must match the account's retained monitor key;
the attestation origin must match its retained monitor origin. These declarations
require signup email and strict public PLC authority; leaving all three empty
keeps the provider orchestration endpoint disabled.

### Ceremony

1. The owner verifies a recovery backup and signs the exact managed genesis.
   Existing provider onboarding registers and reads back that exact operation.
2. The browser verifies its external email through the provider email endpoints.
3. `POST /api/v1/signup-monitor` at the provider accepts only `signupId` and
   `accountId`, the existing signup bearer capability and the expected Origin.
   The provider looks up the owner-authorized genesis itself and binds the
   verified destination before contacting the monitor. It never accepts a
   browser-selected DID, CID, monitor key, webhook or PLC operation here.
4. The provider calls the private monitor's `POST /api/v1/onboarding` with its
   enrollment service secret and `{signupId, signupHash, operation}`. No vault,
   recovery secret, browser token or account API credential goes to the monitor.
5. The monitor validates the genesis, top-owner signature, four distinct roles
   and pinned provider endpoint. It independently checks the exact verified
   email binding at the pinned receiver using its existing monitor signing key
   and a purpose-separated, five-minute request. It does not receive the
   provider's email-service secret or rely on a submitted `emailVerified` flag.
6. The monitor validates the canonical DID audit and enrolls the complete reviewed
   state, pinning alerts to `/hail/signup`. Exact enrollment retries preserve
   the original checkpoint, coverage, alert ID and delivery state. Changed
   state/destinations or attempts to promote legacy unreviewed enrollment fail.
7. The normal worker polls every four minutes and retries queued notifications
   every five seconds. The consumer alert route refuses missing bindings and
   wrong enrollment CIDs; operator fallback and its deduplication receipts
   cannot satisfy consumer delivery.
8. Until a fresh healthy poll and accepted enrollment notification exist, the
   API returns `202` / `awaiting-monitor` with `Retry-After: 15`. No signature
   authorizes activation yet. Complete evidence returns `200` / `ready` and a
   fresh signed v2 onboarding attestation. Lost coverage, conflicting genesis,
   invalid history or missing verified email fails closed.
9. The provider verifies the returned signature, freshness, DID, CID, state
   digest, monitor key/origin and reduced-assurance label before returning it.
   The signup coordinator must durably retain the chosen activation artifact
   and reconcile ambiguous activation before requesting a replacement. Full
   resumable coordination and passkey-only signup are the next slice.

This API cannot approve unexpected updates, perform recovery, change custody,
export keys, replace an email destination or silently select independent mode.
New activation continues to use the existing public read-back and address checks.

### Proof And Rollback

The provider integration test exercises the full local flow against disposable
PostgreSQL schemas, a local PLC fixture and mocked email delivery. It covers
incorrect capabilities, unverified email, receiver failure, a committed-but-lost
monitor response, notification retries, stale polling, tampered signatures,
restart and coverage-gap refusal. No real email or public PLC write is performed.

There is no schema migration for this slice. To pause new enrollment, remove the
provider monitor declarations and monitor API declarations; preserve the existing
monitor key, database, polling, notifier and bound consumer webhook routes. Do
not downgrade a consumer webhook to `/hail` or remove the receiver's consumer
route while enrolled identities depend on it. Never reset a cursor or generate
a replacement DID to recover from an ambiguous API response.

## One-Time Legacy Host Bridge (Console Approval Required)

Before the rollout, `2.25.206.150` built from the separate repository at
`/opt/hail/hail-plc-monitor-ts`. The bridge is now active: monorepo code builds at
`/opt/hailproto`, with the legacy private configuration/storage paths retained.
Do not give an unconverted old deployment wrapper a monorepo commit: it fetches
from a different Git origin. Root SSH remains disabled;
`hailops` authenticates with the existing SSH agent and retains wrapper-only sudo.

The reviewed `enrollment-setup.py` bridges **code builds**, not data storage:

- Keep both old checkouts and the old Compose base unchanged. The PostgreSQL
  image (currently `postgres:14.4-alpine`), project/volume names, key mounts,
  monitor identity origin and heartbeat stay on their existing paths.
- Put the new protected monorepo at `/opt/hailproto`. A root-owned override in
  `/etc/hail-monitor-enrollment` changes only the monitor build, API settings,
  loopback port binding and an added Caddy edge. It does not recreate PostgreSQL.
- Build and test key readability before stopping the old monitor. Verify applied
  migration checksums and the reviewed running monitor public key; this fixed
  host bridge refuses unexpected key/schema transitions before stopping it.
- Pause only the monitor for a consistent encrypted backup and immutable-history
  snapshot, then switch runtime. Verify retained rows, accepted alert receipts,
  current polling, API authentication and the pinned signed mail-peer request.
  New observations/delivery progress are allowed, loss of old evidence is not.
- Use only the public backup recipient matching
  `870DECF2F98318BCDE17D4B8333035D2650B0400`. Private backup-decryption keys are
  refused. Temporary plaintext dumps are removed; encrypted archives are
  root-owned/group-readable by `hailops` under `/var/lib/hail-monitor-enrollment`
  so they can be downloaded and checksum-verified off-host.
- Add a loopback-only HTTP origin with `caddy:2.10.2-alpine` for a host-local
  Cloudflare Tunnel connector, with administration disabled and capabilities
  dropped except the official binary's required `NET_BIND_SERVICE`. Only this
  origin trusts `CF-Connecting-IP`, permitting the configured
  Haili provider's public IPv4/IPv6 to POST the enrollment path. All other traffic
  gets `403`. Backend port `3001` is published only on loopback. Public HTTPS is
  terminated at Cloudflare, not directly on the VPS. No sudoers changes are made.

This is a one-time console-approved operation, not an unrestricted sudo grant.
The scripts have configuration/rendering/preservation regression checks and the
actual legacy Compose merge has been validated locally. The operator applied
this bridge successfully on the production monitor. The protected API is healthy,
external TLS and source-IP restrictions are verified, and its encrypted backup
has been downloaded and checksum-verified off-host. On another installation,
all root preflights and backups must still pass.

### Operator Actions

1. Prepare a Cloudflare Tunnel for `enroll.plcmonitor.us`. The edge listens only
   on `127.0.0.1:8080`; direct DNS-only A/AAAA records, ACME and public 80/443 are
   no longer required. After the local edge is ready, install the protected
   connector and publish the proxied tunnel CNAME using the pattern documented in
   [Monitor tunnel hardening](../../../../docs/monitor-tunnel-hardening.md).
   Do not re-run this one-time bridge on an already-converted host or open 3001.
2. Have the agent stage a private `monitor.json` containing exactly `api_domain`
   and a newly generated `enrollment_token`, plus the reviewed **public** backup
   key, in a mode-0700 `hailops` directory. The JSON must be mode 0600. Do not
   paste the token into chat, shell arguments or the repository.
3. Deploy the compatible email Worker first; its signed binding-read endpoint
   must exist before the monitor's mail-peer verification can pass.
4. In the monitor VPS console, as root, clone the monorepo into the new location
   and pin the reviewed full release SHA. If the target already exists, stop
   and inspect it rather than resetting or overwriting it:

   ```bash
   set -eu
   umask 022
   git clone --no-checkout https://github.com/j4crev/hailproto.git /opt/hailproto
   git -C /opt/hailproto fetch origin <reviewed-full-release-SHA>
   git -C /opt/hailproto checkout --detach <reviewed-full-release-SHA>
   git -C /opt/hailproto submodule update --init --recursive
   python3 /opt/hailproto/apps/plc-monitor/deploy/public/enrollment-setup.py \
     --apply /home/hailops/<private-staging-directory>/monitor.json \
     --backup-key /home/hailops/<private-staging-directory>/backup-public.asc \
     --commit <reviewed-full-release-SHA>
   ```

   Use the console, not root SSH. The helper checks source ownership and
   cleanliness, port availability, backup recipient, schema/key paths and old
   runtime health before switching. It never edits the old `.env`. A second
   encrypted backup includes the new protected enrollment configuration.
5. The helper installs the updated root-owned `hail-monitor-ops` only after
   verification. Its `status` reports only public enrollment metadata; `backup`,
   guarded `deploy` and `rollback` remain available through the existing sudo
   rule. Download the encrypted archives via `hailops` and verify their hashes.
6. From the provider, verify trusted HTTPS to the new API: an unauthenticated
   empty POST must return `401`, and an authenticated empty POST `400`, without
   creating an identity. From outside the provider IP, expect `403`. Only then
   install the matching provider settings using its narrow configuration command.
   TLS issuance and external reachability are not proven by local container health.

The first migration's `rollback` restores the legacy image and original wrapper
while keeping the current database and signing key. Later code releases have a
separate previous-release record. Rollback never restores an older database dump
over newly observed history and never removes data/certificate volumes. On a
setup failure, the old runtime is restarted and newly written configuration is
retained for review; reapplying refuses to overwrite that directory. If the
console/process is killed mid-switch, use `sudo hail-monitor-ops status/restart`
and inspect the retained backup/configuration before continuing. Do not delete
the legacy checkout or rewrite consumer webhooks as cleanup.
