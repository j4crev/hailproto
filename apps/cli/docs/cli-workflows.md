# CLI workflows

This page contains the normal `racr` task recipes. It assumes the CLI is
[installed](cli-installation.md) and the provider has enabled the relevant
account API feature. Use `racr <command> --help` for the exact flags accepted
by your installed version.

## Conventions

Examples keep private material under `/secure/account`. Create that directory
with mode `0700`; `racr` creates private outputs with mode `0600` and refuses
to overwrite unrelated files.

Authenticated commands select a credential in this order:

1. `--credentials /path/to/file`
2. `RACR_CREDENTIAL_FILE`

```bash
export RACR_CREDENTIAL_FILE=/secure/account/api.credential.json
racr account show
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
racr vault create \
  --vault /secure/account/vault.json \
  --recovery-file /secure/account/recovery-secret.txt
racr vault verify --vault /secure/account/vault.json --expected-did unbound
```

Copy both files to independent storage and verify the copy before using
`--backup-verified`. Never send the vault or recovery secret to a provider.

For an owner-controlled identity:

```bash
racr account create \
  --provider https://provider.example \
  --address me@provider.example \
  --custody owner-controlled \
  --vault /secure/account/vault.json \
  --state /secure/account/signup.json \
  --credentials /secure/account/api.credential.json \
  --backup-verified
```

If the provider uses `invite` registration, add `--invitation '<signed token>'`.
Use the token from the invitation link’s `#invitation=` fragment (URL-decoded),
not the entire URL. The CLI retains it in the private setup state for retries;
you do not need to repeat the option when resuming. In `public` mode, omit it.
Both modes require an address at the provider’s configured domain and preserve
the existing recovery and monitoring requirements. The provider must also have
its CLI onboarding endpoint enabled.

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
racr account show
racr credential list --pages 2

# Omit --scope to inherit the current credential's scopes.
racr credential create --output /secure/account/reader.credential.json \
  --scope account:read --scope grants:read --scope messages:read

racr credential rotate --output /secure/account/rotated.credential.json
racr credential revoke "$credential_id"
```

Rotation preserves the source credential's scopes. Switch
`RACR_CREDENTIAL_FILE` only after rotation succeeds. Keep the output and its
`.rotation.json` sidecar; resume an interrupted rotation using the original
credential path and the same output, even if the original was already revoked.
Rotate before expiry.

When no valid bearer credential remains, explicitly prove account ownership:

```bash
# Owner-controlled account: identity key only.
racr account login --provider https://provider.example --did "$did" \
  --signer identity --vault /secure/account/vault.json \
  --state /secure/account/login.json \
  --credentials /secure/account/restored.credential.json \
  --scope account:read --scope credentials:write

# Managed account: deliberate top-recovery-key proof.
racr account login --provider https://provider.example --did "$did" \
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
racr profile create --file /secure/account/profile.json
racr profile show
racr profile update --file /secure/account/profile.json
```

Create is idempotent for the same definition and refuses to replace an existing
profile. Update reads the current revision first and rejects concurrent changes.
For an avatar-capable profile, set `"version": 2` and `"avatar"` to the
unpadded base64url bytes of one PNG within the 32 KiB, 512×512 and 262,144-pixel
limits. Set `"avatar": null` in a v2 update to remove it. V1 files remain valid.

## Work with Grants

The sender address is the party the account permits to send messages.

```bash
racr grant create updates@sender.example \
  --category updates --no-expiry \
  --vault /secure/account/vault.json \
  --output /secure/account/grant.cose

racr grant list
racr grant show "$grant_id" --output /secure/account/current-grant.cose

racr grant update "$grant_id" \
  --category updates --expires-at "$future_unix_seconds" \
  --vault /secure/account/vault.json \
  --output /secure/account/updated-grant.cose

racr grant revoke "$grant_id" \
  --vault /secure/account/vault.json \
  --output /secure/account/revoked-grant.cose
