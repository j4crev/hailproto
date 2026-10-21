# Credential inventory, narrower issuance and rotation

This API-plus-CLI slice is deployed to both POC providers as part of the
[migration-34 lifecycle release](lifecycle-release.md). Inventory, scoped issuance
and rotation use the existing credential schema; the separate
[post-expiry login/recovery slice](account-access-recovery.md) adds migration 34
and an opt-in private-PLC gate. Both are verified on each real HTTPS endpoint.

## Contract

- `GET /api/v1/account/credentials?after=<UUID>` requires `credentials:write`.
  Inventory is scoped to the authenticated account, ordered by ID and capped at
  50 items with a `next` cursor. Each item has `credentialId`, `scopes`,
  `createdAt`, `expiresAt`, `revokedAt` and `status` (active/expired/revoked).
  No token or hash is selected or returned. Fenced accounts may inventory retained
  credentials, but cannot issue/revoke through the existing write path.
- `POST /api/v1/account/credentials` retains `{token}` inherited issuance and
  `{revoke}` revocation. The additive `{token, scopes}` shape selects a nonempty,
  duplicate-free subset of the caller's six known permissions. Unknown/invalid
  scope input returns 400; requested authority outside the caller's scope returns
  403. Read-only credentials lack `credentials:write` and cannot issue credentials.
- Stored token reuse requires the same account, still-active credential and
  exact scope set (order-independent). Changed-scope, cross-account, revoked or
  expired retries return 409; they do not update a credential or its expiry.
- Credentials still expire 30 days after issuance. Inherited issuance is not a
  parent/child revocation tree; revoking a parent does not implicitly revoke its
  existing children. Explicit delegation of `credentials:write` grants account
  credential management within the scoped rules, not merely read access.
- `GET /api/v1/account` adds `credential: {credentialId, expiresAt}` for the
  authenticated token, never its secret/hash. The client accepts older responses
  without that field as `credential: null`; safe rotation requires the metadata.

CLI: `hailp credential list [--after <UUID>]` and `hailp credential create
--output <new-private-file> [--scope <permission> ...]`. Omitted scope flags
inherit; explicit repeated flags select permissions. Request state saves the
token, account/provider and exact scopes before issuance. Retries reuse that
state, validate the acknowledgement and atomically finish the credential file.
Results show ID/path/scopes/expiry, never the secret. Old pending token-only files
keep their token and gain the reviewed scope state before retry; server and
acknowledgement checks reject mismatched prior issuance.

When the selected scopes equal the caller's current inherited set, the client
sends the old `{token}` request shape for deployed-provider compatibility.
Narrower scope requests and inventory require this new provider slice; there is
no fallback that silently widens a requested credential.

## Resumable rotation

`hailp credential rotate --credentials <original-file> --output <new-file>`
inherits the original credential's exact scope set. It requires both account
reading and credential management authority; it never unlocks identity/recovery
keys or changes custody. It reuses issuance, account reading and revocation,
with no new endpoint or schema migration.

Before issuance the command saves one new secret and a bound private sidecar at
`<new-file>.rotation.json`. It then creates the replacement using that exact
token/scopes, verifies it authenticates for the selected account, saves the
complete credential record, and revokes the original **using the replacement**.
Scope changes and unrelated pre-existing outputs are rejected. Keep the original
file and both new artifacts for retries; the original file is never overwritten.

The sidecar precedes the output file so a pre-issuance crash can recreate the
missing pending file without minting another secret. Pending credential files
have the normal type/version/provider/account/token shape, allowing an already
issued replacement to authenticate after a lost acknowledgement. Authenticated
account metadata recovers its exact ID/expiry without returning its secret.
Revocation is idempotent, so a fresh process can finish after its successful
response was lost even though the old token is now revoked.

An incomplete rotation may temporarily leave old and new credentials active;
resume with the original source path and the same output. A revoked/expired
replacement is terminal and is not silently replaced. An expired original cannot
start/finish issuance; an already issued active replacement can finish revocation
without old-token authentication. Migration fences stop progress. This is
authenticated rotation while access still exists, not post-expiry owner login.

## Regression proof

The existing real-HTTPS CLI/PostgreSQL integration fixture now checks:

- Explicit read-only issuance and order-independent exact retries.
- A lost HTTPS response **after the database commit**: pending private state
  retains the original token/scopes; retry returns the same stored credential ID.
- Changed flags do not overwrite a completed credential file.
- Read-only credentials cannot inventory/issue; delegated managers cannot add
  missing scopes, including by reusing a broader existing token.
- Empty/duplicate/unknown/non-array scopes, mixed revoke/issue inputs, duplicate
  JSON keys, content encoding and invalid inventory queries are rejected.
- Cross-account token reuse, expired/revoked token reuse and foreign-account
  inventory disclosure are rejected.
- Bounded pagination over more than 50 credentials is complete and duplicate-free;
  active/expired/revoked metadata includes neither tokens nor token hashes.

Focused command (against a fresh disposable local database):

```bash
DATABASE_URL=<private-local-test-database-url> bun --bun vitest run \
  test/credential-rotation.integration.test.ts \
  test/account-api.integration.test.ts test/self-service.integration.test.ts
```

Rotation adds real HTTPS CLI process-restart checks for interruption before
issuance (including recovery with only the sidecar), lost issuance/revocation
responses, scope/ID/expiry preservation, private files and source-file retention,
read-only/expired sources, conflicting outputs, cross-account state, expired/
revoked replacements and a new source fence. Both custody signup fixtures also
rotate/retry without changing keys, custody or PLC operations.
Older account responses without current credential metadata are accepted for
reads but cannot start rotation or write state. An issued replacement can finish
rotation after the original expires; the original is never authenticated/revived.

October 9 results: the focused gate passed **12 PostgreSQL/HTTPS integration
tests**, including both custody signup cases and three rotation cases. Client
tests passed **5 tests**. The provider suite without database environment passed
**108 tests**, with **57 database integrations skipped**; the focused gate proves
the changed paths, not all 57 integrations. Provider/client typechecks,
builds and `git diff --check` passed. Runtime tests use Bun so `Bun.spawn` and
PostgreSQL integrations execute. The disposable database was removed afterward.
