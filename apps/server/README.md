# Hail Server TypeScript

Reusable Bun and Hono provider implementation for Hail Protocol.

This repository is under active development. Use the
[single public-provider deployment profile](deploy/public/README.md) for a new
strict-public provider.

## Current alpha and guides

The public alpha runs three strict-public providers against canonical
`plc.directory`. Independently hosted `haili.app` has a permanent
owner-controlled canary and enables public provider transfer; the disposable
`hailproto.app` and `hailproto.dev` providers share another VPS and keep transfer
disabled. All three completed monitored onboarding, Sender Profile publication
and reciprocal Grant delivery. The private-PLC POC remains available for
destructive transfer/recovery rehearsals.

- [Single public-provider deployment profile](deploy/public/README.md).
- [User-device vault/signing client](https://github.com/j4crev/hailproto/tree/main/apps/cli#readme).
- [Transfer/recovery checkpoints](https://github.com/j4crev/hailproto/blob/main/apps/cli/docs/custody-transitions.md#post-export-abandonment-and-recovery).
- [Public monitor deployment](https://github.com/j4crev/hailproto/blob/main/apps/plc-monitor/deploy/public/README.md).

Original private Alice/Bob identities remain historical POC fixtures. The public
canaries are real `plc.directory` identities and must not be reused as production users.

## Provider administration

### Provider operator dashboard

Migration 74 adds explicit, provider-local operator grants and invitation history.
Sign in with a passkey and open `/admin` (also linked from the sidebar for
operators). Create a private signup link or enter an email address to send it.
The latest 100 dashboard invitations show email-service acceptance, signup
admission, completion and expiry. Email acceptance does not prove inbox delivery.
Invitations remain seven-day, single-use bearer capabilities: the recipient
address is a delivery destination, not an identity restriction.

Use `admin@your-domain` for administration and keep `ops` for operational mail.
No address automatically receives privileges.

**Starting from nothing? Follow [First provider administrator: vault to dashboard](../../docs/provider-admin-setup.md).**
It gives the exact order: generate/back up a local vault → extract its public
recovery `did:key` → authorize the reserved name → complete monitored CLI signup
→ enroll a passkey → grant operator access → log in at `/admin`. The `did:key`
is generated locally; it is not something you need to know in advance. The
guide defines your deployment values, uses absolute local CLI paths, and includes
complete public-file upload, monitor enrollment, attestation download and final
operator-grant commands. Each block identifies the machine where it runs.
Successful passkey login alone is not sufficient: the final operator grant is
required before `/admin` stops returning 403.

Any existing active local account with a passkey can instead receive the explicit
grant; a separate admin account is a recommendation, not a protocol requirement.
Remove access with `bun src/cli/provider-operator.ts revoke admin@your-domain`.
Revocation is checked on each request. Account movement/generation changes require
an explicit new grant; operator authority is not portable. Existing invitations
remain valid until consumed or expired, including after operator revocation.

The API is `GET/POST /api/v1/operator/invitations`. It requires the trusted browser
Origin and a passkey session cookie, never an account API bearer. POST additionally
requires login within ten minutes and JSON `{id: <UUID>, email: <address or null>}`.
Keep the same ID and email when retrying. Creation is capped at 100 invitations
per hour; requests are limited to 30 per operator per minute. Invitation bearers
are reconstructed for creation responses, not stored in invitation history or
logged. Rotating the signing key invalidates outstanding unadmitted invitations.

Enable the existing public alpha signup, passkeys, GUI and signup email service.
Deploy the updated email Worker before using email invitations; its authenticated
`/signup-email/invite` endpoint uses the existing `SIGNUP_EMAIL_TOKEN`, sender and
pinned `SIGNUP_ORIGIN` (which must equal the browser/passkey origin). Other server
implementers can supply that same small email-service contract. No new email
vendor or client-visible service credential is required.

The Worker deduplicates requests and limits each destination to five invitations
per hour and the service to 100 per hour. An ambiguous send failure stays
unconfirmed and is not automatically sent again. Check with the recipient before
creating another invitation. History has no bearer-retrieval or revocation UI in
this initial slice. Rollback removes migration 74's operator grants and invitation
history; take a backup first. It does not invalidate already issued signed links.

### Reserved provider addresses

Migration 60 automatically reserves `ops`, `alerts`, `abuse`, `security`,
`support` and `admin` on every served domain before registration opens. These
are name reservations, not accounts: no DID, private keys, credentials or
administrative privileges are created. Database enforcement also blocks incoming
transfers from claiming these names. Public address checks report them unavailable.

To activate a role, first generate and back up its owner's recovery key on the
owner's device, then authorize its **public** key locally as the provider operator:

```bash
bun run account:role-authorize -- ops@example.com did:key:z...
```

Complete the normal public onboarding ceremony with that address and recovery
key, including owner-signed genesis and monitor verification. The assignment is
idempotent for the same key and refuses reassignment. The generic browser address
picker deliberately keeps role names unavailable; use the public CLI onboarding
flow for these accounts. Keep unused roles reserved rather than bootstrapping them.

Upgrades preserve existing accounts and warn about occupied role names for manual
ownership review; they never take over or rename an account. Reservation does not
configure email forwarding. Keep an off-provider email path for outage alerts.

## hailp Account API

Migration 32 adds the authenticated account-management slice used by
`hailp` in [`../cli`](../cli). It is separate from provider administration and
federation. The credential commands below are an API reference, not additional
steps required after completing the administrator setup guide.

### Bootstrap credentials (provider operator)

```bash
bun run account:credential-create -- "$active_address" /secure/api.credential.json
# Add --write-grants for signed Grant submission/revocation:
bun run account:credential-create -- "$active_address" /secure/writer.credential.json --write-grants
bun run account:credential-revoke -- "$credential_id"
```

The issuance command writes the secret only to a new mode-`0600` file and
prints credential ID/account/scopes/expiry, not the token. Transfer the file
privately to the owner for CLI use. The database stores SHA-256 of a random
256-bit token; credentials have a fixed 30-day expiry and can be revoked.
Default scopes are `account:read` and `grants:read`; the write option adds
`grants:write`. No credential is issued for an inactive or fenced account.
Authentication is checked against current credential/account state for each
request; revocation prevents new authentication, rather than cancelling an
already admitted in-flight request. Credentials are provider-local and are
not exported in portable DID snapshots. Provision a fresh credential at the
destination after transfer.

### HTTP contract

The frozen [PLC read-evidence policy](https://github.com/j4crev/hailproto/blob/main/spec/plc-read-evidence.md)
strengthens the public cutover library with complete canonical/audit agreement,
explicit reader/operator configuration, reviewed monitor bootstrap
evidence and five-minute freshness. Use `createIndependentPlcObserver(origin,
operator)` and pass the reviewed source/destination operator IDs as the fourth
`PortableCutoverGate` constructor argument. Legacy v1 monitor reports, private
registration evidence and private-Poc observation promotion cannot authorize
public cutover. The private POC path retains its separate gate. Migration 44 adds
an opt-in public signup route, now exercised by all three live alpha canaries.

Migration **40** adds full immutable public cutover evidence and a separate
selection sealed by the activation transaction. Both reader histories/documents,
canonical operation bytes, bootstrap state and exact monitor proof are retained
in an 8 MiB bounded content-addressed bundle; no credentials/private keys/message
bodies are included. Public activation/active retries require the exact retained
correlation, and older digest-only public writers cannot activate on the expanded
schema. Existing private-POC paths and signed row shapes are preserved. The guarded
`migrations/rollback/0040_public_cutover_evidence.sql` refuses rollback after any
new proof is retained; older public activations are not retroactively supplied
with fabricated evidence.

Migration **41** adds an opt-in routine `strict-public-v1` resolver and immutable
resolution/envelope-authority history. It defaults to one canonical
`https://plc.directory/log/audit` read, replays the complete DID history locally,
tries explicitly configured replicas only as availability fallbacks,
and persists the selected read bundle before returning keys. Inbound envelope admission binds both
authority digests to the exact signed representation atomically; stale (>30 s),
mixed or mismatched evidence cannot enqueue work. Other services use the same
resolver. Migrations 42-43 add action-bound Grant, binding, profile and status history.

```dotenv
PLC_DIRECTORY_URL=https://plc.directory
PLC_AUTHORITY_PROFILE=strict-public-v1
PLC_PROVIDER_OPERATORS=["provider-operator"]
```

`PLC_PUBLIC_READERS` is optional. When omitted, the canonical directory is the
only read source. When present, its declarations are configuration metadata, not
independently verified operators/hosts.
The supported read-replica API may return either `application/did+json` or
`application/did+ld+json`. A selected noncanonical replica must expose a
`/_health` `lastCommittedOpTime` to be within five minutes. Canonical health does
not claim replica freshness; the bounded audit read is validated directly. To exercise both
currently known public replica implementations with a public Hail-profile DID:

```bash
PUBLIC_PLC_SMOKE_DID=did:plc:... bun run test:plc-live
```

One to three ordered reader/operator declarations may be configured; declarations
must be distinct and outside the provider. Absence
of the authority profile preserves the POC baseline; orphaned/invalid public
declarations are refused. Use one consistent runtime for all serving/worker/tools
when enabling strict authority; existing public writers do not gain verified
evidence merely because schema 41 is installed. Normal operator CLIs and address
discovery share the factory; private-POC runtime paths retain their registry guard.
The server checks configured reader health every five minutes and logs only the
initial result and state changes. Set `PLC_READER_DIAGNOSTIC_DID` to a public
Hail-profile DID to also log reader state disagreement; leave it unset until a
reviewed public canary exists.
The legacy custodial operator onboarding tools have been removed. Set
`PUBLIC_SELF_SERVICE_ONBOARDING=true` only with the strict profile to enable the
migration-44 owner-key/monitor HTTP ceremony; do not also enable the private POC
signup flag.

Migration **44** retains public preparations separately from private-POC records.
The owner signs the exact genesis with top recovery authority; registration writes
only to `https://plc.directory`, reconciles ambiguous responses, and returns the exact
DID/CID for reviewed monitor enrollment. A retry carrying the genesis-specific monitor
attestation atomically seals custody, fresh validated reader evidence, selected binding and
activation before issuing credentials. Guarded rollback refuses retained preparations
or evidence. This is implementation evidence, not proof that configured readers,
monitor, backup or alert infrastructure are independently operated.

`migrations/rollback/0041_public_plc_authority.sql` permits rollback only before
new evidence is retained and without later migrations. Histories reference stable
IDs rather than volatile working rows, but their transport in a future signed
snapshot remains a separate profile change. Current reported PLC authority is
not recovery-window finality or proof of owner intent. See the
[routine authority policy and boundaries](https://github.com/j4crev/hailproto/blob/main/spec/plc-read-evidence.md#routine-strict-public-v1-authority).

The consolidated [reference account API v1 / hailp CLI contract](https://github.com/j4crev/hailproto/blob/main/apps/cli/docs/cli-contract.md)
defines compatibility, output/error semantics and bounded read convenience.
The client version is 0.1.0 and its JSON adds `cliContractVersion: 1`; provider
response shapes and API paths remain unchanged. Command-specific help, deliberate
origin/account assertions and a compiled executable are documented in the
[developer workflows](https://github.com/j4crev/hailproto/blob/main/apps/cli/docs/cli-workflows.md#developer-and-agent-operation-contract-v1).

Use `Authorization: Bearer <token>` over the configured provider HTTPS origin.
These paths are the reference provider's client API, not standardized Hail
federation operations:

| Operation | Scope | Result |
| --- | --- | --- |
| `GET /api/v1/account` | `account:read` | Own account/DID/address, custody classification, public identity/recovery metadata, migration state and scopes |
| `GET /api/v1/account/profile` | `account:read` | Current signed Sender Profile revision, digest and exact COSE bytes |
| `POST /api/v1/account/profile` | `account:write` | Idempotently create or optimistic-revision update an explicit Sender Profile definition |
| `GET /api/v1/account/senders/{did}/profile` | `messages:read` | Freshly verified current sender profile, digest and exact COSE bytes for inbox presentation |
| `GET /api/v1/account/grants/{grant_id}` | `grants:read` | Own authoritative or received Grant, local role, exact base64url COSE bytes, digest and ETag; the CLI renders diagnostic JSON locally |
| `PUT /api/v1/account/grants/{grant_id}` | `grants:write` | Verify/store an initial or terminal user-signed Grant; JSON acknowledgement of revision/status/digest and durable publication responsibility |

Haili's Sent history uses `GET /api/v1/account/sent?include=sends` (`messages:read`).
It returns five sends per page with an opaque `next` cursor for `after`. Each item
contains `messageId`, `kind` (`category`, `connections`, or standalone `message`),
`category`, `createdAt`, and `body`. Category publications and connection batches
appear once after their first envelope is created; cancelled or expired batches
with no envelopes do not appear. Separate sends with identical bodies stay separate.
Read an item with `GET /api/v1/account/sent/{messageId}?kind={kind}`. These views
omit recipient addresses and delivery status. The existing per-envelope Sent APIs
remain available for delivery diagnostics and retries. Grouping uses retained local
batch records; envelopes without those records remain standalone entries.

Browser subscription approval accepts `expiresAt: null` for an ongoing subscription
that ends when revoked. Fixed expiries must still be in the future and within one
year. Haili labels the ongoing option “Until I unsubscribe”.

PUT uses `application/cose; cose-type="cose-sign1"`, no content coding, and a
256 KiB body limit. The signature/predecessor supplies update authority; this
account endpoint does not reuse the peer receiver's HTTP precondition contract.
Successful PUT returns `200` only after persistence. `publication: "durable"`
does not imply sender acknowledgement; exact retries do not create a new job.
Other accounts' Grant IDs return `404`; insufficient scope `403`; missing,
expired, revoked or inactive-account credentials `401`. Invalid signed input
returns `400`, state/fence/revision conflicts `409`, transport violations
`413`/`415`, and temporary dependency/storage failure `503`.

Responses use `Cache-Control: no-store` and `Vary: Authorization`; private keys,
credential values and hashes are never included. Custody classification is
reported from existing stored evidence/key roles, not proof of physical key
custody or an implementation of the planned managed profile. Fenced reads
can show retained history; writes remain blocked. The first process-wide
limit is 120 account API requests per minute, returning `429`/`Retry-After`;
distributed limits and production load calibration remain future hardening.

### Verification

The opt-in test exercises actual `hailp` processes against a local TLS Hono
server using a temporary CA trusted through `NODE_EXTRA_CA_CERTS` (never
disabled certificate verification). It requires OpenSSL and a disposable
PostgreSQL database:

```bash
DATABASE_URL=postgresql://hail:password@127.0.0.1:5432/hail_api_test \
  bun --bun vitest run test/account-api.integration.test.ts
```

It covers credential bootstrap/hashing, signed import, account/scope isolation,
collocated read-only ownership, invalid signatures, resource bounds, fences,
lost-response revocation retry, expired/revoked credentials and rejection of
redirects/insecure credential files. The user signer and vault remain outside
the provider; no user identity private key is stored there.

### Owner-controlled transfer Offer/status/cancellation (local milestone 5)

`POC_SELF_SERVICE_TRANSFER=true` enables a reference account-API slice only on
the pinned private PLC profile. It is deployed to both migration-39 POC hosts.
It reuses the existing signed invitation, destination-origin Offer
delivery and no-fence cancellation services:

| Operation | Scope | Result |
| --- | --- | --- |
| `GET /api/v1/account/transfers` | `account:read` | Source-retained phase, nonce/destination/expiry, origin confirmation and exact Offer |
| `POST /api/v1/account/transfers/offer` | `account:write` | Retain exact owner-signed approval, attempt existing invitation delivery, return current status |
| `POST /api/v1/account/transfers/cancel` | `account:write` | Retain exact owner-signed pre-fence cancellation and return source-signed receipt/public messaging key |
| `POST /api/v1/account/transfers/export` | `account:write` | Export/retrieve an immutable source-signed snapshot for the exact authenticated fenced/exported transfer ID |

Mutations accept an exact JSON `{payload, signature}` base64url record with no
content coding, at most 16 KiB wire/4 KiB signed payload. The authenticated
account must be active, publicly verified and owner-controlled, without a
provider-held identity key or managed custody evidence; the current database
credential must retain write scope. The signed subject must match that account.
Any source fence blocks Offer/cancellation mutations. Export explicitly requires
a matching fenced/exported transfer, never a fresh or retired source, and advances
the source to exported through the existing snapshot service. Its request is
`{transferId}`; its result is the existing `hail.portable-migration-transfer` v2
container, with a manifest bounded at 64 MiB and no private provider key material
or exported account credentials. Retrying after a lost response returns the exact
stored signed snapshot. Status remains a read of retained state,
including unresolved expiry and cancelled/fenced/exported/retired history.

Offer preparation does not select an address or fence the source. The client now
uses the existing signed destination reservation endpoint for `transfer select`,
which can fence the source, with exact retained retries. No source
bearer is sent there. The source cancellation endpoint returns a no-fence receipt;
the client retains it and forwards signed evidence to the existing destination
cancellation endpoint, reporting completion only after target acknowledgement.
The client's offline `transfer sign-cutover` now reuses the full-vault private-POC
signer, binding exact operation/consent/binding output paths in retained state.
`transfer complete` now uses private-POC signed completion/retirement endpoints
to stage, submit the exact PLC operation, publish/verify the binding, activate and
retire. Destination credentials use the existing explicit owner-login API; source
tokens are not exported or forwarded.

| Reference private-POC operation | Authorization | Result |
| --- | --- | --- |
| `POST /.well-known/hail/transfers/completions` | Exact source snapshot plus owner-signed consent/operation/binding | Stage or resume exact retained artifacts, submit cutover, verify address and activate; signed activation receipt |
| `POST /.well-known/hail/transfers/retirements` | Destination-signed activation receipt verified against current PLC and source fence | Exact idempotent source retirement, HTTP 204 |

Both endpoints require `POC_SELF_SERVICE_TRANSFER=true` on the pinned private PLC
profile and `application/hail-transfer+json`, without content coding. Completion
accepts `{snapshot, consent: {payload, signature}, operation, binding}` with
base64url operation/binding bytes, at most 100 MB JSON and a 64 MiB manifest;
retirement accepts an exact `{payload, signature}` receipt within the existing
16 KiB wire/4 KiB payload limits. These are reference-provider adapters, not new
standardized federation operations. Existing transfer rate limits apply.

First staging revalidates current source PLC, user consent, source signature,
reserved address and destination key ownership through existing services. Known
staged/active imports resume only when all signed artifacts match retained bytes,
including consent/signature and binding. This preserves retries after PLC movement
and accepted consent expiry; an expired consent cannot initiate a fresh PLC write.
An already observed exact operation can recover its response without a new write.
Active retries revalidate current destination authority and recover the exact
signed activation receipt. Source retirement verifies that receipt against current
destination PLC authority and the exported snapshot, retaining it durably. A failed
step never releases the source fence or reservation. No user private key or bearer
credential is accepted as replacement for these signatures.
See the [client workflow](https://github.com/j4crev/hailproto/blob/main/apps/cli/docs/cli-workflows.md#owner-controlled-transfer-offer-review-and-source-cancellation).

`test/transfer-cancellation.integration.test.ts` covers authenticated route
scope/account isolation, exact Offer retries, unresolved expiry, source fences,
credential revocation and signed cancellation receipt/status, including client
retry after a lost target cleanup acknowledgement. The private-POC migration test
now exercises client Offer/selection with actual protocol routes and PostgreSQL,
including lost selection and export responses after durable source transitions,
before proving actual `hailp` exact cutover signing, legacy signer compatibility,
API-driven completion/retirement and fresh destination login. Changed signing
paths and tampered snapshots fail. Completion covers address verification failure,
expired-consent fresh-write rejection, lost PLC/activation/retirement responses,
exact active retries after consent expiry and changed-artifact rejection. Adjacent
fence/transfer tests retain message/status/outbox continuity proof.
These new transfer tests use in-process
HTTP route transport; the account-API TLS tests cover HTTPS CLI transport.

The [milestone-5 custody/return design](https://github.com/j4crev/hailproto/blob/main/apps/cli/docs/custody-transitions.md)
defines owner-controlled ↔ managed transitions, removal of outgoing managed
identity authority, historical evidence and lifecycle generations. These paths
remain disabled. Current DID-keyed fences/account uniqueness and insert-only
activation do not support returning to a former provider. Post-export import
invalidation alone cannot cancel a signed PLC operation; the design requires
protective owner-signed PLC state before never-active source resumption, or a
latest-state reverse transfer after destination activation.

### Serving/history foundation (local migration 36)

Migration 36 adds separate generation-1 account metadata and append-only retired
transfer history. It changes no existing signed/account/credential row shape;
old v2 snapshot imports and bearer authentication remain compatible. Existing
retired transfers are backfilled, and future retirements archive exact
fence/export/consumed-authorization records in the same transaction. History
survives working-row cleanup and rejects update/delete/truncation or conflicting
archival retries. A matching retained export is required for retirement.

Generation advancement is deliberately constrained to `1` until credentials,
challenges and all admitted/leased workers enforce generation ownership. This
does not by itself enable return transfers or release any source fence. It is
deployed as part of the migration-39 release; migrations 37/38 provide the later
reviewed generation-advancement path.

The guarded rollback script is
`migrations/rollback/0036_serving_lifecycle_history.sql`. It requires no later
migration and exact redundancy with all legacy fence/export/authorization rows
before dropping only the additive schema. It refuses to discard the sole archive
copy. Upgrade/repeat/rollback/re-upgrade preservation and legacy import/auth checks
pass alongside actual signed retirement archival and adjacent transfer/access
regressions: 32 focused tests on disposable databases. See the
[migration evidence and next stage](https://github.com/j4crev/hailproto/blob/main/apps/cli/docs/lifecycle-history-migration.md).

### Generation-bound return (local migrations 37/38)

Migration 37 binds credentials, owner-login challenges and worker lease tokens
in side tables without altering signed v2/account/challenge shapes. Native
transaction-local admission is checked before SQL reads and at the existing
account-row write guard. HTTP and worker entry points retain their admitted
generation through asynchronous work; old tokens/challenges/claims cannot gain
new authority because a logical account ID becomes active again.

Migration 38 archives incoming import/invitation/reservation/public-key evidence
when an imported account retires, omitting prepared private ciphertext. Together
with migration 36's outgoing archive, this permits exact retired-slot recycling
without erasing history. Returning materialization requires the old retired
checkpoint and the latest signed source snapshot, preserves immutable and
delivery/reply/outbox checkpoints, revokes old credentials and advances one
generation under the account lock. Shared collocated Grant ownership is retained;
conflicts roll the whole transaction back. Attempts/deadlines/retry schedules
survive, but old lease tokens do not.

`POC_SELF_SERVICE_RETURN=true` requires `POC_SELF_SERVICE_TRANSFER=true` on the
pinned private PLC. It enables only owner-controlled returns preserving the
same identity/recovery keys, with a fresh available username. Upgrade all
serving processes/workers before enabling it; mixed-version operation remains
generation-1 only. The existing `hailp account transfer …` flow is reused, followed
by explicit fresh destination login. Both live providers now run migration 39
with transfer/return enabled, including the real HTTPS round-trip proof.

The native admission adapter currently captures an O(accounts) provider-wide
generation vector. An unrelated advancement may conservatively invalidate a
concurrent job; per-DID capture is the throughput upgrade path.
`migrations/rollback/0037_generation_admission.sql` rolls back 38/37 only before
advancement and while incoming archive records retain exact legacy copies. It
refuses rollback after generation 2 or detachment; application downgrade after
advancement is not supported. See
[return proof and boundaries](https://github.com/j4crev/hailproto/blob/main/apps/cli/docs/generation-bound-return.md).

`POC_MANAGED_TRANSFER=true` additionally enables the managed-custody invitation,
fence, export, configured-private-PLC completion, activation and retirement path.
It is disabled by default and requires `POC_ACCOUNT_ACCESS`,
`POC_SELF_SERVICE_TRANSFER` and `POC_SELF_SERVICE_RETURN` on a non-public PLC.
Its reads are retained as `poc-local`; this flag cannot enable public-PLC or
strict-public operation.

The separate `PUBLIC_MANAGED_TRANSFER` runtime is **disabled by default**. It
requires `NODE_ENV=production`, `PLC_DIRECTORY_URL=https://plc.directory`,
`PLC_AUTHORITY_PROFILE=strict-public-v1`, one to three reviewed `PLC_PUBLIC_READERS`, and
the local deployment operator in `PLC_PROVIDER_OPERATORS`. Each provider keeps
its configured readers outside its own operator and origin; no peer registry or
second provider declaration is required at startup. All private account access,
onboarding, transfer, return and schema-rehearsal gates must be off. Public
onboarding may remain enabled.
`PLC_MANAGED_MONITOR_ORIGIN` and `PLC_MANAGED_MONITOR_PUBLIC_KEY` pin the independent
HTTPS monitor and its Ed25519 `did:key`; orphan declarations fail startup. Enabling
this flag is not permission to skip the remaining operational/public canary gates.

This runtime wires owner-recovery account access, owner-controlled and managed
transfer APIs/routes/workers,
and ordered validated reader fallback for routine resolution and public cutover.
Public staging rejects private registration history before submission. Activation
requires a reviewed bootstrap v2 monitor report, a fresh validated reader,
exact destination roles/state, and retained evidence selected/sealed atomically
with ownership. The exact current operation/state is also read back directly
from canonical `plc.directory`. Missing, stale, invalid or gapped evidence blocks
activation; an activated retry verifies retained evidence and current authority.

Public completion uses the same `/transfers/managed-completions` endpoint in two
phases. Without `monitor`, it stages/submits only the exact approved operation and
returns `phase: awaiting-monitor`; the source stays fenced. After the independent
monitor observes that operation, retry the same snapshot/approval/operation with
`monitor: {payload, signature}`. The pinned report may be refreshed without
changing the owner-approved artifacts. The private endpoint still accepts only
the original three-field request and never public monitor evidence.

Owner-controlled completion uses the equivalent two-phase
`/.well-known/hail/transfers/completions` flow. Retry `hailp account transfer complete` with
`--monitor-attestation` after the monitor approves the exact operation.

All implementation proof uses injected readers/PLC transport, including strict
`A → B → A`, submission ambiguity, retries, monitor refusals, reader outages,
history/Grant continuity, credential revocation and generation fencing. This is
not public PLC evidence; no deployment flag or registry was switched.

### Never-active post-export recovery (internal migration 39)

The integration-only `PrivatePocTransferAbandonment` coordinator implements
independent owner-recovery approvals, staged-target invalidation, protective
source PLC verification, target release and exact source resumption. It is not
registered as public routes. An active
destination is rejected and requires latest-state reverse transfer. Submission,
invalidation, publication and activation share the import-row serialization
point; a protective owner-signed successor prevents delayed external PLC replay.

Migration 39 retains signed coordination receipts and original source/target
evidence, plus retired observation history before old import slots are recycled.
Nonce tombstones prevent old grants/invitations reopening the abandoned transfer.
Resumption preserves accepted state, revokes old credentials/leases and advances
the source generation only after current protective authority, target release
and source binding verify. Unknown PLC changes or missing counterpart/binding
proof leave the source fenced. Exact receipts support restart/lost responses.
The guarded rollback refuses accepted abandonment or sole-copy observation loss.
Its schema remains in the migration-39 rollout, but the coordinator lives only in
test support and no public recovery route or command is enabled. See the
[private recovery proof](https://github.com/j4crev/hailproto/blob/main/apps/cli/docs/post-export-recovery.md).

## API-first account management direction

### Active Grant revisions

The deployed slice adds active signed Grant updates through owner proposals/import
and explicit managed signing, plus multiple selected categories without wildcards.
Expansion, scope switches, expiry extension and consent refresh reverify exact
current address/profile evidence; restrictions preserve consent without sender
availability. Atomic appends retain immutable history/evidence and ordered outbox
responsibility. Exact historical retries do not replace current state.

New endpoints are `POST /api/v1/account/grants/{id}/proposals` and `/update` for
managed signatures; both require `grants:write` and reject fenced accounts.
There is no new Grant schema migration or unsigned blocking. New signer epochs
are held pending reviewed historical-key reconciliation. See the
[revision contract](https://github.com/j4crev/hailproto/blob/main/apps/cli/docs/grant-revisions.md)
and [key decision](https://github.com/j4crev/hailproto/blob/main/apps/cli/docs/grant-key-reconciliation.md).

### Address Binding renewal (migration 35)

The deployed slice adds `GET/POST /api/v1/account/binding` and
`hailp binding show/renew`. Reading exposes selected signed expiry and seven-day
reminder metadata; renewal needs deliberate `account:write` authority, current
identity/service ownership and an active/public account. Migration 35 expands
the scope constraint without upgrading existing credentials. Both custody
profiles passed real HTTPS renewal/retry/history proof on both POC origins;
the proof covered both custody profiles.

Provider-domain renewals retain the 90-day maximum and immutable signed history.
Hosting commits before compare-and-select publication; exact retries repair
verification failures and never reselect a superseded binding. Owner-controlled
signing stays identity-only; managed signing requires explicit managed custody.
Expired/unauthorized credentials, changed keys and source fences cannot renew.
Existing Grants and completed signup evidence are retained. See the
[renewal contract/proof](https://github.com/j4crev/hailproto/blob/main/apps/cli/docs/binding-renewal.md).

### Passkey browser sessions (migration 54)

`PASSKEY_AUTH=true` enables discoverable WebAuthn registration, authentication,
logout and cookie-backed account API sessions. `PASSKEY_ORIGIN` pins the exact
browser origin and `PASSKEY_RP_ID` pins its RP domain; production requires HTTPS.
The default for both is `PUBLIC_ORIGIN` and its hostname. Local development may
use `PASSKEY_ORIGIN=http://localhost:5173` with `PASSKEY_RP_ID=localhost`.

Sessions use hashed random tokens, a 30-minute idle limit and 12-hour absolute
expiry. The browser cookie is `HttpOnly`, `SameSite=Lax`, and `Secure` on HTTPS.
Passkeys and sessions remain provider-local, generation-bound access state and
are not included in portable custody data. Initial registration requires an
existing `credentials:write` API credential; owner-proof enrollment and passkey
management remain later phases described in
[`../../docs/passkey-authentication.md`](../../docs/passkey-authentication.md).

### Credential lifecycle extension

The deployed API-plus-CLI slice adds `GET /api/v1/account/credentials` for
account-scoped inventory and optional `scopes` in credential issuance for
deliberate subsets. Both require `credentials:write`; inventory omits tokens/
hashes and returns at most 50 entries with an `after`/`next` UUID cursor.
Scope escalation is 403; changed-scope, cross-account and revoked/expired token
retries are 409. Existing `{token}` inherited issuance remains supported.
See the [credential lifecycle contract/proof](https://github.com/j4crev/hailproto/blob/main/apps/cli/docs/credential-lifecycle.md)
and [post-expiry access design](https://github.com/j4crev/hailproto/blob/main/apps/cli/docs/account-access-recovery.md).
The migration-34 login/recovery slice described below is deployed to both POC
providers.

The account response also includes current credential ID/expiry metadata.
`hailp credential rotate --output <new-private-file>` uses existing issuance,
account reads and revocation with a retained private rotation sidecar. It verifies
the replacement and preserves scopes before revoking the original; fresh-process
retries recover successful issuance/revocation even after response loss. This
does not authenticate expired credentials or modify identity/recovery authority.

### Browser batch unsubscribe

`POST /api/v1/account/permissions/prepare` accepts a managed passkey session and
`{requestId, action: "revoke", grants: [{grantId, revision, digest}, ...]}`.
It freezes the exact ordered selection in one existing approval record with one
challenge. The batch response has `action: "revoke-batch"`, `permissions` containing
all reviewed Grants, and `permission` containing the first item. The distinct
action makes older browser code reject batch recovery instead of displaying only
one sender before authorizing the whole batch. Single-Grant requests are unchanged.

One `/commit` passkey assertion authorizes the entire selection. A terminal batch
`result.items` contains `{grantId, result, error}` for each reviewed item; successful
items have the usual durable revocation result, while revision conflicts have a
null result and a review-again error. Revocations are individually durable, not an
atomic multi-Grant transaction. An uncertain write leaves the approval recoverable
through its original ID without a new assertion; exact-successor detection prevents
duplicate revisions. Newer subscription revisions are never revoked by old consent.

The existing account/session/generation binding, five-minute expiry and immutable
approval protections apply. Batches allow up to 50 distinct Grants within the
existing 16 KiB encoded-intent limit; larger reviews return 413. No schema migration
or signed Grant format change is needed. Before rolling back to older code, finish
pending batch approvals; older code cannot resume them. Retain approval records
and refresh the subscriptions list before reviewing any unfinished items again.

### Browser batch connection removal

`POST /api/v1/account/connections/prepare` accepts
`{requestId, action: "disconnect", connectionIds: [...]}` for 1–100 distinct active
connections. Its `disconnect-batch` review binds each connection ID, pair and epoch,
plus the displayed address and DID, to one passkey challenge. Existing single
removal and owner-signing flows are unchanged; ending a connection requires no
new owner identity signature.

One `/commit` creates all local cutoffs and propagation jobs in the same transaction
as passkey consumption and the terminal approval result. A changed connection
rolls back the entire batch. Retrying a completed request returns the retained
`{connectionIds, state: "disconnected", propagation: "pending"}` result without
another assertion. The existing worker notifies peers, including offline providers.
No subscriptions or earlier messages are removed. Older clients reject the new
review action; complete pending batch reviews before a code rollback.

### Post-expiry owner login/recovery (migration 34)

`POC_ACCOUNT_ACCESS=true` explicitly enables private-PLC
`POST /api/v1/account-access/prepare` and `/complete`. The existing private-registry
guard rejects unsupported registry configurations. Migration 34 adds only a
provider-local bounded challenge table; it changes no existing credential/custody
data and is not exported with portable DID state. Existing routes remain usable
with the access gate disabled. Both POC providers now enable it; both custody
profiles passed real HTTPS expiry/recovery/rotation/scope proof on each host.

The client explicitly selects DID, signer and scopes. Owner-controlled identity
proof and explicit owner-top-recovery proof are accepted only with fresh verified
PLC authority, source service ownership and matching reviewed custody/key-role
evidence. Provider-held managed identity signatures, lower provider recovery keys,
historical/mismatched keys, inactive accounts and all migration-fence states are
rejected. No user private key is imported and no PLC operation is published.

Challenges are provider/DID/account/purpose/scope/token-hash bound, expire within
five minutes, and persist across process restart. Completion consumes the nonce
and issues the credential under the account-row lock in one transaction; an exact
still-valid retry returns the same ID/expiry. Persistent preparation/completion
rate buckets, bounded retention and protected generic completion responses reuse
existing provider primitives. See the [recovery contract](https://github.com/j4crev/hailproto/blob/main/apps/cli/docs/account-access-recovery.md)
for the current behavior.

### Extended CLI slice (migration 33)

The code adds explicit private-PLC self-service signup, owner-controlled
or managed identity with owner recovery, scoped credential creation/revocation,
Grant proposals/listing, sending, inbox/status and invited replies. Both POC
providers were rolled out on October 9; both custody profiles passed HTTPS
signup/account/credential smoke checks on each host. Follow the
[CLI workflows](https://github.com/j4crev/hailproto/blob/main/apps/cli/docs/cli-workflows.md).

`POC_SELF_SERVICE_ONBOARDING=true` enables `POST /api/v1/onboarding` and
`POST /api/v1/onboarding/{account_id}` only on the pinned private PLC service
profile. Prepare submits address, public recovery/identity keys, explicit
custody, backup confirmation and a client-generated signup token hash.
Registration requires that bearer secret and the exact owner-top-signed
genesis plus an owner binding (managed bindings are provider-signed/cached).
Public genesis alone cannot claim credentials. Activation validates published
address/PLC evidence before issuing initial full-access credentials. This
20-request/minute process-local signup gate is a controlled POC, not production
abuse protection or public-registry onboarding. Managed evidence is separate
from portable custody; portable key-separation/transfer checks are not bypassed.

`PUBLIC_SELF_SERVICE_ONBOARDING=true` selects the same resumable endpoint only when
`PLC_AUTHORITY_PROFILE=strict-public-v1` and canonical `https://plc.directory` are
configured. Preparation additionally binds a canonical external monitor origin/key.
The first signed registration returns HTTP 202 with `did`, `operationCid` and
`monitorRequired`; after reviewed monitor enrollment/backfill, retry with the signed
onboarding attestation to activate and receive the credential. Exact state and signed
artifacts must be retained between both calls.

Additional account endpoints:

| Path | Method/scope | Purpose |
| --- | --- | --- |
| `/grants/proposals` | POST, `grants:write` | Verified unsigned owner proposal |
| `/grants` | GET, `grants:read` | Scoped list, 50 items, `after` Grant-ID cursor |
| `/grants/managed` | POST, `grants:write` | Explicit managed evidence; sign/create at provider |
| `/grants/{id}/revoke` | POST, `grants:write` | Managed account's signed terminal revision |
| `/credentials` | POST, `credentials:write` | Issue caller-generated token with inherited scopes or revoke own credential ID |
| `/messages` | POST, `messages:write` | Text (`spt-1`), rich `spt-2`, or bundled-header `spt-3` body, Grant or invited reply, with client-stable UUIDv7 |
| `/messages/{id}/submit` | POST, `messages:write` | Resubmit exact own envelope |
| `/messages/{id}` | GET, `messages:read` | Retained authenticated status, otherwise indeterminate |
| `/publications/audiences` | GET, `grants:read` | Active category subscriber counts; General is category `general` |
| `/publications` | POST, `messages:write` | Durable category-wide publication with a stable publication ID and immutable audience snapshot |
| `/publications` | GET, `messages:read` | Account-private unfinished/recent publication links for recovering queued work |
| `/publications/{id}` | GET, `messages:read` | Account-private fan-out outcomes and separate delivery counts |
| `/publications/{id}/cancel` | POST, `messages:write` | Stop targets that have no created envelope; existing submission attempts are retained |
| `/inbox` | GET, `messages:read` | Delivered recipient list, 50 items, opaque `after` cursor |
| `/inbox/{sender_did}/{id}` | GET, `messages:read` | Own delivered body/safe metadata, no bearer token |

Paths are relative to `/api/v1/account`. JSON writes require uncoded
`application/json`. Message inputs contain `messageId`, exactly one of `text`
or a diagnostic-JSON `body`, either
`grantId`/`category` or `replyTo`, and optional `replyUntil`; text is bounded
at 64 KiB and bodies retain the 256 KiB encoded limit. Stored envelopes bind retries to the same body, authorization and
reply permission. Federation submission shares the operator CLI's submission
service, preserving signed status versus generic receipt verification.

Publication input is `{publicationId, category, text OR body, allowReplies}`;
recipient selections are not accepted. Migration 61 adds the durable outbox and
blocks provider cutover while targets are unfinished. Initial limits are 100
recipients, five open publications per account and a 24-hour attempt window.
See [category publishing](../../docs/category-publishing.md) for worker semantics,
per-target status, cancellation, retention and code/schema rollback boundaries.

Operator `account:credential-create` also accepts `--full-access` for all six
account/Grant/message/credential scopes. Existing credentials are not silently
escalated. Authenticated credential management creates only inherited scopes
and revokes only own-account IDs. Rotate before expiry; expired-token recovery
and production login, binding renewal, managed migration and public-PLC signup
remain separate work. Account reads report explicit managed evidence as managed,
not owner-controlled portable evidence. Both new signup modes remain `poc-local`.

The selected product architecture is an authenticated account API used by
human apps, agents and provider-native/Hail-provided CLI clients. Normal users
and agents should not need SSH, database credentials or administrator CLI
access. Owner-controlled accounts submit identity-signed objects; the approved
managed profile lets the provider sign authorized identity operations while
the account owner retains the top PLC recovery key. Both profiles are intended
for people and agents.

The current implementation has the account/Grant/message APIs, opt-in private signup,
and an opt-in strict-public owner/monitor ceremony for both custody profiles. Live
independent deployment, public recovery, history transport and managed migration still
need work. Extend the account boundary over existing services and
transactions rather than treating administrator CLIs as client APIs. The
[API and custody plan](https://github.com/j4crev/hailproto/blob/main/docs/portable-custody.md#api-first-provider-and-cli-clients)
defines the first authenticated slice, profile-specific signing, isolation,
renewal and managed-migration acceptance conditions.

## Development

Build the sibling codec first, install dependencies, and create local
configuration:

```bash
pnpm --dir ../../vendor/did-method-plc --filter @did-plc/lib build
bun run --cwd ../../packages/hail-codec-ts build
bun install
cp .env.example .env
```

Replace every placeholder secret and database credential before starting the
server.

```bash
bun run db:migrate
bun run typecheck
bun run test
bun run dev
```

The server also runs pending migrations before binding its HTTP listener.

Create and activate test accounts through the owner-key account API using the
[`hailp` signup workflow](../cli/docs/cli-workflows.md#create-an-account). The
legacy provider-custodial onboarding and activation commands have been removed.
The public deployment profile is in [`deploy/public/README.md`](deploy/public/README.md).

Initial health endpoints:

```text
GET /health/live
GET /health/ready
```

After an account is active, create or idempotently reuse its signed Sender
Profile from a closed JSON authoring document:

```bash
bun run profile:create -- alice@hailproto.app examples/alice-profile.json
```

Retrieve and verify a profile through current PLC state and hardened public
HTTPS transport with:

```bash
bun run profile:verify -- did:plc:aaaaaaaaaaaaaaaaaaaaaaaa
```

After both accounts have public activation evidence and the grantee's Sender
Profile verifies, create or idempotently reuse a signed Grant:

```bash
bun run grant:create -- \
  bob@hailproto.dev \
  alice@hailproto.app \
  examples/bob-to-alice-grant.json
```

Grant creation retains the exact verified Address Binding, Sender Profile, and
PLC evidence in the same transaction as immutable revision 1. It also creates a
durable publication outbox entry. The server checks that outbox every five
seconds; an operator can trigger one due attempt directly with:

```bash
bun run grant:publish -- --once
```

Revoke an authoritative Grant with a terminal signed revision:

```bash
bun run grant:revoke -- bob@hailproto.dev <grant-id>
```

Local revocation commits before publication and immediately remains
authoritative even if the remote notification needs retries. A revoked Grant ID
cannot become active again.

## Single-Use Replies (Private-PLC POC)

Reply authorization follows
[`../../spec/envelopes.md`](../../spec/envelopes.md#reply-authorization):
it is an invitation signed in a prior envelope, not a reverse-direction Grant.
After migration 12, the original sender can opt in when signing its
Grant-authorized envelope:

```bash
bun run envelope:create -- "$sender_did" "$grant_id" "$body_digest" updates \
  --reply-until "$reply_until_unix_seconds"
bun run envelope:submit -- "$sender_did" "$original_message_id"
```

Once that envelope has been accepted, the other provider publishes its own
body and signs one reply using the original message ID:

```bash
bun run body:publish -- "$reply_sender_did" examples/alice-body.txt
bun run envelope:reply -- "$reply_sender_did" "$original_message_id" "$reply_body_digest"
bun run envelope:submit -- "$reply_sender_did" "$reply_message_id"
```

Set the shell variables from the earlier commands' printed values. A reply
does not include a category and defaults to `reply.allowed: false`. Add
`--reply-until "$next_reply_until_unix_seconds"` to `envelope:reply` to
explicitly invite one further reply. The original sender serializes the
single-use claim before accepting a reply, consumes it on delivery, and
releases it after terminal failure or cancellation. The full phase and its
limitations are covered by the integration test below.

To test the local PostgreSQL reply lifecycle against a disposable database:

```bash
DATABASE_URL=postgresql://hail:password@127.0.0.1:5432/hail \
  bun --bun vitest run test/reply-capabilities.integration.test.ts
```

Run the PostgreSQL repository integration test against a disposable migrated
database with:

```bash
DATABASE_URL=postgresql://hail:password@127.0.0.1:5432/hail \
  bun run test:integration
```

The integration test skips when `DATABASE_URL` is absent.

## Backend Hardening

The first hardening slice shares one response schedule and bounded validation
budget between envelope submission and delivery-status push. The provisional
750 ms response minimum, 10-second processing deadline, and 32-work provider
gate are separate from the current public-provider calibration.
PLC directory reads now use a 5-second cancellable HTTP deadline, 1 MiB
decoded response ceiling, strict duplicate-member-rejecting JSON parsing,
and no redirects; the directory base is configured rather than derived from
an untrusted DID. PLC operation submission remains delegated to the pinned
official client, preserving onboarding's exact-operation retry semantics.

To exercise the initial response and PLC rotation fixtures without a running
provider database:

```bash
bun run test test/envelope-routes.test.ts test/protected-schedule.test.ts \
  test/envelope-deadline.test.ts test/plc-rotation-boundary.test.ts \
  test/plc-client.test.ts
```

Against a disposable PostgreSQL database, the ambiguous PLC-write fixture
tests restart-safe exact-operation reconciliation, exact retransmission after
an uncommitted request, and hash-prefix collision rejection:

```bash
DATABASE_URL=postgresql://hail:password@127.0.0.1:5432/hail \
  bun --bun vitest run test/onboarding-restart.integration.test.ts
```

The PLC fixture validates a signed operation-log update and current endpoint
selection. It does not simulate the fenced provider-state transfer required
for a real service migration. The first bounded-processing and PLC-read slice
is deployed to both public POC providers; tested runtime and backup details
are no longer retained as release documentation. Further sustained-load
calibration and broader migration failure/recovery coverage remain outstanding. One live
private-PLC transfer has delivered a previously accepted message exactly once.

## Portable Provider Cutover (Disposable Rehearsal)

Migrations 13–31 add DID-scoped source write fences, authenticated immutable
snapshots, destination-owned prepared operational keys, a signed user-consent
and PLC operation check, and an inactive destination import. The activation
service verifies two independently witnessed current PLC reads and monitor
coverage for the exact top-user-key-signed operation, with no fixed wait, and
the user's externally published Address Binding before importing all state in
one transaction. It renews the Sender Profile with the destination messaging
key, normalizes inherited leases, and gives the source a signed retirement
receipt. The source never receives the destination private key; the snapshot
contains **no encrypted private-key ciphertext**, raw bearer tokens, or other
private secrets from the source. One-way authorization hashes such as
`body_authorizations.token_hash` are retained as intentional continuity data.

Before fencing, the source validates a user-identity-signed Transfer Grant
naming a **provider domain**, derives that provider's fixed well-known HTTPS
invitation endpoint, and sends a signed invitation. The destination verifies
both signatures, prepares keys and returns an inactive signed **Transfer
Offer** over TLS. The old provider retains origin proof of the offered key.
The client then directly signs and submits its chosen address under that
domain to the new provider, which reserves the address atomically in its
local account namespace and returns a signed receipt. The new provider
**pushes** a final Transfer Request, signed by the offered key, to the old
provider's fixed endpoint. The source verifies the exact user selection and
reservation and consumes the user grant
atomically with the fence. Neither source messaging nor provider PLC keys can
issue the user grant or sign the final top-recovery-key PLC operation.

The user client can POST its signed grant to the current source's fixed
`/hail/transfers/grants` endpoint. A `200` returns the origin-verified Offer;
`202` means invitation delivery remains pending and retrying the **same**
signed grant retrieves it once available. PostgreSQL-leased source/target
workers retry pending invitations and final requests after restarts. Rate
buckets are shared by provider processes. Before fencing, the user can sign
an exact transfer cancellation: the old provider signs a no-fence receipt,
and only that receipt allows the target to release an ambiguous submitted
reservation. Expiry cleanup releases only transfers with no final push.

These commands are operator building blocks, **not a public migration
procedure**: `transfer:grant` in `../cli` produces a private
signed domain grant; `migration:invite -- <grant-file> <invitation-file> <offer-file>`
on the source validates/stores it, sends the invitation to the derived fixed
well-known HTTPS endpoint, and saves the inactive origin-verified Offer.
If delivery fails after grant issuance, retry with
`migration:deliver-invitation -- <local-did> <new-offer-file>` rather than
reissuing the still-live grant. The user reference client signs and sends an
Address Selection directly to the new provider; its server reserves the
address and pushes the final request to the old provider. An ambiguous
push is retried from the target with `migration:publish-final -- <transfer-id>`.
The old provider's final-request endpoint returns `204` only after it fences
the DID; `migration:fence -- <final-request-file> <selection-file> <receipt-file>`
is an operator diagnostic that still requires origin-proven offer state. Then
run
`migration:export` on the source and
`migration:stage` with separate user-signed consent, exact signed PLC update,
and fresh user-signed Address Binding. Export and consent files must be private
(`0600`) and transferred over an authenticated administrative channel.
The reference client additionally has `transfer:submit-grant` and
`transfer:cancel` commands. The supported account workflow now lives in
[`hailp`](../cli/docs/cli-workflows.md); the operator commands above remain
diagnostic building blocks, not a public transfer procedure.
The original Alice/Bob POC accounts were created with custodial keys in a private
directory and **must not be used as portable migration sources**. New user-held
private-PLC DIDs completed the earlier POC ceremony. Separate
reference projects now exist at `../cli` for user-controlled
key generation, encrypted vault recovery and offline signing, and
`../plc-monitor` for user-run independent PLC monitoring and signed
coverage attestations. They are reference implementations, not production
infrastructure. Mobile clients can implement the same signing profile with
platform-specific secure storage. See the sibling
`../../docs/portable-custody.md` for the complete trust model.

Test the safe cutover boundaries using two disposable PostgreSQL databases:

```bash
DATABASE_URL=postgresql://hail:password@127.0.0.1:5432/hail_source \
TRANSFER_TARGET_DATABASE_URL=postgresql://hail:password@127.0.0.1:5432/hail_target \
  bun --bun vitest run test/migration-fence.integration.test.ts
```

The original file-based private-PLC operator ceremony has been retired. New
private rehearsals use the account API and [`hailp` workflows](../cli/docs/cli-workflows.md);
the private runtime services and integration fixtures remain for compatibility
and regression evidence.

### Recipient Trash

Migration 76 adds `delivered_messages.trashed_at` and account message preferences.
The provider starts a bounded expiry worker immediately and every 60 seconds.
It purges after 30 days **in Trash**, preserves shared recipient body references
and delivery replay history, and respects account transfer fences. Failures are
logged as `Trash cleanup failed`. No external cron is needed.

Passkey sessions with `messages:read` can `GET /api/v1/account/trash` (optional
`after` cursor) and `GET /api/v1/account/message-preferences`. Same-origin
`messages:write` sessions can POST `{}` to `/api/v1/account/inbox/:sender/:messageId/delete`,
POST `{ "messages": [{ "sender": "did:plc:…", "messageId": "…" }] }` to
`/api/v1/account/trash/restore` (1–100 selections), or POST
`{ "trashEnabled": false }` to `/api/v1/account/message-preferences`. Disabling
Trash atomically purges it. See [client behavior and rollback](../client/README.md#trash-and-deletion).

CLI/API credentials with `messages:write` may POST `{}` to
`/api/v1/account/inbox/:sender/:messageId/permanent-delete`. This endpoint bypasses
Trash and accepts bearer credentials, not browser passkey sessions. It deletes
only the authenticated recipient's copy and is safe to retry after a lost response.

## Connection address-change notices

Existing authenticated connection handover automatically updates a peer's
address during a provider move. Migration 0077 retains the previous/new label
for a seven-day UI notice, shown only after handover completes. This adds no
sharing workflow, subscription notifications, federation endpoint or snapshot
version. Presentation state is local and may disappear if the observer moves.
See [contact identity notices](../../docs/contact-identity-notices.md).