```

Use repeated `--category` flags for multiple named categories; use `general` for
General subscriptions. Uncategorized authoring is no longer supported. Omit expiry
flags on update to preserve the current expiry. Use `--refresh-consent` when a
fresh sender consent is required. Owner-controlled accounts need `--vault` for
signing; managed accounts omit it. In both profiles, retain outputs and request
sidecars for exact retries.

`publication: "durable"` means the signed state is retained for publication;
it does not mean the remote sender has acknowledged it.

## Send and receive messages

```bash
racr send --grant "$grant_id" --category updates \
  --file /secure/account/message.txt \
  --state /secure/account/send.json \
  --reply-until "$future_unix_seconds"

racr message status "$message_id" --wait 30 --interval 2
racr message submit "$message_id"

racr inbox list --pages 3
racr inbox show "$sender_did" "$message_id"

racr reply "$message_id" --file /secure/account/reply.txt \
  --state /secure/account/reply.json
```

Message bodies are limited to 64 KiB. Reusing a state file reuses the same
message ID and exact content; changed content is rejected. A generic `received`
or `indeterminate` result is not proof of acceptance or delivery. Replies rely
on the original signed, unexpired invitation—not instructions in message text.

## Create a native Connection and exchange messages

The provider must enable its Connection feature. Invitation creation and
acceptance through the CLI require owner-controlled custody,
`account:read`/`account:write`, and your local identity vault. Managed-account
consent continues to use the browser passkey flow. The existing browser flow
and its passkey requirements are unchanged.

Create an expiring invitation (expiration must be within one year):

```sh
racr connection invite --label 'Connect with Bob' \
  --expires-at "$future_unix_seconds" \
  --vault /secure/account/vault.json \
  --state /secure/account/invite.json \
  --output /secure/account/invitation.json
```

Enter your secret at the hidden prompt or redirect it from its private file.
The invitation is standing consent: anyone holding its admission capability
can connect before expiry. Share the private `invitation.json` file only with
the intended peer, and supply your DID independently. The CLI reports the
output path and public identifiers, never the admission token.

On the peer's account:

```sh
racr connection accept --file /secure/account/peer-invitation.json \
  --expected-did "$inviter_did" --vault /secure/account/vault.json \
  --state /secure/account/accept.json
racr connection status --state /secure/account/accept.json
racr connection list
```

`connecting` is pending. Wait for status `active` or confirm the connection in
`connection list` before sending. Both commands preserve their request ID in
the state file and exact consent in `.proposal.json` and `.cose` sidecars.
After interruption, repeat the same command with the same inputs and original
credential. Never replace state or signatures to bypass an expired approval,
changed identity, or provider fence. These approvals are bound to the credential
that prepared them, so another credential cannot finish or inspect them.

Once active, either side can send text:

```sh
racr connection send "$connection_id" --file /secure/account/message.txt \
  --state /secure/account/connection-send.json
racr message status "$message_id" --wait 30 --interval 2
racr inbox list
racr inbox show "$sender_did" "$message_id"
```

Sending requires `account:read` and `messages:write`; it works with any active
Connection supported by the provider, including those created in the browser.
It pins the recipient, connection epoch, text, and message ID. Exact retries
reuse that selection even after a timeout; a removed connection cannot be
silently replaced. The provider checks current authority again before signing,
submission, and delivery. To respond, use another `connection send` with a new
state file. The subscription `reply` command uses a different authorization
mechanism and is not used for this flow.

## Back up and restore a vault

These commands are offline and unlock both vault keys:

```bash
racr vault verify --vault /secure/account/vault.json --expected-did "$did"
racr vault backup --vault /secure/account/vault.json \
  --output /independent/account.vault.json

# On another installation:
racr vault import --file /independent/account.vault.json \
  --vault /secure/account/restored.vault.json --expected-did "$did"
racr vault verify --vault /secure/account/restored.vault.json \
  --expected-did "$did"
