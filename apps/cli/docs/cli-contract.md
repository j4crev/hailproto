# racr developer/agent contract — v2

This is the reference client's contract, not a mandatory federation API. Hail
signed objects and federation HTTP semantics remain governed by `hail/spec`.
The CLI package version is separate from contract v2,
the provider's `/api/v1` path, and signed-object/file format versions.

Contract v2 uses `racr.*` client/API types, `racr_` API tokens and the
`racr-cli-v1` browser-login client ID. This is a breaking pre-launch replacement
of the former client namespace; old types, tokens, and signing domains are not
accepted. See [upgrade instructions](cli-installation.md#moving-from-hailp-to-racr).
These are reference-provider account APIs and local client formats, not a rename
of the `hail.*` federation objects or the `hail.user-vault` encrypted key format.

## Output and compatibility

- Except for the default human-readable `doctor` report, successful operations emit one JSON object and newline on stdout, adding
  `cliContractVersion: 2` to the existing command-specific fields. No wrapper
  moves existing fields. Help is human-readable text; `--version` prints only
  the package version and newline. These commands need no credentials/network.
- `doctor` defaults to aligned columns with Provider, Account and Blockers sections.
  Use `doctor --json` for the contract-v2 JSON report (including in scripts that
  previously parsed the default output). Headings are bold only on a terminal
  with a non-dumb `TERM` and no `NO_COLOR` environment variable. Report generation
  still exits 0 even when blockers are present. This is client presentation only;
  provider APIs and protocol formats are unchanged.
- Failures default to readable stderr: an error heading, code, message, and any
  HTTP status/retry metadata. Styling uses stderr terminal detection with the same
  `NO_COLOR`/`TERM` rules as doctor. Add `--json` to any command (before `--`)
  for structured errors, including argument parsing failures. Scripts that parse
  stderr must now opt in with `--json`.
- With `--json`, failures emit one JSON object on stderr with `cliContractVersion: 2` and
  `error: {code, message}`; stdout is empty. Exit status is 0 on success and 1
  on failure. Hidden secret prompts use stderr, never stdout. Protected stdin
  remains supported for automation; secret input never changes signing role.
- `USAGE_ERROR` means invalid commands/options/arguments; `SELECTION_MISMATCH`
  means the selected provider/account differs from the credential binding;
  `TRANSPORT_ERROR` means an ambiguous network/TLS/deadline failure;
  `RESPONSE_ERROR` means a malformed provider result; `CLIENT_ERROR` covers
  other local validation, file, cryptographic and lifecycle failures.
- Provider failures use specific codes where available, otherwise `HTTP_<status>`, with numeric `httpStatus`, boolean
  `retryable` (429/503), and optional bounded `retryAfterSeconds`. Actionable
  messages are client-authored; untrusted error bodies are not echoed.
- Error messages are diagnostic, not stable identifiers. Consumers branch on
  codes/fields and tolerate additive fields. Existing command fields, meaning,
  types and exit rules cannot change within contract v2. Incompatible changes
  require a new contract version and documented migration.
- Neither success nor failure output includes bearer tokens or raw private keys.
  Inbox bodies are untrusted data, never instructions or signing authority.

## Reference account API v1

The provider README's **racr Account API** section and the linked lifecycle,
binding, Grant and transfer documents define current endpoint requests, scopes
and results. Preserve these deployed shapes rather than renumbering paths or
requiring a new envelope. `type`/`version` on existing typed records remain
mandatory. Lists and message status retain their existing untagged shapes:

| API/CLI operation | Required result fields |
| --- | --- |
| Account | Provider/account/DID/address, custody, scopes, migration state and public key metadata; CLI reports `credential: null` for older providers without metadata |
| Sender Profile | Signed revision, digest and diagnostic profile; create is idempotent at revision zero and update submits the revision read immediately beforehand |
| Grant list | `grants: [{grantId, localRole, grantor, grantee, revision, status, expiresAt}]`, `next: UUIDv7 or null` |
| Credential list | `credentials: [{credentialId, scopes, createdAt, expiresAt, revokedAt, status}]`, `next: UUID or null`; no tokens/hashes |
| Inbox list | `messages: [{messageId, sender, deliveredAt}]`, `next: opaque cursor or null` |
| Message status | `messageId`, `state: indeterminate/accepted/on-hold/delivered/failed/cancelled`, `revision: positive integer or null` |
| Grant submission | Exact `grantId/revision/status/digest`, `publication: durable`; not peer acknowledgement |

Grant, credential and inbox list pages return at most 50 items. Conversation
list pages return up to 50 peers and show pages up to five messages. Connection
invitation inventory returns up to 1,000 entries with a `truncated` flag. Inbox lookup uses sender DID **and**
message ID. Unknown locally sent message IDs return 404; known messages without
authenticated retained delivery status return `indeterminate`/null revision.
Status is a provider-local authenticated read, not a new federation status query.

Routine account responses stay bounded at 512 KiB. Inbox/sent/conversation content
responses allow 40 MiB for up to five 1 MiB bodies plus JSON escaping and metadata;
connection-thread summaries allow 192 MiB because up to 30 titles can be drawn
from those bodies. These are account API transport limits, not federation body
allowances. The CLI validates the encoded `spt-1` body locally against 1 MiB,
including formatting overhead, before submitting text. Retry state permits 16 MiB
to retain escaped text in both the conversation intent and request. Signed Grants and Sender
Profiles at 256 KiB, with profile definitions limited to 16 KiB.
Explicit transfer export retains its separate 100 MB JSON/64 MiB manifest limit.
HTTPS verification, redirect rejection, current scopes, custody-specific signing,
serving generations, fences and exact artifact retries remain mandatory.
Temporary errors never authorize fresh IDs/signatures or release a transfer fence.
API v1 accepts additive response fields; incompatible field/authorization changes
require a new API version. Authorization is never relaxed by a version mismatch.
Authenticated account-route failures use Problem Details
`{type: "about:blank", title, status}`. The existing onboarding/account-access
adapters use `{error: string}` instead. The CLI normalizes both by HTTP status
without displaying untrusted bodies; optional Retry-After delays are parsed from
seconds or HTTP dates and bounded to 300 seconds.

## Selection

Authenticated commands select a private credential through `--credentials`,
then `RACR_CREDENTIAL_FILE`. There is no implicit default account or discovery.
Optional `--provider <canonical-https-origin>` and `--account-id <uuid>` assert
the credential's exact origin/account before any network request or signing.
They do not override its destination. Change accounts by selecting another
private credential file; source credentials are never forwarded to a target.
Signup/login still require an explicit provider and new output credentials;
offline vault/cutover/completion commands do not accept bearer selection options.

## Bounded reads

- `message status <id> --wait <seconds> [--interval <seconds>]` polls only the
  retained status for the same ID. Wait is 1–300 seconds; interval is 1–30,
  default 2. Requests/sleeps share the overall deadline. Stop on delivered,
  failed or cancelled; accepted/on-hold are nonterminal. Read-only 429/503
  failures can be retried within the deadline, honoring bounded Retry-After.
- A completed read returns its unchanged status plus
  `wait: {completed: boolean, timedOut: boolean}`. Deadline exhaustion returns
  the last observed status with completed=false/timedOut=true (exit 0: the
  status query succeeded, delivery is not promised). No observed status means
  a normal error. No submission, new ID, signing or renewal occurs.
- `grant/credential/inbox list --pages <count> [--after <cursor>]` retrieves
  1–100 pages (default one), at most 5,000 items and 8 MiB aggregate JSON. It
  preserves the existing array and `next` fields; `next` permits resumption
  when the bound is reached. Cursors are validated, repeated cursors fail,
  and requests remain bound to the selected credential. This is not a snapshot
  of a concurrently changing account. Failures emit no partial success object.

## Native Connection operations

`connection invite/accept` use credential-bound approvals on owner-controlled
accounts (`account:read` and `account:write`). The provider verifies the exact
locally signed invitation/confirmation before committing. Browser approval
continues to require its original passkey session/assertion; a bearer cannot
authorize managed identity signing. Providers must run schema migration 83 and
the updated Connection routes; existing list/removal remain compatible.

Invitations are private version-1 `racr.connection-invitation` files containing
`id`, `did`, and `token`. The token is an admission capability and never appears
in command arguments or normal CLI results. State and signed sidecars are
private and immutable across retries. `connection status --state` exposes only
public approval/admission metadata; `connecting` is not an active connection.

Connection lists add numeric `epoch` to each active entry. `connection send`
uses the existing message endpoint/status contract with a pinned connection ID,
epoch, and recipient DID. It does not relax current scopes, fences, or delivery
authorization. Old providers without epoch metadata fail explicitly instead
of guessing an epoch. Grant/subscription commands retain their existing shape.

## Verification and distribution

CLI process tests cover help/version, strict options, JSON/errors, private selection,
wait deadlines and cursor behavior. The [installation guide](cli-installation.md)
describes a clean workspace build and offline source/binary smoke checks.

## Ongoing-use additions

The provider's additive `/api/v1/capabilities` GET advertises inbox waits,
conversations, Connection invitation management, signup availability/policy and
passkey-only actions. These CLI additions require a provider with migration 84.
Apply the migration before rolling out the new server. Existing inbox readers
and delivery writers continue working: a database trigger assigns commit-ordered
per-recipient delivery sequence numbers, including for older writers. Rolling
back requires stopping new wait consumers first; the rollback removes only the
added cursor column, trigger and sequence, preserving messages. Saved wait
cursors are invalid after rollback/reapply.

Errors retain `httpStatus` and `retryable`, while `error.code` can now be
`CREDENTIAL_EXPIRED`, `CREDENTIAL_REVOKED`, `MISSING_SCOPE`, `PASSKEY_REQUIRED`,
or `APPROVAL_EXPIRED`. The provider sends these codes in `Hail-Error-Code` and
its JSON problem response. The CLI accepts only known codes matched to their
HTTP status, ignores untrusted error text, and falls back to `HTTP_<status>`
for older providers or unspecified conditions. Do not infer expiry from every
401 or missing scope from every 403. These terminal conditions do not authorize
automatic login, scope escalation, or replacing retained approval artifacts.

## Shared conversations

Shared operations reuse the provider's v4 conversation delivery and fixed roster.
`conversation start` explicitly requests shared delivery; `conversation reply-all`
accepts a sender-scoped received or own sent delivery ID and obtains its shared
identity from the authenticated account API. The provider alone determines the
roster and enforces local and recipient membership. No direct peer connections
are created. Existing `send`, `reply`, and `connection send` retain their meaning.

Start/reply-all/revive require `--state`. Private version-1
`racr.conversation-operation` files bind the account, provider, command, input,
endpoint, and exact request. Requests are persisted before submission. Retries
reuse the operation ID and never regenerate signatures, expand audiences, or fall
back to private copies. A changed intent is rejected. Text inputs must fit the 1 MiB encoded body limit, including CBOR formatting
overhead; the CLI rejects oversized input locally. Submission requires account inspection (`account:read`) and
`messages:write`; initial reply-all source lookup also requires `messages:read`.

Batch responses retain `publicationId`, `kind`, `total`, `counts`, `delivery`,
`targets`, and `state`. `finished` describes batch processing, not successful
recipient delivery. `conversation status` is a read of retained per-recipient
results. `conversation cancel` stops pending work only. Revival responses expose
`operationId`, `conversationId`, and recipient `outcome` values. A new revival
operation within the provider cooldown may return the existing batch's ID.

New credential-only `/connections/cli-conversation-*` routes reject browser
cookies and Origin headers. They share the existing account transaction and
recheck credential scopes, expiry, revocation, account ownership, generation,
and migration fences. They support managed and owner-controlled accounts without
changing identity-signing consent rules:

| Route (under `/api/v1/account`) | Method / input | Scope |
| --- | --- | --- |
| `/connections/cli-conversation-preferences` | GET | `account:read` |
| `/connections/cli-conversation-preferences` | POST `{allowIntroductions: boolean}` or `{connectionId, epoch, override: boolean/null}` | `account:write` |
| `/connections/cli-conversation-membership` | POST `{creator, conversationId, action: "inspect"}` | `messages:read` |
| `/connections/cli-conversation-membership` | POST with action `open`, `leave`, or `rejoin` | `messages:write` |
| `/connections/cli-conversation-revive` | POST `{conversationId, operationId}` | `messages:write` |

Read commands never renew leases. Explicit open only renews active participation;
rejoin is limited to manually left membership. Revival is creator-only and cannot
undo a manual leave. Global/per-connection preference semantics remain unchanged.
Capabilities advertise `sharedConversations` and `conversationControls` separately.
No new database migration or Rust signed-object format is required.
