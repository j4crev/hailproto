# Run your own Hail provider

The provider is a standalone HTTP service. It does not contain or require the
reference web client. Native apps and alternative clients use its account API;
peer providers use its federation endpoints. The optional reference web client
is published as a separate image. Keep the same reviewed revision for both until
an explicit cross-version compatibility policy is established.

Hail is pre-launch. This guide is for a **fresh installation**, not a PostgreSQL
upgrade or a replacement for an existing deployment's volumes and configuration.

## 1. Configure the server

Use a Linux host with Docker Compose, a public domain, and inbound TCP 80/443
(UDP 443 is optional for HTTP/3). Point the domain's A/AAAA records at this host.
The supplied Caddy terminates HTTPS and obtains certificates automatically.
The database and provider have no host-published ports.

From a reviewed repository checkout:

```bash
cd apps/server/deploy/standalone
umask 077
cp .env.example .env
chmod 600 .env
```

Edit `.env`: select your domain, provider/operator identifiers, a verified
`HAIL_PROVIDER_IMAGE=image@sha256:...` from the publication artifact, and two
independent secrets for `DB_PASSWORD` and `KEY_ENCRYPTION_KEY`. Generate each with:

```bash
openssl rand -base64 32 | tr '+/' '-_' | tr -d '='
```

Use the generated base64url password as-is (the database connection embeds it in
a URL). Keep the encryption key with encrypted backups; losing it loses access to
provider-held operational keys. No Haili private endpoint or token is required.

### DNS discovery for your provider

Publish one TXT record, substituting your actual lowercase domain:

```dns
_hail-provider.provider.example.com. TXT "v=hail1; provider=provider.example.com"
```

Custom address domains point their `_hail-provider` record at this provider too;
registration also requires the issued `_hail-domain-verify` challenge. These
records do not configure SMTP email. Allow outbound DNS and HTTPS for discovery,
PLC reads and federation. Public identities use the canonical `plc.directory`;
that is a protocol dependency, not a Haili deployment address.

## 2. Start without a web client

```bash
docker compose --env-file .env -f compose.yaml config --quiet
docker compose --env-file .env -f compose.yaml pull
docker compose --env-file .env -f compose.yaml up -d --wait
```

Check `https://YOUR_DOMAIN/health/ready` from another network. `/` returns 404
until you attach a web client; that is expected for a server-only deployment.
Migrations run at startup. PostgreSQL 18 uses the persistent `provider_db` volume.
Do not remove that volume to upgrade an application.

Caddy overwrites `X-Hail-Trusted-Client-IP` with the direct peer address. This
profile assumes direct public ingress. Do not put it behind another proxy without
reviewing forwarded-address trust. A Cloudflare Tunnel example is maintained in
[Haili's site-specific profile](../public/README.md); its listener trusts only the
host tunnel and is not suitable for direct exposure.

## 3. Account bootstrap and client APIs

Server-only does not mean dependency-free signup. Current invitation admission
uses the alpha signup signing configuration, including email and automatic monitor
services, even for CLI signup. Arrange those services, then set:

```dotenv
PUBLIC_SELF_SERVICE_ONBOARDING=true
SIGNUP_EMAIL_ORIGIN=https://alerts.monitor.example.com
SIGNUP_EMAIL_TOKEN=<independent 32-byte base64url secret>
SIGNUP_MONITOR_API_ORIGIN=https://enroll.monitor.example.com
SIGNUP_MONITOR_TOKEN=<independent 32-byte base64url secret>
SIGNUP_MONITOR_PUBLIC_KEY=did:key:z...
PUBLIC_ALPHA_SIGNUP=true
ALPHA_SIGNUP_INVITE_KEY=<independent 32-byte base64url secret>
ALPHA_SIGNUP_MONITOR_ORIGIN=https://monitor.example.com
```

See the [monitor guide](../../../plc-monitor/deploy/public/README.md) and
[first administrator ceremony](../../../../docs/provider-admin-setup.md).
For server-only use, complete CLI signup/activation and use the issued account
credential; the browser passkey/dashboard steps require adding a web client.
No reference-client process is needed for provider CLI commands or bearer API use.
Recreate the provider after changing environment settings.

Alternative clients should start with the
[account API contract](../../../cli/docs/cli-contract.md),
[CLI workflows](../../../cli/docs/cli-workflows.md), and
[protocol specifications](../../../../spec). Shared TypeScript response contracts
live in `@hailproto/client-support/provider-contracts`; native apps consume the
same HTTP representations without depending on TypeScript packages. The reference
client is an example consumer, not a required runtime dependency. The API remains
pre-launch; this packaging split does not promise version-stable contracts.

## 4. Optionally add the reference web client

Set `HAIL_WEB_CLIENT_IMAGE` to the **separate client digest** in the same release
artifact, then run:

```bash
docker compose --env-file .env -f compose.yaml -f compose.web-client.yaml config --quiet
docker compose --env-file .env -f compose.yaml -f compose.web-client.yaml pull
docker compose --env-file .env -f compose.yaml -f compose.web-client.yaml up -d --wait
```

The overlay configures `WEB_CLIENT_ORIGIN=http://web-client:3000`; the provider
forwards only non-API page requests. Both services share the public HTTPS origin,
which preserves passkey, cookie and Origin checks. The client uses the private
`http://provider:3000` transport for its server-side API calls. Neither container
is exposed directly. Do not interpret this setup as support for arbitrary
cross-origin browser authentication.

For a different web client, set `WEB_CLIENT_ORIGIN` to that client's internal
origin using your own overlay, or route pages at your ingress. Keep provider-owned
`/api`, `/hail`, `/.well-known` and `/health` paths directed to the provider.
Browser implementations must implement the documented authentication and Origin
requirements; native applications can use the CLI/account-credential workflows.

### Branding

The reference client defaults to **Hail** and the existing simple `h` mark.
Override at runtime, without rebuilding:

```dotenv
HAIL_WEB_CLIENT_NAME=Example Mail
HAIL_WEB_CLIENT_LOGO_PATH=/brand/logo.svg
HAIL_WEB_CLIENT_FAVICON_PATH=/brand/favicon.png
```

Make the files available at those same-origin paths. For the reference image,
create a host `brand` directory and add a local Compose overlay:

```yaml
services:
  web-client:
    volumes:
      - ./brand:/workspace/hailproto/apps/client/build/client/brand:ro
```

Append this overlay to every Compose command. Assets must be readable by the
container's unprivileged user. Remote image URLs are intentionally excluded by
the client CSP. Names, accessible labels and page titles use the configured name;
protocol references still say Hail. Recreate the client after changing settings.

## 5. Operate and upgrade

Back up PostgreSQL, `.env`, image digests and all overlays. Encrypt backups off-host
and rehearse restoration. Publish images through GitHub Actions; do not build on
a live provider. Pin digests, review schema compatibility, stop incompatible old
writers, and use the same Compose files for every update. Restoring an application
image does not roll back database migrations or erase newly accepted writes.

The scripts under `deploy/public` are Haili-specific operations, not a generic
installer or required provider code. Use your own service supervision and reviewed
backup/restore procedures. Keep monitoring available outside the provider host.