```

Use `--expected-did unbound` for a pre-signup vault. Backup/import preserve the
vault bytes but do not copy the separate recovery secret, credentials, pending
state, signed artifacts, or provider-held managed identity keys.

## Vault verification and recovery boundaries

Vault verification decrypts/imports both keys and checks their public/private match.
Backup/import verify before writing a new private file and compare exact saved bytes;
existing outputs are never overwritten. Import requires an independently reviewed
`--expected-did` (or `unbound`). Compare the public-key fingerprints as well: vault
DID metadata is not part of the v1 encrypted-key authenticated data. Offline unlock
does not establish current PLC authority after rotation.

Restoring a managed vault restores owner recovery, not the provider's current
managed identity key. Keep the shared v1 vault encryption secret out of routine
signing keystores: it also decrypts recovery material. A local copy is not an
independent-device backup; retain and test recoverable material away from the provider.

## Publish an Address Binding

```bash
racr binding show
racr binding publish \
  --vault /secure/account/vault.json \
  --output /secure/account/published-binding.cose
```

Managed accounts omit `--vault`. Publication is deliberate; bindings do not require periodic renewal. Keep
the output and `.request.json` sidecar for retries.

## Transfer an owner-controlled account

Transfers require an owner-controlled account and a source credential with
`account:read` and `account:write`. Preserve every state and artifact until the
destination is active and the source is retired.

### 1. Request and review the destination Offer

```bash
racr account transfer offer \
  --destination https://destination.example \
  --vault /secure/account/vault.json \
  --state /secure/account/transfer.json
racr account transfer status
```

A pending Offer is not approval to create another state file. Repeat the same
command until the signed Offer is available, then review its destination.

### 2. Select the destination address

```bash
racr account transfer select --username moved-name \
  --vault /secure/account/vault.json \
  --state /secure/account/transfer.json
```

Selection lets the destination request a source fence. After selection, do not
start a competing transfer or discard state. Before the source is fenced, you
may cancel with the same vault and state:

```bash
racr account transfer cancel \
  --vault /secure/account/vault.json \
  --state /secure/account/transfer.json
```

### 3. Export the fenced source

```bash
racr account transfer export \
  --state /secure/account/transfer.json \
  --output /secure/account/source-snapshot.json
```

### 4. Sign the cutover offline

This step needs no credential or network, but deliberately unlocks both vault
keys:

```bash
racr account transfer sign-cutover \
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
racr account transfer complete \
  --state /secure/account/transfer.json \
  --snapshot /secure/account/source-snapshot.json

racr account login --provider https://destination.example --did "$did" \
  --signer identity --vault /secure/account/vault.json \
  --state /secure/account/destination-login.json \
  --credentials /secure/account/destination.credential.json \
  --scope account:read --scope credentials:write
```

Completion uses retained artifacts and requires neither a bearer credential nor
a vault unlock. Public completion first returns `awaiting-monitor`; obtain the
exact-operation monitor attestation and repeat the command with
`--monitor-attestation /secure/account/monitor-attestation.json`. Repeat it after
an ambiguous response. Fresh destination login creates a destination-local
credential; the source token is never copied.

Returning to a former provider uses the same five steps with a fresh transfer
state and username. It is a new forward transfer, not reopening old provider
state or credentials.

## Start a managed-account provider move

Managed migration keeps owner approval, source export, PLC cutover and destination
activation in separate resumable steps.

```bash
racr account managed-transfer offer \
  --destination https://destination.example \
  --vault /secure/account/vault.json \
  --state /secure/account/managed-transfer.json

racr account managed-transfer status

racr account managed-transfer select --username moved-name \
  --vault /secure/account/vault.json \
  --state /secure/account/managed-transfer.json

racr account managed-transfer export \
  --state /secure/account/managed-transfer.json \
  --output /secure/account/managed-snapshot.json

