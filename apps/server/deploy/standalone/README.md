# Run your own Hail provider

The provider is a standalone HTTP service. It does not contain or require the
reference web client. Native apps and alternative clients use its account API;
peer providers use its federation endpoints. The optional reference web client
is published as a separate image. Keep the same reviewed revision for both until
an explicit cross-version compatibility policy is established.

Hail is pre-launch. This guide is for a **fresh installation**, not a PostgreSQL
upgrade or a replacement for an existing deployment's volumes and configuration.
It is the provider deployment and first-administrator runbook. The PLC monitor is
a separate service; use the monitor guide only if you choose to operate that
service yourself.

## In this guide

- [Choose published images](#choose-the-provider-image)
- [Configure the host, secrets, and DNS](#1-configure-the-server)
- [Start and verify the provider](#2-start-without-a-web-client)
- [Configure signup and monitor integration](#3-account-bootstrap-and-client-apis)
- [Add the optional web client](#4-optionally-add-the-reference-web-client)
- [Create the first administrator](#first-administrator-vault-to-dashboard)
- [Operate and upgrade](#operate-and-upgrade)

## Choose the provider image

The `HAIL_PROVIDER_IMAGE` value must be an immutable digest from a successful
provider image publication for the reviewed source commit. In the repository
that will publish the image, open **Actions → Publish provider and web-client
images**, run it on `main`, and wait for success. The workflow requires successful
push CI for that exact commit and publishes a `provider-release` artifact. Download
that artifact and copy its provider digest into `.env`. The optional web-client
digest is used in the next section if you choose to run the reference client.

For a fork, the same workflow publishes to that repository's image namespace;
make sure the provider host has pull access to the selected package. Record the
commit and digest together so later upgrades can be reviewed and reproduced. Do
not select an image by a mutable tag alone.

## 1. Configure the server

Use a Linux host with Docker Engine and the Compose plugin, a public domain,
and a stable public IP address. Point the domain's A/AAAA records at this host.
Allow inbound TCP 80/443 (UDP 443 is optional for HTTP/3); restrict SSH to your
administration network. The supplied Caddy terminates HTTPS and obtains
certificates automatically. The database and provider have no host-published
ports. Do not expose PostgreSQL or the provider's HTTP port directly.

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
profile assumes direct public ingress. If you put a proxy or tunnel in front,
adapt Caddy and the trusted client-address path for that proxy; do not copy the
Haili-specific `deploy/public` configuration, which trusts only its host tunnel.

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

See the [monitor deployment guide](../../../plc-monitor/deploy/public/README.md) if you operate that service.
Complete the [first administrator ceremony](#first-administrator-vault-to-dashboard) below.
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


## First administrator: vault to dashboard

After the provider and its independent monitor are ready, use this ceremony to create the first owner-controlled administrator, enroll its passkey, and explicitly grant provider-operator access. It uses your own provider and monitor addresses. The monitor is a separate service; follow its deployment guide only if you operate that service yourself.

### Where each step runs

| Location | What you do there |
| --- | --- |
| Your computer | Keep the vault and recovery secret, sign signup requests, transfer public files |
| Provider VPS privileged console | Authorize the reserved address; later grant operator permission |
| Monitor VPS privileged console | Enroll the public identity checkpoint and produce an attestation |
| Your browser | Register a passkey, sign in, use the dashboard |

The provider and monitor are separate roles even if you operate both. The monitor
records your identity's expected public state, checks it, and signs an attestation
that the provider requires for activation. It does not receive your private keys.
Ordinary invited browser signup automates this handoff; reserved names currently
use this manual CLI bootstrap.

Commands below use **Bash**. Shell variables exist only in the terminal where you
set them; SSH and VPS consoles do not inherit your laptop's variables. Keep the
local terminal open through step 6. If you close it, repeat the settings in step 1
with the same values, not the vault-creation command in step 2.

### Before starting

Have the following ready:

- On your computer: a repository checkout with the native `apps/cli/dist/hailp`
  executable built, plus Rust/rustup, a C linker, Python 3, Bun, `jq`, SSH and
  SCP. From the repository root, build it with:

  ```bash
  python3 apps/cli/scripts/build.py
  test -x apps/cli/dist/hailp
  ```
- On the provider: a current provider image and all current migrations (add the optional
  web-client image for the browser/passkey/dashboard steps),
  public CLI onboarding, passkeys, alpha signup, email and automatic monitoring
  configured as in the account bootstrap configuration above.
  Invitation-only CLI admission uses the same signing key as alpha signup. A
  reserved-name authorization does not substitute for an invitation.
- From the monitor operator: its identity origin, current public signing key and
  the configured HTTPS alert webhook for this account. The identity origin is
  not necessarily the monitor API hostname. A public `did:key` is not a service
  token. Arrange the monitor handoff before publishing a new identity.
- Privileged Docker access on each VPS, `jq` on the monitor host, plus an SSH
  account on the monitor VPS that can receive files in its own home directory.

The reference restricted operations wrappers do not expose arbitrary account
administration or monitor enrollment commands. Use the privileged console for
those steps; do not assume a deployment-only SSH account has that access.

This guide uses the reference Docker images. Discover your actual container names
with `docker ps`; Compose project names and host checkout paths may differ.
For a non-container installation, run the same CLI entrypoints from the relevant
server/monitor directory with that service's environment loaded.

If you already have an active local account and a working passkey, you may grant
that account operator access directly in step 8. You do not need to create a
second identity merely to use the dashboard.

### 1. Your computer: set your deployment values

Paste this entire block into a **local Bash terminal**. Enter your own values at
the prompts. Origins include `https://` and have no trailing slash or path; for
example, a provider origin might be `https://mail.example.org`.

```bash
read -r -p 'Absolute path to your hailproto checkout: ' hail_repo
read -r -p 'Provider HTTPS origin: ' provider_origin
read -r -p 'Monitor identity HTTPS origin: ' monitor_origin
read -r -p 'Verified monitor public signing key (did:key:...): ' monitor_key
read -r -p 'Monitor SSH destination (user@hostname-or-IP): ' monitor_ssh
read -r -p 'Provider SSH destination for private invitation transfer (user@host): ' provider_ssh

provider_domain=$(bun -e '
  const url = new URL(process.argv[1]);
  if (url.protocol !== "https:" || url.origin !== process.argv[1] || url.port)
    throw new Error("Use a canonical HTTPS provider origin without a port");
  console.log(url.hostname);
' "$provider_origin")
admin_address="admin@$provider_domain"
admin_dir="$HOME/.local/share/hailproto/admin-$provider_domain"

printf 'Account: %s\nPrivate directory: %s\nCLI: %s\n' \
  "$admin_address" "$admin_dir" "$hail_repo/apps/cli/dist/hailp"
test -x "$hail_repo/apps/cli/dist/hailp"
```

Stop if a command fails. `admin_dir` is a directory you create **on your own
computer**, not a directory to find on the VPS. If resuming an existing signup,
set it to the directory containing your original vault and `signup.json` instead.
All CLI commands below use an absolute path and work from any current directory.
Save these non-secret settings if you will need to reopen your terminal.

### 2. Your computer: create the vault and copy its public recovery key

Run once for a new account:

```bash
install -d -m 700 "$admin_dir"
"$hail_repo/apps/cli/dist/hailp" vault create \
  --vault "$admin_dir/vault.json" \
  --recovery-file "$admin_dir/recovery-secret.txt"
"$hail_repo/apps/cli/dist/hailp" vault verify \
  --vault "$admin_dir/vault.json" --expected-did unbound \
  < "$admin_dir/recovery-secret.txt"
jq -r '.recovery.publicDidKey' "$admin_dir/vault.json"
```

**Expected:** verification succeeds and the last command prints a public key
beginning `did:key:z…`. Copy that complete public value for step 3. It is not
the recovery secret, the identity key, or the future account DID (`did:plc:…`).
You do not invent it or obtain it from the provider.

The CLI creates private files and refuses to overwrite them. Back up the vault
independently and keep the recovery secret in separate protected storage. Verify
your backup before proceeding. Do not transfer the vault, recovery secret,
`signup.json`, or API credential to either VPS or paste them into chat.

### 3. Provider VPS console: authorize the reserved address

Switch to the **provider VPS privileged console**. This is not the monitor VPS.
The prompts below set variables in this console; paste the account address from
step 1 and public recovery key from step 2.

```bash
docker ps --format '{{.Names}}'
read -r -p 'Provider container name: ' provider_container
read -r -p 'Admin Hail address: ' admin_address
read -r -p 'Public recovery key from your local vault: ' recovery_public_key

docker exec "$provider_container" sh -c \
  'test -f src/cli/authorize-provider-role.ts && test -f src/cli/provider-operator.ts'
docker exec "$provider_container" \
  bun src/cli/authorize-provider-role.ts "$admin_address" "$recovery_public_key"
```

**Expected:** JSON containing the reserved account ID and instructions to complete
normal onboarding. This reserves the name for your key; it does not create the
account or grant operator access. If the name belongs to another key, resolve
ownership instead of replacing it.

If the file check fails, update/rebuild the provider image before continuing.
A host path such as `/opt/...` is not a container path. The reference container's
working directory is `/workspace/hailproto/apps/server`; the relative CLI paths
above are resolved there by `docker exec`.

#### Create the administrator's private invitation

Still in the provider privileged console, create one invitation using the running
provider's configured key. Choose an existing SSH user who will retrieve the file;
this grants no new SSH or sudo access. The invitation contains a bearer capability,
so keep it out of logs and share it only with the intended administrator.

```bash
read -r -p 'Existing provider SSH user for invitation retrieval: ' invitation_owner
invitation_home=$(getent passwd "$invitation_owner" | cut -d: -f6)
test -n "$invitation_home" && test -d "$invitation_home"
invitation_host_dir=$(mktemp -d "$invitation_home/hail-admin-invite.XXXXXX")
invitation_container_dir=$(docker exec "$provider_container" mktemp -d /tmp/hail-admin-invite.XXXXXX)
docker exec "$provider_container" bun src/cli/create-signup-invitation.ts "$invitation_container_dir/invitation.json"
docker cp "$provider_container:$invitation_container_dir/invitation.json" "$invitation_host_dir/invitation.json"
chown -R "$invitation_owner:$(id -gn "$invitation_owner")" "$invitation_host_dir"
chmod 700 "$invitation_host_dir"
chmod 600 "$invitation_host_dir/invitation.json"
docker exec "$provider_container" rm "$invitation_container_dir/invitation.json"
docker exec "$provider_container" rmdir "$invitation_container_dir"
printf 'Private invitation file to download: %s/invitation.json\n' "$invitation_host_dir"
```

Return to your local terminal and download that file into the private admin directory.
Enter its printed **path**, not the invitation token:

```bash
read -r -p 'Absolute provider-host invitation file path: ' invitation_remote_path
scp "$provider_ssh:$invitation_remote_path" "$admin_dir/invitation.json"
chmod 600 "$admin_dir/invitation.json"
admin_invitation=$(jq -er --arg provider "$provider_origin" \
  'select(.type == "hail.signup.invitation-file" and .provider == $provider) | .invitation' \
  "$admin_dir/invitation.json")
```

Keep this token/file private. The CLI currently accepts the token through
`--invitation`, so use a trusted workstation without shell tracing. Do not paste
command traces containing it into reports. Remove the host transfer copy after
verified download; retain local signup state for exact retries. A consumed invitation
cannot create another account, while the admitted ceremony resumes within its own lifetime.

### 4. Your computer: start account creation over HTTPS

Return to the **local terminal from step 1**. This runs your local CLI, reads your
local vault and contacts `provider_origin` over HTTPS. Private keys remain local.
Use `--backup-verified` only after checking your backup.

```bash
set -o pipefail
umask 077
"$hail_repo/apps/cli/dist/hailp" account create \
  --provider "$provider_origin" --address "$admin_address" --custody managed \
  --invitation "$admin_invitation" \
  --vault "$admin_dir/vault.json" \
  --state "$admin_dir/signup.json" \
  --credentials "$admin_dir/api.credential.json" \
  --passkey-enrollment "$admin_dir/passkey-enrollment.json" \
  --monitor-origin "$monitor_origin" --monitor-key "$monitor_key" \
  --backup-verified < "$admin_dir/recovery-secret.txt" \
  | tee "$admin_dir/create-result.json"
```

**Expected:** `monitorRequired: true`, a `did` and an `operationCid`. This pause is
normal. It means the identity was published and is awaiting monitor verification,
not that signup failed. Preserve the vault and signup state; do not start over.

Prepare two **public** files for the monitor:

```bash
jq -e 'select(.monitorRequired == true and
  (.did | type == "string") and (.operationCid | type == "string")) |
  {did, genesisCid: .operationCid}' \
  "$admin_dir/create-result.json" > "$admin_dir/admin-enrollment.json"
jq '{did,rotationKeys:.operation.rotationKeys,
  verificationMethods:.operation.verificationMethods,
  alsoKnownAs:.operation.alsoKnownAs,services:.operation.services}' \
  "$admin_dir/signup.json" > "$admin_dir/admin-reviewed-plc-data.json"
chmod 600 "$admin_dir/admin-enrollment.json" "$admin_dir/admin-reviewed-plc-data.json"
```

Stop if the `jq -e` check fails; do not enroll an identity with empty values.
`admin-enrollment.json` carries the public DID and genesis CID, so you do not need
to invent or manually transcribe `$DID` or `$GENESIS_CID`.

### 5. Monitor handoff: upload, enroll, and retrieve the attestation

#### 5a. Your computer: upload only the two public files

```bash
ssh "$monitor_ssh" 'umask 077; mkdir -p "$HOME/hail-admin-bootstrap"; printf "Monitor staging directory: %s/hail-admin-bootstrap\n" "$HOME"'
scp "$admin_dir/admin-enrollment.json" "$admin_dir/admin-reviewed-plc-data.json" \
  "${monitor_ssh}:hail-admin-bootstrap/"
```

Record the absolute staging directory printed by SSH. It is on the **monitor
host**, under the SSH user's home, not under the provider checkout. These commands
assume SSH is already configured; use your deployment's SSH options/alias when
needed. Bootstrap one admin at a time in this staging directory.

#### 5b. Monitor VPS privileged console: enroll the new identity

Switch to the **monitor VPS privileged console**. Set its variables here:

```bash
docker ps --format '{{.Names}}'
read -r -p 'Monitor container name: ' monitor_container
read -r -p 'Absolute monitor staging directory printed in step 5a: ' monitor_stage
read -r -p 'Configured HTTPS alert webhook for this identity: ' alert_webhook

did=$(jq -er '.did | select(type == "string" and startswith("did:plc:"))' \
  "$monitor_stage/admin-enrollment.json")
genesis_cid=$(jq -er '.genesisCid | select(type == "string" and startswith("b"))' \
  "$monitor_stage/admin-enrollment.json")
jq -e --arg did "$did" '.did == $did' "$monitor_stage/admin-reviewed-plc-data.json"
printf 'Enrolling %s at genesis %s\n' "$did" "$genesis_cid"
```

Check these against the output from step 4. Stop on any error. The alert webhook
must be your configured monitor alert receiver; it is not an email address or a
URL belonging to some other Hail deployment. CLI bootstrap does not perform the
browser signup's consumer-email binding.

Copy the public checkpoint into the running container's writable temporary
directory, then enroll it:

```bash
docker exec -i "$monitor_container" sh -c \
  'umask 077; cat > /tmp/admin-reviewed-plc-data.json' \
  < "$monitor_stage/admin-reviewed-plc-data.json"
docker exec "$monitor_container" \
  bun src/cli/enroll.ts "$did" "$genesis_cid" "$alert_webhook" \
  /tmp/admin-reviewed-plc-data.json
```

**Expected:** JSON with `"state":"enrolled"`. This uses `/tmp` in the reference
monitor image, so it does not depend on a particular host checkout or `/reviewed`
bind-mount location. If the container is recreated before enrollment succeeds,
repeat the checkpoint-copy command. Only the public checkpoint enters it.

#### 5c. Same monitor console: create the attestation file

Wait for the running monitor to poll successfully and deliver its enrollment
alert. An **attestation** is the monitor's signed JSON confirmation of those
checks; it is not the checkpoint you uploaded. Save it rather than copying
terminal output by hand:

```bash
attestation="$monitor_stage/onboarding-attestation.json"
if docker exec "$monitor_container" \
  bun src/cli/attest-onboarding.ts "$did" "$genesis_cid" \
  > "$attestation.tmp"; then
  if jq -e '(.monitorDidKey | type == "string") and
    (.payload | type == "string") and (.signature | type == "string")' \
    "$attestation.tmp" > /dev/null; then
    chown --reference="$monitor_stage/admin-enrollment.json" "$attestation.tmp"
    chmod 600 "$attestation.tmp"
    mv "$attestation.tmp" "$attestation"
    printf 'Ready to download: %s\n' "$attestation"
  else
    rm -f "$attestation.tmp"
    printf 'Invalid attestation output; stop and investigate.\n' >&2
  fi
else
  rm -f "$attestation.tmp"
  printf 'Attestation not issued. Resolve the reported error before continuing.\n' >&2
fi
```

**Expected:** `Ready to download: .../onboarding-attestation.json`. Ownership is
set to the SSH user who uploaded the public metadata, allowing that user to
retrieve the file. A failed command does not replace an existing attestation.

If the error says monitoring coverage is unavailable, check monitor health,
polling and alert delivery. Retry this attestation block after those checks pass.
Do not save an error message as JSON or bypass the attestation gate.

#### 5d. Your computer: download the file from the monitor

```bash
scp "${monitor_ssh}:hail-admin-bootstrap/onboarding-attestation.json" \
  "$admin_dir/onboarding-attestation.json"
chmod 600 "$admin_dir/onboarding-attestation.json"
jq -e '(.monitorDidKey | type == "string") and
  (.payload | type == "string") and (.signature | type == "string")' \
  "$admin_dir/onboarding-attestation.json"
```

The local file is now the attestation input to the next command. Shape checking
here catches copy errors; the provider verifies the signature and exact identity.

### 6. Your computer: finish account creation

Use the **same local settings, invitation, vault and signup state** as step 4. If
you reopened the terminal, reload `admin_invitation` from the saved invitation file. Paste this
complete command into your local terminal. The absolute CLI and file paths work
from any current directory; no shell function needs to be defined.

```bash
"$hail_repo/apps/cli/dist/hailp" account create \
  --provider "$provider_origin" --address "$admin_address" --custody managed \
  --invitation "$admin_invitation" \
  --vault "$admin_dir/vault.json" \
  --state "$admin_dir/signup.json" \
  --credentials "$admin_dir/api.credential.json" \
  --passkey-enrollment "$admin_dir/passkey-enrollment.json" \
  --monitor-origin "$monitor_origin" --monitor-key "$monitor_key" \
  --backup-verified \
  --monitor-attestation "$admin_dir/onboarding-attestation.json" \
  < "$admin_dir/recovery-secret.txt"
```

**Expected:** activation completes and `passkey-enrollment.json` is written.
Back up the updated vault, now bound to your account DID, and retain signup state.
No Sender Profile, Grant or message setup is required for the dashboard.

### 7. Your browser: register and test the passkey

On your computer, open the short-lived enrollment URL. On Linux:

```bash
xdg-open "$(jq -r '.url' "$admin_dir/passkey-enrollment.json")"
```

On macOS, use `open` instead of `xdg-open`; on another platform, open that file's
`url` value privately in your browser. Do not share the enrollment link.

Complete the passkey prompt, then visit your provider's homepage and
sign in with that passkey. The recovery secret is not your login password. The
enrollment link is single-use and expires after ten minutes. If it expires,
follow [owner-proof recovery workflow](../../../cli/docs/account-access-recovery.md)
with the original vault and account DID; do not create another account.

**Successful login is not the final step. `/admin` will return 403 until step 8.**

### 8. Provider VPS console: grant operator permission (required)

Return to the **provider VPS privileged console**, not the monitor. Set these
values again so this works even if you opened a fresh console:

```bash
docker ps --format '{{.Names}}'
read -r -p 'Provider container name: ' provider_container
read -r -p 'Active admin Hail address: ' admin_address

docker exec "$provider_container" \
  bun src/cli/provider-operator.ts grant "$admin_address"
```

**Expected:** JSON with `"action":"grant"` and your address. This requires an
active account with an enrolled passkey. It is separate from the reserved-address
authorization in step 3. The grant is local to this provider and serving generation.

Refresh your provider's `/admin` page. It should now show the invitation form.
If it still returns 403, check that the grant address, signed-in account and
provider match. If creation requires a recent login, sign in again: invitation
creation requires passkey verification within the last ten minutes.

### Everyday use and recovery

Sign in on your provider’s homepage, then open `/admin` or
**Provider administration** in the sidebar. Enter an email address to send an
invitation, or leave it blank to create a private link. Invitations last seven
days and can be used once. Anyone holding the link can use it; the delivery email
is not an enforced identity restriction.

History distinguishes email-service acceptance from signup started or completed.
An unconfirmed email send is not proof of failure: check with the recipient
before issuing another invitation. Routine invitations require no VPS console,
CLI, recovery key or manual monitor handoff.

To remove operator access, run the step-8 command with `revoke` instead of `grant`.
This does not invalidate invitations already issued. Account movement/generation
changes require a new explicit grant.

| Symptom | What to check |
| --- | --- |
| `admin_dir` is empty or points to the wrong place | Repeat step-1 settings in the local terminal; use your original private directory |
| Local `Module not found ...hailp.ts` | `hail_repo` must be the absolute path to the installed checkout, not the private admin directory |
| Container lacks `src/cli/authorize-provider-role.ts` | Deploy the current provider image; do not substitute the host's checkout path |
| `$DID` / `$GENESIS_CID` are unset | Step 5b explicitly reads lowercase `did` / `genesis_cid` from the public metadata file on the monitor host |
| Unsure what to copy back | Download the JSON produced in step 5c, not the reviewed checkpoint or console error output |
| Login works but `/admin` returns 403 | Complete the provider-local operator grant in step 8 |

## Operate and upgrade


Back up PostgreSQL, `.env`, image digests and all overlays. Encrypt backups off-host
and rehearse restoration. Publish images through GitHub Actions; do not build on
a live provider. Pin digests, review schema compatibility, stop incompatible old
writers, and use the same Compose files for every update. Restoring an application
image does not roll back database migrations or erase newly accepted writes.

The scripts under `deploy/public` are Haili-specific operations, not a generic
installer or required provider code. Use your own service supervision and reviewed
backup/restore procedures. Keep monitoring available outside the provider host.
