# Single public provider

This profile prepares one strict-public provider, PostgreSQL database and Caddy
edge. It defaults to `haili.app` and canonical `plc.directory` audit reads.
The operator-approved Haili profile enables same-provider custody transitions;
public onboarding and managed transfer retain their separate switches.

Production operation, backup, monitoring, limits and incident response are in
[`docs/haili-operations.md`](../../../../docs/haili-operations.md).
The staged private-origin Cloudflare Tunnel migration, console apply and rollback
are in [`docs/vps-network-hardening.md`](../../../../docs/vps-network-hardening.md).
The edge publishes only loopback `127.0.0.1:8080` for a host-local cloudflared
service; no direct public HTTP/HTTPS bindings are needed.

## Prepare

Create a Cloudflare Tunnel and its proxied hostname CNAME, routing HTTP to
`127.0.0.1:8080` with the provider domain as HTTP Host Header. Configure the
connector, HTTPS enforcement, API browser-check exceptions and cache bypass as
documented in the hardening runbook. Do not retain direct-origin A/AAAA records.
Then create the private environment file:

```bash
cd apps/server/deploy/public
cp .env.example .env
chmod 600 .env
openssl rand -base64 32 | tr '+/' '-_' | tr -d '='
```

Use an OS/server hostname distinct from the public provider domain. Some VPS
images, including cloud-init configurations used by Hetzner, map a server name
such as `haili.app` to `127.0.1.1` in `/etc/hosts`. Containers can inherit that
answer, causing the required public activation self-check to connect to
loopback. Before starting, confirm `getent ahosts haili.app` returns only the
public addresses. If it returns loopback, remove the alias from both
`/etc/hosts` and its cloud-init template/configuration so it does not return on
reboot.

Run the command separately for `DB_PASSWORD` and `KEY_ENCRYPTION_KEY`; never
reuse them. Keep `PUBLIC_SELF_SERVICE_ONBOARDING=false` until the reviewed
monitor, backup and abuse controls are ready. Provider transfer defaults off;
enable it with `PUBLIC_MANAGED_TRANSFER=true` plus the pinned
`PLC_MANAGED_MONITOR_ORIGIN` and `PLC_MANAGED_MONITOR_PUBLIC_KEY`. Public
onboarding may remain enabled at the same time.

Passkey authentication defaults on for this profile, with the exact HTTPS
provider origin and provider domain as its RP ID. Set `PASSKEY_AUTH=false` only
for rollback; changing the RP ID invalidates existing provider-local passkeys.
The provider keeps `/api`, `/hail`, `/.well-known`, and `/health` locally owned
and proxies only GUI paths to the internal thin-client sidecar.

### Connections and custody

This Haili deployment profile enables `CONNECTION_PREVIEW` following operator approval.
Set `CONNECTION_PREVIEW=false` to opt out; the application itself still defaults off.
Connections offers separate personal and expiring connection QR/link controls.
Migration 75 and the compatible custody writer allow settled connections to survive
both same-provider custody directions. Successful custody cutover retires existing
codes while retaining established connections, signed consent and disconnect history.
Pending connection work must finish before preparation. Obsolete native connection
records remain unsupported. Disabling the preview does not remove retained consent.
Owner-controlled signing and cross-provider admission/reconciliation/disconnect are
implemented; the other provider must support the same handshake. The one-second
durable worker retries unfinished work after restarts. Connections shows synchronization
and recent failures. Connection messaging and portable history export are implemented;
explicit blocking remains separate. Provider transfers require their own enabled
runtime and authenticated handover. See [connection consent](../../../../spec/connection-auth.md) and
[federation v1](../../../../spec/connection-federation.md) for wire and rollback rules.

