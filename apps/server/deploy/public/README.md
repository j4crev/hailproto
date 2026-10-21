# Single public provider

This profile prepares one strict-public provider, PostgreSQL database and Caddy
edge. It defaults to `haili.app`, canonical `plc.directory` audit reads and no
public onboarding, custody transitions or managed transfer.

It does not close the operational gates in
[`docs/haili-launch.md`](../../../../docs/haili-launch.md): protect and back up
the provider key, prove cross-host restoration, add external monitor dead-man
supervision, calibrate supported limits and assign incident ownership before
calling the provider permanent.

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
monitor, backup and abuse controls are ready. `PUBLIC_MANAGED_TRANSFER` is fixed
off by this profile.

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
