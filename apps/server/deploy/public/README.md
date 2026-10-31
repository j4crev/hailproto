# Deploy a new Hail provider

This guide is the starting point for an operator deploying the reference provider
on their own domain. The stack contains the TypeScript provider, browser GUI,
PostgreSQL and a loopback-only Caddy edge behind a host Cloudflare Tunnel.
Hail is pre-launch: select a reviewed repository revision and plan coordinated
application/schema upgrades. The [protocol specifications](../../../../spec) define
federation; this guide configures the reference implementation.

## 1. Prepare the host and domain

You need a Linux host with Docker Engine and Docker Compose (2.40.3 or later for
the override example below), Git, OpenSSL, a domain you control in Cloudflare,
a host-installed cloudflared connector, and privileged console recovery access.
Use your own domain throughout; the checked-in example defaults to `haili.app`.
Do not point an independent provider at Haili's private tokens or deployment scripts.

Clone the monorepo and initialize its pinned PLC dependency:

```bash
git clone --recurse-submodules https://github.com/j4crev/hailproto.git
cd hailproto
# Select your reviewed release before building.
git submodule update --init --recursive
cd apps/server/deploy/public
umask 077
cp .env.example .env
chmod 600 .env
```

Use a host name distinct from the public provider domain. Some VPS images map their
host name to loopback in `/etc/hosts`. Check `getent ahosts <your-provider-domain>`
from the host and later from the containers: public activation must resolve the
public endpoint. Correct persistent cloud-init aliases as well as `/etc/hosts`.

## 2. Configure identity, secrets and feature gates

### DNS discovery for your provider

Publish this TXT record for your native address domain, substituting your domain:

```dns
_hail-provider.haili.app. TXT "v=hail1; provider=haili.app"
```

Use one record, the exact lowercase format above, and a public hostname without
`https://`, a port, or a path. A self-reference is intentional: discovery does
not recurse. Remote providers check this record when discovering your users.
Your own provider skips the TXT lookup for its exact configured native domain
and goes directly to that domain's HTTPS WebFinger endpoint. All other domains,
including custom domains hosted on your server and native-domain subdomains,
still use DNS discovery. Custom-domain registration always checks DNS explicitly.
Absent records retain domain-hosted HTTPS WebFinger; malformed records and DNS
failures stop discovery. Your provider must still serve WebFinger and signed
bindings at its HTTPS origin. This discovers an address's DID; later account
activities and delivery use that DID's PLC-resolved Hail service and permissions.

Allow outbound DNS to your configured recursive resolver and HTTPS to remote
providers. Prefer a DNSSEC-validating resolver. Hail currently accepts unsigned
DNS, so the resolver is part of the discovery trust boundary. Recursive caching
honors DNS TTLs; no application cache or scheduled domain checks are used.

For a custom domain hosted by this provider, the same record names your provider
instead of the custom domain, for example
`_hail-provider.j4crev.com TXT "v=hail1; provider=haili.app"`. Domain registration
also requires the provider-issued `_hail-domain-verify` challenge. After verification,
Settings → Custom domains can authorize a separate signup for an exact custom
address without an additional invitation, even in invite-only mode. General
native-address signup still follows the provider’s registration policy. See the
[implementation checklist](../../../../docs/custom-domains.md). With public registration enabled,
new publishers can choose **Use a custom domain…** beside the username at `/signup`,
prove both TXT records in the added verification step, and
create their custom account directly without a provider-native account. The new
account owns the domain administration record. Keep both TXT records until account
setup starts; afterward remove only `_hail-domain-verify`, keeping `_hail-provider`.
The DNS setup lasts 24 hours, with 15 minutes to begin signup after verification.
If registration closes before admission, standalone signup stops; already-admitted
setups can continue through their existing recovery and passkey flow. Upgrade resolvers
before advertising DNS-only addresses: old WebFinger-only clients cannot discover
them. Neither record changes website hosting or SMTP email routing.

### Address Binding v2 rollout and lifecycle

This release uses nonexpiring version-2 Address Bindings. Existing custom-domain
and standalone signup flows retain their account and domain ownership semantics.
Review the account inventory and take a verified database backup before upgrading.

Version 2 has a closed signed payload: `type`, `version`, `address`, `did`,
`issued_at`, and `key_id`. There is no `expires_at` or scheduled binding renewal.
Resolvers still verify current DNS/WebFinger publication, the exact address and
DID, and the current validated PLC identity key, allowing at most 300 seconds of
future issuance. Hail does not publish addresses in PLC `alsoKnownAs` or use it
as address authority. Address or identity-key changes need explicit binding
publication, including current custom-domain delegation checks.

