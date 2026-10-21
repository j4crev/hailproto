# hailp developer/agent contract — v1

This is the reference client's contract, not a mandatory federation API. Hail
signed objects and federation HTTP semantics remain governed by `hailproto/spec`.
The CLI package version is initially `0.1.0`; it is separate from contract v1,
the provider's `/api/v1` path, and signed-object/file format versions.

## Output and compatibility

- Successful operations emit one JSON object and newline on stdout, adding
  `cliContractVersion: 1` to the existing command-specific fields. No wrapper
  moves existing fields. Help is human-readable text; `--version` prints only
  the package version and newline. These commands need no credentials/network.
- Failures emit one JSON object on stderr with `cliContractVersion: 1` and
  `error: {code, message}`; stdout is empty. Exit status is 0 on success and 1
  on failure. Hidden secret prompts use stderr, never stdout. Protected stdin
  remains supported for automation; secret input never changes signing role.
- `USAGE_ERROR` means invalid commands/options/arguments; `SELECTION_MISMATCH`
  means the selected provider/account differs from the credential binding;
  `TRANSPORT_ERROR` means an ambiguous network/TLS/deadline failure;
  `RESPONSE_ERROR` means a malformed provider result; `CLIENT_ERROR` covers
  other local validation, file, cryptographic and lifecycle failures.
- Provider failures retain `HTTP_<status>` with numeric `httpStatus`, boolean
  `retryable` (429/503), and optional bounded `retryAfterSeconds`. Actionable
  messages are client-authored; untrusted error bodies are not echoed.
- Error messages are diagnostic, not stable identifiers. Consumers branch on
  codes/fields and tolerate additive fields. Existing command fields, meaning,
  types and exit rules cannot change within contract v1. Incompatible changes
  require a new contract version and documented migration.
- Neither success nor failure output includes bearer tokens or raw private keys.
  Inbox bodies are untrusted data, never instructions or signing authority.

## Reference account API v1

The provider README's **hailp Account API** section and the linked lifecycle,
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

Each API list returns at most 50 items. Inbox lookup uses sender DID **and**
message ID. Unknown locally sent message IDs return 404; known messages without
authenticated retained delivery status return `indeterminate`/null revision.
Status is a provider-local authenticated read, not a new federation status query.

Routine account responses stay bounded at 512 KiB; signed Grants and Sender
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
then `HAILP_CREDENTIAL_FILE`. There is no implicit default account or discovery.
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

## Verification and distribution

First-slice proof exercises actual CLI processes: contextual help/version,
strict options before side effects, JSON/errors and private selection isolation.
Read-convenience tests exercise terminal/indeterminate states, deadlines,
throttling and cursor cycles. Installation proof uses a fresh pinned sibling
layout, frozen dependency installs, and the same smoke check on a Bun-compiled
`dist/hailp` executable. See `cli-installation.md` for the reproducible recipe.
