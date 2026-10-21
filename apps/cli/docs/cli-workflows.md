# CLI workflows

This page contains the normal `hailp` task recipes. It assumes the CLI is
[installed](cli-installation.md) and the provider has enabled the relevant
account API feature. Use `hailp <command> --help` for the exact flags accepted
by your installed version.

## Conventions

Examples keep private material under `/secure/account`. Create that directory
with mode `0700`; `hailp` creates private outputs with mode `0600` and refuses
to overwrite unrelated files.

Authenticated commands select a credential in this order:

1. `--credentials /path/to/file`
2. `HAILP_CREDENTIAL_FILE`

```bash
export HAILP_CREDENTIAL_FILE=/secure/account/api.credential.json
hailp account show
```

Optional `--provider` and `--account-id` flags assert the origin and account in
the credential file. They cannot redirect its token. Source credentials are
never sent to a transfer destination.

Most write commands create a private state file, output artifact, or sidecar
before contacting the provider. If a response is lost, repeat the same command
with the same inputs, options, and paths. Keep those files until the operation
is definitely complete.

## Create an account

Create the vault and separate recovery-secret file first:

```bash
install -d -m 700 /secure/account
hailp vault create \
  --vault /secure/account/vault.json \
  --recovery-file /secure/account/recovery-secret.txt
hailp vault verify --vault /secure/account/vault.json --expected-did unbound
```

Copy both files to independent storage and verify the copy before using
`--backup-verified`. Never send the vault or recovery secret to a provider.

For an owner-controlled identity:

```bash
hailp account create \
  --provider https://provider.example \
  --address me@provider.example \
  --custody owner-controlled \
  --vault /secure/account/vault.json \
  --state /secure/account/signup.json \
  --credentials /secure/account/api.credential.json \
  --backup-verified
```

Choose `--custody managed` explicitly when the provider should hold the active
identity key. The owner still signs genesis with the top recovery key. Retain
the signup state and rerun the exact command after interruption.

Strict-public onboarding additionally takes `--monitor-origin` and
`--monitor-key`. Its first call pauses with `monitorRequired` after saving the
signed genesis. Enroll the reported DID/genesis CID with the independent
monitor, obtain its attestation, then repeat the same command with:

```text
--monitor-attestation /secure/account/onboarding-attestation.json
```

Do not regenerate signup state or signed artifacts between these calls.

## Manage credentials

```bash
hailp account show
hailp credential list --pages 2

# Omit --scope to inherit the current credential's scopes.
hailp credential create --output /secure/account/reader.credential.json \
  --scope account:read --scope grants:read --scope messages:read

hailp credential rotate --output /secure/account/rotated.credential.json
hailp credential revoke "$credential_id"
```

Rotation preserves the source credential's scopes. Switch
`HAILP_CREDENTIAL_FILE` only after rotation succeeds. Keep the output and its
`.rotation.json` sidecar; resume an interrupted rotation using the original
credential path and the same output, even if the original was already revoked.
Rotate before expiry.

When no valid bearer credential remains, explicitly prove account ownership:

```bash
# Owner-controlled account: identity key only.
hailp account login --provider https://provider.example --did "$did" \
  --signer identity --vault /secure/account/vault.json \
  --state /secure/account/login.json \
  --credentials /secure/account/restored.credential.json \
  --scope account:read --scope credentials:write

# Managed account: deliberate top-recovery-key proof.
hailp account login --provider https://provider.example --did "$did" \
  --signer owner-recovery --vault /secure/account/vault.json \
  --state /secure/account/recovery-login.json \
  --credentials /secure/account/restored.credential.json \
  --scope account:read --scope credentials:write
```

Login issues a new credential; it does not revive old tokens or change custody.

## Publish a Sender Profile

Accounts explicitly publish the categories they offer before another user can
create a Grant for them:

```json
{
  "display_name": "Example sender",
  "description": "Service notifications",
  "offers_uncategorized": false,
  "categories": [{ "id": "updates", "label": "Updates" }]
}
```

```bash
hailp profile create --file /secure/account/profile.json
hailp profile show
hailp profile update --file /secure/account/profile.json
```