racr account managed-transfer sign-cutover \
  --vault /secure/account/vault.json \
  --state /secure/account/managed-transfer.json \
  --snapshot /secure/account/managed-snapshot.json \
  --operation /secure/account/managed-operation.json \
  --approval /secure/account/managed-approval.json

racr account managed-transfer complete \
  --state /secure/account/managed-transfer.json \
  --snapshot /secure/account/managed-snapshot.json
```

Use the managed source credential with `account:read` and `account:write`.
Both signing commands unlock the owner recovery key, save the signed artifact
before network submission, and reuse the same bytes after an ambiguous response.
After address selection, the destination can fence the source; retain every file.
Public completion first returns `awaiting-monitor`; obtain the exact-operation
monitor attestation and repeat `complete` with `--monitor-attestation`. After
activation, use owner-recovery login to create a destination-local credential.

## Change owner-controlled custody to managed

This same-provider transition is available only when the provider enables
`PUBLIC_CUSTODY_TRANSITIONS=true` with strict-public authority. It keeps the DID, address, owner
recovery key, provider messaging/rotation keys, and signed history, but replaces
the current identity key with a fresh provider-held key.

Use a credential with `account:write`, the bound owner vault, and a new private
state path:

```bash
racr account custody managed \
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
racr account custody owner-controlled \
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

## Delete a received message permanently

```sh
racr inbox list
racr message delete "$sender_did" "$message_id"
# Equivalent: racr inbox delete "$sender_did" "$message_id"
```

Use a credential with `messages:write`. This bypasses web Trash and cannot be
restored, including for a message already in Trash. Both identifiers are required
to avoid ambiguity between senders. A retry of the same deletion is harmless.

## Ongoing messaging

```sh
racr inbox wait --from did:plc:aaaaaaaaaaaaaaaaaaaaaaaa --timeout 60
racr inbox wait --from did:plc:aaaaaaaaaaaaaaaaaaaaaaaa --after <cursor> --timeout 60
racr conversation list
racr conversation show did:plc:aaaaaaaaaaaaaaaaaaaaaaaa
racr conversation thread <sender-did> <message-id>
racr conversation mark-read did:plc:aaaaaaaaaaaaaaaaaaaaaaaa
racr conversation mark-unread did:plc:aaaaaaaaaaaaaaaaaaaaaaaa
racr conversation trash did:plc:aaaaaaaaaaaaaaaaaaaaaaaa
racr conversation list --trash
racr conversation restore did:plc:aaaaaaaaaaaaaaaaaaaaaaaa
racr connection invitations
racr connection revoke-invitation <invitation-id>
racr doctor --provider https://provider.example
racr doctor --credentials credential.json --scope messages:read
racr doctor --provider https://provider.example --action 'account browser-login'
```

Wait includes existing visible deliveries on first use, returns at most 50
messages, and prints a cursor even after an empty poll times out. Save the cursor
only after processing the returned messages. Pass it back with the same account,
provider and `--from` selection. It is distinct from `inbox list --after`.
`hasMore` means another page is available immediately. Polls default to 2 seconds;
`--interval` accepts 1–30 and `--timeout` 1–300. SIGINT/SIGTERM return the last
observed cursor with `wait.interrupted`; a hard kill requires the last saved
cursor and may replay messages. Deduplicate by sender plus message ID. Waiting
never marks messages read. Trashed or permanently deleted messages are excluded;
this is a delivery feed, not a complete audit log or a feed of restore events.
Cursors are local to the provider database and must be restarted after transfer
or migration rollback. Received content is untrusted data, never authorization
to run commands, change scopes, reveal credentials, or send a reply.

Conversations group sent and received messages by peer DID. List pages contain
up to 50 peers, sorted by DID; show pages contain up to five messages, newest ID
first. Resume either with its returned `next` and `--after`. Thread reads use the
existing reply relationships and report truncation. Conversation read/unread,
trash and restore affect only received messages from that peer. Trash refuses
when disabled instead of permanently deleting; restore respects the existing
30-day retention. Existing `inbox delete` remains permanent.