This alpha upgrade rejects version 1 rather than running both parsers. Plan
one-time freshly signed v2 publication for existing accounts, preserving their
DIDs and authorized keys. Managed accounts use the authorized provider identity
signer; owner-controlled accounts require their owner's identity signature.
Editing stored bytes cannot upgrade a signature. Retain historical signed evidence
privately and coordinate compatible resolver upgrades and account publication;
old public bindings will not verify under v2-only readers. The routine CLI
publication command expects an existing v2 binding.

For the one-time managed-account conversion, set `ADDRESS_BINDING_V2_UPGRADE=true`
in the provider environment. Startup performs the conversion before serving
requests or starting workers. It refuses in-progress onboarding/migration or any
owner-controlled legacy publication unless that exact canonical address appears
in the operator-approved comma-separated `ADDRESS_BINDING_V2_WITHDRAW_OWNERS` list.
That list withdraws publication only; it does not delete accounts, keys or messages.
Do not use it for an owner who expects continued address resolution.

The converter checks current PLC identity, messaging and provider authority, and
custom-domain DNS routing. It signs fresh v2 payloads with the existing managed
identity keys, verifies the signatures, retains PLC signing evidence, and withdraws
legacy public artifacts. All publication changes commit in one transaction;
failures leave prior selections and signed bytes intact. Successful reruns do
nothing. Retired accounts remain withdrawn through migration 0090. Remove the
temporary environment settings after verifying the completed upgrade.

A code-only rollback to a v1 reader is **not supported after conversion commits**.
Preserve the pre-upgrade database backup along with the retained application image;
prefer fixing forward. A restore requires stopping writers and restoring the
matching database and application together, accounting for any post-upgrade data.
The deployment wrapper's image rollback alone cannot undo this data conversion.

The reference resolver does not application-cache discovery. Any future cache must
last no more than one hour and obey shorter DNS TTL, HTTP freshness, and PLC policy
bounds. Domain loss does not revoke DID-based grants or disable provider login,
and binding age does not automatically withdraw a published address.