`PUBLIC_CUSTODY_TRANSITIONS` is explicitly enabled in this Haili Compose profile.
The application still defaults off and refuses public enablement without production
strict-public PLC authority. Owner recovery approval remains mandatory; enabling
the routes does not switch any account's keys. Use the existing CLI custody commands.
See [custody transitions](../../../cli/docs/custody-transitions.md#same-provider-custody-transition)
for the code-retirement policy and migration rollback requirements. To disable new
custody requests, deploy this profile with `PUBLIC_CUSTODY_TRANSITIONS: "false"`;
retain schema 75 and compatible code until pending transitions are resolved.

Initial canary enrollment may temporarily mount a mode-0600 credential. The
deployed profile must not retain that mount or enable
`HAIL_GUI_CREDENTIAL_FALLBACK` after a passkey has been tested.

## Validate and start

These are bootstrap commands, **not commands for the migrated production host**.
On production use `sudo hail-provider-ops ...`. The installed
`/etc/hail-provider-postgres/compose.yaml` must be included with `-f` after the
base Compose file for every direct Compose operation, including rollback; omitting
it can select the retained PostgreSQL 14 volume and discard access to newer writes.
See [PostgreSQL updates](../../../../docs/monitor-postgres-update.md).

```bash
docker compose --env-file .env config --quiet
docker compose --env-file .env build provider
docker compose --env-file .env up -d db provider
docker compose --env-file .env ps
docker compose --env-file .env up -d caddy
```

The provider applies compatible database migrations before serving.

Migration 60 reserves `ops`, `alerts`, `abuse`, `security`, `support` and `admin`
automatically; no accounts or credentials are generated. Before enabling signup,
review any migration warning about an existing account occupying a role name.
See [reserved provider addresses](../../README.md#reserved-provider-addresses)
to authorize an intended owner's public recovery key and complete normal onboarding.

Verify from another network:

```bash
domain=$(sed -n 's/^PROVIDER_DOMAIN=//p' .env)
curl --fail --silent --show-error "https://${domain}/health/ready"
```

Enabling owner-controlled public onboarding is a separate launch-checklist item;
it requires the external reviewed-monitor ceremony documented in the
[provider guide](../../README.md#hailp-account-api).

## Invited Browser-Signup Backend (Local Implementation)

The resumable backend has local integration proof through owner-signed genesis,
verified email, monitored activation, real WebAuthn registration and fresh
passkey login. **The code is staged on the provider, but account creation remains
disabled by default. The browser wizard has local Chromium proof, but the invited
live ceremony is still required before widening access.** Existing
CLI onboarding is unchanged.

Enabling it requires production HTTPS/passkeys on the provider origin, strict
public PLC authority, the configured signup email/monitor services, and:

```dotenv
PUBLIC_ALPHA_SIGNUP=true
ALPHA_SIGNUP_MONITOR_ORIGIN=https://monitor.example.com
ALPHA_SIGNUP_INVITE_KEY=<random canonical 32-byte base64url operator signing key>
```

The identity origin must match the configured monitor's attestations, not
necessarily its API hostname. Private-POC gates are incompatible. Declarations
without the explicit enablement flag are refused. Defaults leave the surface off.
The invitation key must be independent of the email/monitor service secrets and
the provider key-encryption key; known role reuse is refused.

### Admission And API

The operator can create a seven-day, provider-bound, single-use invitation with
the signing key and `PUBLIC_ORIGIN` in a protected environment:

```bash
bun src/cli/create-signup-invitation.ts /secure/private-invites/alice.json
```

The parent directory must be private. The output is created exclusively with
mode `0600`; stdout contains only its path/provider metadata. Do not put the key
or invitation bearer in logs, command arguments or the repository. Key rotation
does not invalidate already admitted setup attempts; their own fixed expiry
still applies. Invitations admit signup, never login, recovery or account access.

The client creates two independent random `hailp_...` secrets: a resumable setup
capability and a single-purpose passkey enrollment token. It retains these in its
protected pending-signup state; neither is an account API credential. No owner
private key, recovery secret or vault is sent to this API.

| Operation | Request | Behavior |
| --- | --- | --- |
| `POST /api/v1/signup/check-address` | Random setup-form bearer; address and valid invitation | Read-only availability check, no invitation consumption or reservation; the actual reservation remains authoritative |
| `POST /api/v1/signup` | Setup bearer; `signupId`, address, recovery/identity public `did:key` values, enrollment-token SHA-256 `enrollmentHash`, invitation, and explicit `backupVerified`, `managedAccepted`, `alphaMonitoringAccepted` true flags | Atomically admits immutable intent before allocating resources; returns public preparation and fixed setup expiry |
| `GET /api/v1/signup/:id` | Original setup bearer | Read-only progress, provider keys and identity metadata; a same-origin browser GET need not supply Origin |
| `POST /api/v1/signup/:id/advance` | Original setup bearer; original `enrollmentToken`, optional first owner-signed `operation` | Retains and resumes the exact genesis, email binding, monitoring and activation; returns progress or the bounded enrollment URL |
| `POST /api/v1/signup/:id/complete` | Current HttpOnly passkey session cookie, after a fresh login | Retires setup authority and its enrollment capability without revoking the tested session |

All POST operations require the expected Origin; responses are `no-store` and
bounded/rate-limited. Initial intent cannot change address, keys, invitation or
token hashes on retry. Admission consumes the invitation once even if the first
response is lost. A repeated admission resumes the same account rather than
allocating a new identity. Public signing-role and owner-signature checks happen
before the signed operation becomes immutable.

### Interruption And Authority Boundaries

- Setup authority has a fixed approximately 24-hour lifetime; retries do not
  renew it. It is bound to the original serving generation from preparation,
  not merely from passkey issuance; advancing that generation retires setup.
  The first WebAuthn enrollment capability has a fixed ten-minute
  lifetime. Expired/consumed authority is never recreated from retained state.
- Pending stages return `awaiting-monitor` or a retryable busy result. The existing
  email endpoints verify the destination using the same signup ID/capability.
- Exact operations and the selected monitor proof are durably retained before
  activation. After a lost activation response, the backend reconciles account
  state instead of requesting a different proof or publishing another genesis.
- A connection-held global signup lock deliberately serializes alpha advancement.
  This has a throughput ceiling; replace it with bounded, fenced per-account
  workers if pilot concurrency warrants it. An activation epoch is rechecked in
  the activation commit, so an abandoned controller cannot commit after another
  attempt supersedes it. No recovery/identity signer is unlocked by the backend.
- Once any passkey exists, setup does not return another enrollment URL. After
  fresh passkey login, completion checks the current account, credential, session,
  serving generation and migration fence. API credentials cannot substitute for
  this login. Setup hashes remain as terminal replay evidence, while the provider
  preparation's bootstrap hash is cleared and the enrollment bearer expires.
- Completion is idempotent under the user's session, including after setup expiry.
  The setup bearer itself cannot read or mutate the completed ceremony, issue
  account credentials or grant credential-management scope.
- If enrollment/setup expires before completion, retain the recovery kit and
  original signup state. Active-account access can use the existing owner-proof
  ceremony; an unregistered/inactive attempt needs provider review. Browser-based
  post-signup recovery import is still a separate approval gate. Do not silently
  create another DID or change custody to get past expiry.

Migration 58 adds the retained ceremony/tombstone records without changing old
accounts. Rollback is allowed only before any ceremony exists; it refuses to
erase either pending identity evidence or retired authority. Pausing the rollout
means disabling new signup access, not deleting retained records. The production
monitor connection and local browser state export/import proof are complete.
The invited live ceremony and wider platform/recovery tests remain outstanding.

## Registration mode

Migration 0078 creates a persisted server-wide registration mode, defaulting to
`invite`. Operators can select **Invite** or **Public** in `/admin`; changes
require a passkey authentication within ten minutes and are recorded in
`provider_registration_audit`. Both browser signup and the CLI onboarding API
use the same admission ledger. Invitations are single-use across both APIs.
Public mode removes only the invitation requirement; recovery, monitoring,
reserved names, and the provider-domain restriction still apply. Custom hosted
domains are not supported.

The mode is independent of endpoint enablement: `PUBLIC_ALPHA_SIGNUP` enables
the browser signup service, and `PUBLIC_SELF_SERVICE_ONBOARDING` enables the CLI
onboarding service. Enabling the latter does not bypass the registration mode.
Apply migrations before starting the updated server. Existing browser ceremonies
and their consumed invitations are retained. Newly admitted setups can resume
for 24 hours even after switching from `public` to `invite`; new uninvited
admissions are rejected immediately. Rollback refuses to discard admission or
settings audit evidence.

## Invited Browser Pilot

The built `/signup` page reuses the existing browser recovery and WebAuthn code.
Compose maps `PUBLIC_ALPHA_SIGNUP` to private GUI flag `HAIL_GUI_SIGNUP` (the
`PUBLIC_` prefix is reserved for SvelteKit public environment exports). The GUI
receives only provider/monitor public pins, never the invitation signing key or
provider-to-monitor/mail service secrets. Default deployments return 404.

Pending setup is encrypted with the separate random recovery secret using
AES-GCM with fresh nonces and distinct associated data. Only ciphertext is placed
in browser storage and downloadable setup files. The vault remains v1-compatible;
the raw secret and unlocked keys are not included in pending artifacts or API
requests. The page holds an in-memory nonextractable encryption key only while
setup is open and clears sensitive page references on pagehide/unmount. This
does not promise secure erasure or protect against compromised same-origin code.
No third-party scripts/analytics are added; same-origin CSP, no-referrer and
no-store cover the wizard. Unfinished setup import is not post-signup recovery.

Before admission the user must verify a saved recovery file and separately
retained secret and save an encrypted setup file. After signing, the updated
setup file must be saved before publication. Reloads/eviction reopen the original
state; no automatic replacement keys or DID are generated. An earlier setup file
can reconcile an already retained operation through backend status. If both
encrypted pending state and its exported file are lost after submission, the
wizard cannot recreate setup capabilities from the recovery vault: retain the
vault and use provider assistance/existing owner-proof tooling. Expired setup or
enrollment shows an explicit terminal explanation rather than renewed authority.

Activation leads to passkey creation, a final DID-bound recovery-backup download,
and a fresh sign-in before completion. Completion removes the browser ciphertext;
the user must delete obsolete pending downloads. No full-access API credential
is created. Keep the final recovery vault and its separate secret.

### One Operator-Invited Live Ceremony

Deploy the tested release **with gates off first**. Then, in the provider VPS
console as root, run the reviewed one-time helper:

```bash
python3 /opt/hailproto/apps/server/deploy/public/enable-signup-pilot.py
```

This validates the candidate against the running provider, takes the normal
encrypted backup, retains a private pre-change environment, and atomically sets
only the three alpha gate/signing-key/monitor-identity fields. It refuses existing
pilot configuration rather than rotating a key. It mints one seven-day single-use
invitation and displays its browser URL **only to the intended operator in the
console**. Treat that URL as private; do not put it in repository/central logs.
No account, DID or owner recovery material is created by the helper. It does not
modify SSH, sudoers, database images or old accounts. No new privileged wrapper
command is installed; this enablement deliberately needs the approved console.

Have the agent recreate through the existing guarded deployment wrapper and
verify both GUI/API gates, HTTPS and email/monitor availability. Only then open
the invitation link on the test browser. The operator selects an unused address
and their external alert email and handles all recovery secrets/passkey prompts.
Confirm verification mail and the monitor enrollment alert actually arrive.
If it waits or fails, preserve original encrypted setup state and report the
step/message, never recovery material or setup-token contents. The user should
finish by entering the inbox, checking security settings and exchanging a message
with an existing test account through explicit permissions.

After successful completion, pause the pilot by console-setting
`PUBLIC_ALPHA_SIGNUP=false` and removing its two `ALPHA_SIGNUP_*` declarations,
then recreate through the guarded wrapper. Existing passkey login remains on.
Do not pause midway through a pending ceremony without an explicit recovery plan:
this initial gate controls both admission and its continuation routes. Do not
rollback migration 58 after pending/terminal ceremonies exist; code rollback
must retain their records and use a compatible backend. The retained before.env
is a rollback reference, not permission to overwrite unrelated later changes.

Local checks: `bun run --cwd apps/client build`, `test`, `typecheck`,
`test:browser`, and `test:wizard`; repeat the latter with
`HAIL_WIZARD_MOBILE=true` for a narrow mobile viewport. This is Chromium emulation,
not proof of Safari/iOS/Android passkey behavior or real email deliverability.

## Narrow Monitor Configuration Operation

After the monitor bridge is ready, the provider needs three matching settings.
Do not enable root SSH or restore `NOPASSWD:ALL` to add them.

The agent can stage the reviewed source with the existing guarded deploy wrapper,
leaving signup/monitor gates off. In the provider console, as root, install that
checkout's updated wrapper once:

```bash
install -o root -g root -m 0755 \
  /opt/hailproto/apps/server/deploy/public/provider-ops.sh \
  /usr/local/sbin/hail-provider-ops
```

Then the normal `hailops` account can run:

```bash
sudo hail-provider-ops signup-monitor-configure < /home/hailops/<private-monitor-settings.json>
```

The private JSON contains exactly `SIGNUP_MONITOR_API_ORIGIN`,
`SIGNUP_MONITOR_TOKEN` and `SIGNUP_MONITOR_PUBLIC_KEY`. The initial host-specific
operation accepts only HTTPS origins under `plcmonitor.us`. It validates the
complete candidate with the running reference provider, backs up before writing,
preserves unrelated environment lines, writes atomically with mode 0600 and
refuses to overwrite a different existing configuration. It does **not** enable
public alpha signup or change any account keys, SSH settings or sudoers rules.
The token goes through stdin; neither stdout nor errors expose it.

Recreate through the guarded deployment operation afterward; a plain Docker
restart does not load changed container environment. Remove temporary staging
files only after both services have been verified. Explicit token rotation and
non-`plcmonitor.us` deployments require a separate configuration review rather
than broadening this helper's privileges silently.
