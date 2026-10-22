# Single public provider

This profile prepares one strict-public provider, PostgreSQL database and Caddy
edge. It defaults to `haili.app`, canonical `plc.directory` audit reads and no
public onboarding, custody transitions or managed transfer.

Production operation, backup, monitoring, limits and incident response are in
[`docs/haili-operations.md`](../../../../docs/haili-operations.md).

## Prepare

Point the provider domain's DNS-only `A`/`AAAA` records at the host. Then create
the private environment file:

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

Initial canary enrollment may temporarily mount a mode-0600 credential. The
deployed profile must not retain that mount or enable
`HAIL_GUI_CREDENTIAL_FALLBACK` after a passkey has been tested.

## Validate and start

```bash
docker compose --env-file .env config --quiet
docker compose --env-file .env build provider
docker compose --env-file .env up -d db provider
docker compose --env-file .env ps
docker compose --env-file .env up -d caddy
```

The provider applies compatible database migrations before serving. Verify from
another network:

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
passkey login. **It has not been deployed or enabled. The browser wizard is not
implemented yet; do not invite ordinary users to this backend alone.** Existing
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
means disabling new signup access, not deleting retained records. Full browser
state export/import, wider platform tests and the production monitor API rollout
remain outstanding.