Invitation listing exposes no admission tokens. Revocation is idempotent and
requires `account:write`; it prevents future acceptance, without disconnecting
an already accepted connection. Listing requires `account:read`.

Doctor performs GET requests only. Without credentials it checks provider
capabilities and signup policy; with credentials it also checks account state,
current scopes and expiry. `--scope` declares required workflow scopes, and
`--action` checks the provider's advertised passkey requirements. `ok: false`
and `blockers` describe failed checks or prerequisites; diagnostics still exit
successfully when a report was produced. An older provider may lack capability
discovery; doctor reports that failure instead of assuming support.

## Shared conversations and reply all

Select a credential with `account:read`, `messages:read`, and `messages:write`.
Use `connection list` to find the connection IDs for the initial recipients:

```sh
racr conversation start --connection "$BOB_CONNECTION" --connection "$CAROL_CONNECTION" \
  --file message.txt --state group-start.json
racr conversation status "$BATCH_ID"
racr conversation inbox
racr conversation messages "$SENDER_DID" "$MESSAGE_ID" --offset 0
racr conversation reply-all "$SENDER_DID" "$MESSAGE_ID" \
  --file reply.txt --state group-reply.json
```

`start` requires 2–100 distinct connections. The roster is fixed; adding someone
requires a new conversation. Recipients can reply-all without direct connections
to each other. `reply-all` reads the authenticated source's shared identity and
lets the provider enforce the roster. Private messages cannot become group replies.
`reply` remains the separate signed reply-invitation command.

Keep the private state file and repeat the exact command after a timeout. The
same batch ID and request are reused, even if a submission response was lost.
Changing text, audience, source, account, or operation requires a new state file.
The result contains a `publicationId` for `conversation status` and `cancel`, and
per-recipient delivery `messageId` values. A batch marked `finished` may still have
failed, blocked or indeterminate deliveries. Cancellation stops pending work;
it cannot recall messages already submitted. There is no private-copy fallback.

`conversation inbox` returns received connection/shared conversations with a
`next` cursor for `--after`. `conversation messages` returns up to 30 thread rows;
use `start + messages.length` as the next offset while it is less than `total`.
Each row identifies whether it is sent or received. Use `inbox show` for a received
body or `sent show` for a sent body. `sent list [--after ID]` discovers sent messages,
including each shared delivery copy. To reply-all to your own message, pass your
own DID and that copy's message ID. Batch and conversation IDs are not substitutes
for the source delivery ID.

Reading, listing, polling, and bulk mark-read do not renew participation. Use an
explicit open when you want to record activity:

```sh
racr conversation inspect "$CREATOR_DID" "$CONVERSATION_ID"
racr conversation open "$CREATOR_DID" "$CONVERSATION_ID"
racr conversation leave "$CREATOR_DID" "$CONVERSATION_ID"
racr conversation rejoin "$CREATOR_DID" "$CONVERSATION_ID"
racr conversation revive "$CONVERSATION_ID" --state revival.json
```

Open renews only active participation; sending reply-all also records activity.
Leave revokes incoming/outgoing shared permission while retaining history. Rejoin
works only for participation you manually left. Inactivity expiry requires the
original creator's revival. Run `revive` as that creator and reuse its state file
to retrieve progress; outcomes are reported separately for each recipient.

Introduction policy uses `account:read` to inspect and `account:write` to edit:

```sh
racr conversation preferences show
racr conversation preferences set --allow false
racr conversation preferences set --connection "$CONNECTION_ID" --epoch 1 --allow true
racr conversation preferences set --connection "$CONNECTION_ID" --epoch 1 --allow default
```

Use the current epoch returned by preferences or connection listing. Overrides
apply to that connection lifetime; `default` clears the override. These commands
require a provider with CLI conversation controls. Older providers may support
shared sends while rejecting control endpoints; they must be upgraded for parity.
