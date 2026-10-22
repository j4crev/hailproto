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

The initial canary enrollment temporarily mounts a mode-0600 credential at
`/home/hailops/.hail/canary-api-credential.json`. Remove the mount, environment
declaration, and host file immediately after a passkey has been enrolled and
tested. Never enable `HAIL_GUI_CREDENTIAL_FALLBACK` in production.

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
