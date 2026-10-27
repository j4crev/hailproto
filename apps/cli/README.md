# Hail user client

`hailp` is the Hail Protocol reference CLI for account setup, credentials,
Sender Profiles, Grants, messages, vault backups, and provider transfers. It talks to a
provider's account API over HTTPS and keeps user signing keys on the client.

This repository is a reference implementation, not a finished consumer app.
The file-based vault, Bun toolchain, private-PLC fixtures, and reference monitor
are implementation and test choices—not requirements of the Hail protocol.

## Start here

- [Install or build `hailp`](docs/cli-installation.md)
- [Follow task-based CLI workflows](docs/cli-workflows.md)
- [Look up automation and output rules](docs/cli-contract.md)
- [Browse design notes and the roadmap](docs/README.md)

The CLI also has authoritative, command-specific help:

```bash
hailp --help
hailp grant create --help
hailp account transfer --help
```

## Build for development

The sibling `hailproto` and `did-method-plc` repositories must be beside this
checkout because they are local dependencies.

```bash
pnpm --dir ../../vendor/did-method-plc --filter @did-plc/lib build
bun run --cwd ../../packages/hail-codec-ts build
bun install --frozen-lockfile
bun run typecheck
bun run test
```

Run from source:

```bash
bun run hailp -- --help
```

Or build the self-contained Linux executable:

```bash
bun run build
bun run smoke -- dist/hailp
install -Dm755 dist/hailp "$HOME/.local/bin/hailp"
```

Tagged releases build the baseline-compatible Linux x86-64 executable, package
it as `hailp-<version>-linux-x64.tar.gz`, and publish a SHA-256 checksum. The
public canary ceremony is documented in [`docs/public-canary.md`](docs/public-canary.md).

## Use an existing account

Set the path to a private credential file issued for the account. The token
stays in the file; never put it on the command line or in a URL.

```bash
export HAILP_CREDENTIAL_FILE=/secure/account/api.credential.json

hailp account show
hailp profile show
hailp grant list
hailp inbox list
```

`--credentials <path>` overrides the environment variable. Add `--provider`
or `--account-id` to assert that the selected credential belongs to the origin
and account you expect; those flags cannot retarget a credential.

All successful results are JSON on stdout. Errors and secret prompts go to
stderr, and failures use a nonzero exit code. For automation, inspect the JSON
result as well as the exit code: an indeterminate message status is still a
successful status query, not proof of delivery.

### Subscription categories

Grant creation and updates require `--category`; use `--category general` for
General subscriptions. Publishers offer `{ "id": "general", "label": "General" }`
through the existing profile create/update commands. There is no special migration
command, and uncategorized subscription authoring is no longer supported. Existing
signed records remain readable and revocable.

## Create a test account

Self-service account creation must be enabled by the provider. Keep all files
outside Git in a private directory.

```bash
install -d -m 700 /secure/account

hailp vault create \
  --vault /secure/account/vault.json \
  --recovery-file /secure/account/recovery-secret.txt

# Copy and verify both files independently before continuing.
hailp vault verify --vault /secure/account/vault.json --expected-did unbound

hailp account create \
  --provider https://provider.example \
  --address me@provider.example \
  --custody owner-controlled \
  --vault /secure/account/vault.json \
  --state /secure/account/signup.json \
  --credentials /secure/account/api.credential.json \
  --backup-verified
```

Use `--custody managed` only when provider-held identity signing is intended.
Both profiles keep the top PLC recovery key with the owner. Strict-public
onboarding also requires monitor options and an explicit Sender Profile before
Grant testing; see the
[signup workflow](docs/cli-workflows.md#create-an-account).

## Important file and retry rules

- Vaults, recovery secrets, credentials, state files, and signed artifacts are
  private. Store them outside repositories and provider hosts.
- Enter the vault encryption secret at the hidden prompt or through protected
  stdin. Do not pass it as an argument.
- Commands save state and signed artifacts before network submission. After an
  interrupted or ambiguous request, repeat the same command with the same
  paths and options. Do not delete the files and start over.
- Routine owner-controlled Grant, binding, login, and transfer-approval actions
  unlock only the identity key. Onboarding, vault verification, owner-recovery
  login, and transfer cutover deliberately unlock the recovery key too.
- Provider transfer never forwards a source credential to the destination.
  Issue fresh destination access after activation.

## Scope and limitations

The CLI now exercises two public-alpha providers with owner-controlled
`plc.directory` canaries, explicit Sender Profiles, reciprocal Grants and
bidirectional delivered messages. It does not by itself establish production
monitor independence, recovery, hardware-backed key storage, or a standardized
cross-provider client API. See the [roadmap](docs/cli-roadmap.md) for
the remaining production gates and the repository root for normative protocol
specifications.

## Browser recovery packages

Invited browser signup saves `hail-recovery-package.json`. Keep its secret
separately. The package contains the existing encrypted v1 owner vault with its
DID, the exact signed genesis, and encrypted temporary signup state. Expiration
or retirement of that temporary authority does not expire the recovery keys.

To use the package with existing owner-recovery commands, copy it into a private
folder (mode `0700`) and restrict the file to mode `0600`, then run:

```sh
hailp vault verify --vault /private/hail-recovery-package.json --expected-did did:plc:YOUR_DID
hailp vault import --file /private/hail-recovery-package.json --vault /private/owner.vault.json --expected-did did:plc:YOUR_DID
```

Enter the separate recovery secret at the hidden prompt. Verification checks the
owner signature, derived DID and encrypted keys offline. Import extracts a normal
v1 vault without overwriting an existing output. Use that extracted vault for
`account passkey-recover` or the other existing recovery commands. This does not
publish the signed identity, contact the provider, or activate an unfinished
account. Older plain v1 vault files continue to work unchanged.

## Remove a connection

Run `hailp connection list --credentials <file>` to find a connection ID, then
`hailp connection remove <connection-id> --credentials <file>`. Listing requires
`account:read`; removal requires `account:write`. Removal immediately blocks new
connection messages locally and durably retries notification to the other provider.
Repeating removal of the same connection is safe. Subscriptions and existing
messages remain; reconnecting requires a new or replaced code. The web client's
Connections page offers **Remove connection**, confirmed with your passkey.