The migration-retirement implementation records irreversible publication
tombstones, hiding the retired account's WebFinger mappings and direct public COSE
URLs while preserving private audit evidence. Settings also supports explicit
administrator domain withdrawal and account deletion with provider-inbox erasure.
Address reuse waits 3630 seconds; domain reassignment requires fresh ownership
proof. Account deletion revokes access and refuses accounts with retained migration
snapshots until snapshot erasure is supported. Forced domain takeover and
custom-domain provider transfer remain deferred. See the
[lifecycle details](../../../../docs/custom-domains.md#address-release-domain-withdrawal-and-account-deletion).

Migration 0091 requires a coordinated upgrade: stop the old provider before the
new provider starts and migrates the database, and replace the GUI as well. Do not
run old/new provider replicas concurrently. PostgreSQL 17 or later is required for
the transaction timeout used by lifecycle operations; Haili runs PostgreSQL 18.6.
After any address release, domain withdrawal or account closure, schema rollback
is refused. The wrapper's retained image alone is not a valid rollback after
address reuse; prefer fixing forward and preserve the verified pre-upgrade backup.

Withdrawal assumes provider cooperation: a former authority retaining a still-valid
signature can republish it if its identity key remains current. Publication removal
is not cryptographic revocation. The DNS ownership/setup challenges still last
24 hours, and verified standalone admission still lasts 15 minutes; those limits
are independent of binding lifetime.

### Provider configuration

Edit the private `.env`:

| Setting | Value |
| --- | --- |
| `PROVIDER_DOMAIN` | Your public DNS name, without scheme or path |
| `PROVIDER_ID` | A stable local identifier for this provider |
| `PLC_PROVIDER_OPERATORS` | JSON array naming the actual operator, e.g. `["example-operator"]` |
| `DB_PASSWORD` | Independent random database secret |
| `KEY_ENCRYPTION_KEY` | Independent 32-byte base64url key for retained operational keys |
| `PASSKEY_AUTH` | `true`; RP ID/origin derive from your provider domain |
| `CONNECTION_PREVIEW` | Explicit `true` or `false`; the supplied profile defaults to `true` |
| `PUBLIC_SELF_SERVICE_ONBOARDING` | Initially `false`; enable after the monitor/backup ceremony is ready |
| `PUBLIC_ALPHA_SIGNUP` | Initially `false`; browser signup needs email and automatic monitoring |
| `PUBLIC_MANAGED_TRANSFER` | Initially `false`; transfer requires separate operational readiness |

Generate each secret separately; do not reuse one across roles:

```bash
openssl rand -base64 32 | tr '+/' '-_' | tr -d '='
```

Keep `.env` and recovery material outside version control. Changing the encryption
key without a key migration can make stored operational keys unreadable. Changing
the passkey RP ID invalidates existing provider-local passkeys.

The base Compose file hardcodes `PUBLIC_CUSTODY_TRANSITIONS: "true"` for Haili.
A `.env` variable does not override that literal. New operators can disable it in
a local Compose overlay until custody/recovery procedures are ready.

## 3. Select persistent database configuration

The checked-in base Compose file pins PostgreSQL 14.24. Existing Haili hosts use
an independently retained PostgreSQL 18 overlay. A fresh installation can use the
following explicit 18.6 baseline with an empty volume; review the image pin for
your deployment. This example is **not** an upgrade procedure for an existing database.

Create `compose.local.yaml` beside the base file:

```yaml
services:
  db:
    image: postgres:18.6-alpine
    volumes: !override
      - provider_db18:/var/lib/postgresql
  provider:
    environment:
      PUBLIC_CUSTODY_TRANSITIONS: "false"
volumes:
  provider_db18:
```

Use the same ordered files for every Compose command, backup and application
rollback. Keep the overlay with your deployment configuration and encrypted backup.
Never mount a PostgreSQL 14 data directory into 18, select an old volume after new
writes, or run `down -v` as an upgrade/recovery step. Existing databases need a
separately rehearsed dump/restore migration and preservation proof.

## 4. Configure HTTPS ingress

Create a Cloudflare Tunnel for your provider hostname and run its connector as a
host service with a protected tunnel credential. Publish the hostname through the
tunnel's proxied CNAME, routing to **HTTP `127.0.0.1:8080`** with your provider
hostname as HTTP Host Header. Remove obsolete direct-origin A/AAAA records.

Configure HTTPS enforcement and cache bypass for dynamic application traffic.
Disable browser-only challenges for `/api`, `/hail`, `/.well-known`, `/health`
and their slash-delimited subpaths. Federation clients cannot complete interactive
Access or browser challenges. Keep managed WAF/DDoS protection; Free-plan Bot Fight
Mode cannot be selectively bypassed for these API paths.

Only the host connector may reach the origin listener. Caddy trusts
`CF-Connecting-IP` there and overwrites `X-Hail-Trusted-Client-IP`; never expose
8080 publicly or forward caller-supplied trusted-client headers. Preserve actual
IPv6 addresses: do not enable Remove visitor IP headers or Pseudo IPv4 transforms.

Use key-only administration over your private access network, retain console
recovery, and restrict host/hosting firewalls for both IP families after testing
private access and outbound connectivity. The database and provider containers
must remain private. Test Docker forwarding rules as well as the host firewall.

## 5. Build, start and verify

Run from `apps/server/deploy/public`:

```bash
docker compose --env-file .env -f compose.yaml -f compose.local.yaml config --quiet
docker compose --env-file .env -f compose.yaml -f compose.local.yaml build provider
docker compose --env-file .env -f compose.yaml -f compose.local.yaml up -d --wait db gui provider caddy
docker compose --env-file .env -f compose.yaml -f compose.local.yaml ps
```

The single built image contains both provider and GUI. The provider applies pending
migrations before listening. Inspect service logs if health checks fail. Container
health alone does not prove public DNS, TLS, discovery or monitoring work.

From another network:

```bash
curl --fail --silent --show-error https://your-provider.example/health/ready
curl --fail --silent --show-error https://your-provider.example/
```

Verify the tunnel connector is ready, requests are not cached/challenged, and direct
public database/provider/origin ports are inaccessible. After creating an account,
verify WebFinger, its signed Address Binding and a grant-authorized exchange with
a compatible peer. A generic envelope HTTP receipt is not proof of delivery.

## 6. Arrange monitoring and signup admission

Before publishing an identity, arrange a reviewed monitor and external alert path.
Follow the [monitor deployment guide](../../../plc-monitor/deploy/public/README.md)
and [email receiver guide](../../../plc-monitor/deploy/cloudflare-alert-worker/README.md).
Strict public CLI onboarding requires the independent-monitor evidence specified by
the protocol. Same-operator monitoring belongs to the explicitly reduced-assurance
browser alpha profile; separate hosting alone does not make it independent.

Registration defaults to `invite` for both CLI and browser. The current runtime
loads the invitation verification key from enabled alpha signup configuration;
merely enabling CLI onboarding or reserving `admin` does not bypass admission.
Configure email and automatic monitor enrollment before bootstrapping an invited
administrator, even though that administrator uses the manual strict-public monitor
ceremony. Deploy the email receiver first, then the monitor API. Set:

```dotenv
PUBLIC_SELF_SERVICE_ONBOARDING=true
SIGNUP_EMAIL_ORIGIN=https://alerts.your-monitor.example
SIGNUP_EMAIL_TOKEN=<independent email-service secret>
SIGNUP_MONITOR_API_ORIGIN=https://enroll.your-monitor.example
SIGNUP_MONITOR_TOKEN=<monitor enrollment service secret>
SIGNUP_MONITOR_PUBLIC_KEY=did:key:z...
PUBLIC_ALPHA_SIGNUP=true
ALPHA_SIGNUP_INVITE_KEY=<independent canonical 32-byte base64url signing key>
ALPHA_SIGNUP_MONITOR_ORIGIN=https://your-monitor.example
```

The monitor identity origin must match signed attestations; it may differ from the
API hostname. The receiver's `SIGNUP_ORIGIN` must match the browser/passkey origin.
The [monitor guide](../../../plc-monitor/deploy/public/README.md#automatic-reduced-assurance-alpha-enrollment)
defines matching settings and the authenticated email-binding contract. Recreate
provider/GUI using the same Compose files after environment changes; a plain restart
does not reload them. Keep registration invitation-only during bootstrap.

## 7. Create the administrator and invite users

Follow [First provider administrator: vault to dashboard](../../../../docs/provider-admin-setup.md):

1. Generate and independently back up the owner's vault on their computer.
2. Authorize its public recovery key for the reserved administrator address.
3. Mint a private signup invitation from the provider console and transfer it to the owner.
4. Start CLI onboarding, enroll the exact public state with the monitor, and retrieve its attestation.
5. Complete onboarding, enroll/test a passkey, and grant explicit operator permission.

Reserved names (`admin`, `ops`, `alerts`, `abuse`, `security`, `support`) are not
accounts and confer no privilege automatically. They remain reserved on custom
domains too. The reserved native-domain administrator uses CLI signup;
the browser address picker intentionally excludes reserved names.

After first login, `/admin` can issue private signup links or send email invitations
and can switch public registration on/off with recent passkey verification.
Invitations are seven-day, single-use admission capabilities; email-service acceptance
is not inbox delivery. CLI and browser share the admission ledger. Public mode removes
only the invitation requirement, not recovery, monitoring or reserved-name restrictions.

The browser wizard verifies **one saved DID-bound recovery package** before explicit
publication, verifies email, waits for monitored activation, and requires fresh
passkey sign-in before retiring setup authority. No full-access signup credential
is issued. See [signup behavior](../../../client/README.md#invited-signup) and
[trust/recovery boundaries](../../../../docs/public-authentication.md).

The signup API retains exact intent under a setup bearer. `POST /api/v1/signup`
creates the provisional ceremony; `GET /:id` reads progress; `POST /:id/verify-backup`
records the saved-package digest commitment; `POST /:id/advance` resumes the exact
operation; `POST /:id/complete` requires the fresh passkey session. These paths are
under `/api/v1/signup`; POSTs require the expected Origin and responses are no-store.
Retries cannot change keys, address or token hashes or revive retired setup authority.

Verify an invited browser signup, alert, passkey login and explicit message exchange
before expanding admission. Setup lasts 24 hours and enrollment tokens ten minutes.
Keep original package/state after interruption. Switching registration to invite
preserves admitted continuations; disabling the signup endpoint affects continuation
as well. Preserve retained ceremonies and use compatible code for rollback.

## 8. Operate and upgrade

Maintain encrypted off-host backups of the database, `.env` (including key encryption
material), selected image/revision and Compose overlays. Keep the decryption key off
the provider and test restoration into an isolated instance on the recorded PostgreSQL
major. Compare retained state and decrypt all operational keys before trusting recovery.
Monitor readiness, backup freshness and monitor coverage externally; name incident and
abuse contacts and keep an out-of-provider reporting path.

For upgrades, take/verify a backup, read schema compatibility requirements, retain
both running application images, then build and recreate provider/GUI together.
Migrations 79/80 change content/evidence readers and forbid mixed old/new serving;
see [content storage](../../../../docs/content-storage-and-attachments.md) and
[evidence storage](../../../../docs/verification-evidence-storage.md). Code rollback
must preserve the database overlay, current volume and compatible schema readers.
Never restore an old dump over newly accepted writes as an application rollback.

The checked-in `provider-ops.sh`, backup scripts and one-time setup helpers include
Haili-specific paths, domains, bucket names and policy checks. They are examples for
operator adaptation, not generic installers. Do not install them unchanged for a
new domain. [Haili operations](../../../../docs/haili-operations.md) describes the
installed Haili environment; use your own reviewed service supervision, backup and
least-privilege administration configuration.

Public transfers are optional. Enable `PUBLIC_MANAGED_TRANSFER` only with the pinned
`PLC_MANAGED_MONITOR_ORIGIN`/`PLC_MANAGED_MONITOR_PUBLIC_KEY` and the participating
providers' [readiness requirements](../../../cli/docs/custody-transitions.md#production-enablement-required-versus-deferrable).
Custody transitions and Connections are separate switches. Supported settled
connections survive moves; pending work and unsupported history remain blocked.