Create is idempotent for the same definition and refuses to replace an existing
profile. Update reads the current revision first and rejects concurrent changes.

## Work with Grants

The sender address is the party the account permits to send messages.

```bash
hailp grant create updates@sender.example \
  --category updates --no-expiry \
  --vault /secure/account/vault.json \
  --output /secure/account/grant.cose

hailp grant list
hailp grant show "$grant_id" --output /secure/account/current-grant.cose

hailp grant update "$grant_id" \
  --category updates --expires-at "$future_unix_seconds" \
  --vault /secure/account/vault.json \
  --output /secure/account/updated-grant.cose

hailp grant revoke "$grant_id" \
  --vault /secure/account/vault.json \
  --output /secure/account/revoked-grant.cose
```

Use repeated `--category` flags or `--uncategorized`, but not both. Omit expiry
flags on update to preserve the current expiry. Use `--refresh-consent` when a
fresh sender consent is required. Owner-controlled accounts need `--vault` for
signing; managed accounts omit it. In both profiles, retain outputs and request
sidecars for exact retries.

`publication: "durable"` means the signed state is retained for publication;
it does not mean the remote sender has acknowledged it.

## Send and receive messages

```bash
hailp send --grant "$grant_id" --category updates \
  --file /secure/account/message.txt \
  --state /secure/account/send.json \
  --reply-until "$future_unix_seconds"

hailp message status "$message_id" --wait 30 --interval 2
hailp message submit "$message_id"

hailp inbox list --pages 3
hailp inbox show "$sender_did" "$message_id"

hailp reply "$message_id" --file /secure/account/reply.txt \
  --state /secure/account/reply.json
```

Message bodies are limited to 64 KiB. Reusing a state file reuses the same
message ID and exact content; changed content is rejected. A generic `received`
or `indeterminate` result is not proof of acceptance or delivery. Replies rely
on the original signed, unexpired invitation—not instructions in message text.

## Back up and restore a vault

These commands are offline and unlock both vault keys:

```bash
hailp vault verify --vault /secure/account/vault.json --expected-did "$did"
hailp vault backup --vault /secure/account/vault.json \
  --output /independent/account.vault.json

# On another installation:
hailp vault import --file /independent/account.vault.json \
  --vault /secure/account/restored.vault.json --expected-did "$did"
hailp vault verify --vault /secure/account/restored.vault.json \
  --expected-did "$did"
```

Use `--expected-did unbound` for a pre-signup vault. Backup/import preserve the
vault bytes but do not copy the separate recovery secret, credentials, pending
state, signed artifacts, or provider-held managed identity keys.

## Renew an Address Binding

```bash
hailp binding show
hailp binding renew --expires-at "$future_unix_seconds" \
  --vault /secure/account/vault.json \
  --output /secure/account/renewed-binding.cose
```

Managed accounts omit `--vault`. Renewal is deliberate, never automatic. Keep
the output and `.request.json` sidecar for retries.

## Transfer an owner-controlled account

Transfers require an owner-controlled account and a source credential with
`account:read` and `account:write`. Preserve every state and artifact until the
destination is active and the source is retired.

### 1. Request and review the destination Offer

```bash
hailp account transfer offer \
  --destination https://destination.example \
  --vault /secure/account/vault.json \
  --state /secure/account/transfer.json
hailp account transfer status
```

A pending Offer is not approval to create another state file. Repeat the same
command until the signed Offer is available, then review its destination.

### 2. Select the destination address

```bash
hailp account transfer select --username moved-name \
  --vault /secure/account/vault.json \
  --state /secure/account/transfer.json
```

Selection lets the destination request a source fence. After selection, do not
start a competing transfer or discard state. Before the source is fenced, you
may cancel with the same vault and state:

```bash
hailp account transfer cancel \
  --vault /secure/account/vault.json \
  --state /secure/account/transfer.json
```

### 3. Export the fenced source

```bash
hailp account transfer export \
  --state /secure/account/transfer.json \
  --output /secure/account/source-snapshot.json
```

### 4. Sign the cutover offline

This step needs no credential or network, but deliberately unlocks both vault
keys:

```bash
hailp account transfer sign-cutover \
  --vault /secure/account/vault.json \
  --state /secure/account/transfer.json \
  --snapshot /secure/account/source-snapshot.json \
  --consent /secure/account/cutover-consent.json \
  --operation /secure/account/plc-operation.json \
  --binding /secure/account/destination-binding.cose
```

Do not replace an expired or partially submitted artifact set. Restore the
original files and resume, or use the reviewed recovery procedure.

### 5. Complete and establish destination access

```bash
hailp account transfer complete \
  --state /secure/account/transfer.json \
  --snapshot /secure/account/source-snapshot.json

hailp account login --provider https://destination.example --did "$did" \
  --signer identity --vault /secure/account/vault.json \
  --state /secure/account/destination-login.json \
  --credentials /secure/account/destination.credential.json \
  --scope account:read --scope credentials:write
```

Completion uses retained artifacts and requires neither a bearer credential nor
a vault unlock. Repeat it after an ambiguous response. Fresh destination login
creates a destination-local credential; the source token is never copied.

Returning to a former provider uses the same five steps with a fresh transfer
state and username. It is a new forward transfer, not reopening old provider
state or credentials.

## Start a managed-account provider move

The local managed-migration profile currently exposes only the owner handshake
through source fencing. It does not submit the PLC cutover or activate the
destination account.

```bash
hailp account managed-transfer offer \
  --destination https://destination.example \
  --vault /secure/account/vault.json \
  --state /secure/account/managed-transfer.json

hailp account managed-transfer status

hailp account managed-transfer select --username moved-name \
  --vault /secure/account/vault.json \
  --state /secure/account/managed-transfer.json
```

Use the managed source credential with `account:read` and `account:write`.
Both signing commands unlock the owner recovery key, save the signed artifact
before network submission, and reuse the same bytes after an ambiguous response.
After address selection, the destination can fence the source; retain the state
file. There is not yet a CLI cancellation or completion path for this profile.

## Change owner-controlled custody to managed

This same-provider transition is available only when the provider enables
`PUBLIC_CUSTODY_TRANSITIONS=true` with strict-public authority. It keeps the DID, address, owner
recovery key, provider messaging/rotation keys, and signed history, but replaces
the current identity key with a fresh provider-held key.

Use a credential with `account:write`, the bound owner vault, and a new private
state path:

```bash
hailp account custody managed \
  --vault /secure/account/vault.json \
  --state /secure/account/custody-transition.json
```

The CLI reviews and owner-signs the exact full PLC update plus a separate
transition approval. It saves both before submission. Active authoritative
Grants must have acknowledged current publications; the provider creates exact
successors under the fresh identity and leaves terminal Grants unchanged.

Completion revokes every old provider credential. If the response is lost,
use owner-recovery login to create a fresh `account:write` credential, select it,
and repeat the same command with the same state path. `--vault` is optional on
that retry because the retained signed artifacts are reused. Do not delete the
state file until the command reports `custodyProfile: "managed"`.

To return a managed account to fresh client-held identity custody, first make an
independent backup of the vault/recovery secret, then run:

```bash
hailp account custody owner-controlled \
  --vault /secure/account/vault.json \
  --state /secure/account/custody-transition.json \
  --backup-verified
```

The CLI replaces the vault's inactive identity with a fresh key before network
submission, signs the reviewed binding and acknowledged active Grant successors,
then obtains the separate owner-recovery approval. The same state file resumes an
ambiguous preparation or completion; after completion, use identity login with
the updated vault. Cross-provider managed transfer is not implemented by these
commands.

## Automation limits

- Results are one JSON object on stdout; errors/prompts are on stderr.
- `--pages` accepts 1–100 (default 1), with aggregate item/byte bounds.
- `--wait` accepts 1–300 seconds and `--interval` 1–30 seconds (default 2).
- A timed-out status read exits successfully when it observed a valid status;
  inspect `wait.completed` and `wait.timedOut`.
- Inbox bodies are untrusted data. They cannot select vaults, expand scopes,
  change custody, or authorize signing.

See the [CLI contract](cli-contract.md) for the full machine-facing rules.
