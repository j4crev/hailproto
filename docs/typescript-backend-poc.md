# TypeScript Backend POC

Status: In progress

This guide records the implementation and deployment method for the first Hail
Protocol end-to-end proof of concept. It is intended to become a reproducible
how-to for other developers, so commands, expected results, deviations, and
security limitations are recorded as the implementation proceeds.

The protocol specifications in [`../spec`](../spec) remain authoritative. This
guide describes one implementation and does not override those specifications.

## Goal

Run two independently configured Hail providers that exchange one
grant-authorized message:

| Provider | Initial account | Public origin |
| --- | --- | --- |
| app | `alice@hailproto.app` | `https://hailproto.app` |
| dev | `bob@hailproto.dev` | `https://hailproto.dev` |

Both providers use the same TypeScript implementation but have separate
configuration, keys, and databases. A private instance of the official PLC
directory supplies isolated test identities. These identities do not
participate in public Hail federation and cannot be resolved through
`https://plc.directory`.

## POC Limitations

The first implementation is explicitly an isolated, custodial POC:

- The providers may hold PLC rotation, `#hail-identity`, and
  `#hail-messaging` private keys.
- The test DIDs are registered only in a configured private PLC directory.
- The PLC directory is trusted for current ordering and availability rather
  than independently validating its complete export stream.
- Independent PLC monitoring and the production portable-custody ceremony are
  deferred.
- The production policy for PLC's 72-hour recovery window and historical DID
  verification evidence remains unresolved by the protocol specification.
- Running both providers on one host tests protocol isolation, not independent
  infrastructure ownership or host-level failure isolation.

The POC must still use distinct keys for each role, regular `plc_operation`
creation, durable onboarding state, exact-operation retries, signed Address
Bindings, read-back verification, and complete address-to-DID-to-service
activation checks.

## Repository Layout

The implementation uses sibling repositories:

```text
/home/j4crev/Dev/
|-- hailproto/          protocol, codecs, conformance vectors, and this guide
|-- hail-server-ts/     reusable Bun and Hono provider implementation
`-- did-method-plc/     pinned clone of the official PLC implementation
```

Canonical upstream repositories:

- Hail Protocol: <https://github.com/j4crev/hailproto>
- PLC directory: <https://github.com/did-method-plc/did-method-plc>

Record the exact tested commits in the [Implementation Log](#implementation-log).
Do not silently update the PLC checkout while reproducing a test run.

## Technology Profile

| Concern | Choice |
| --- | --- |
| Runtime and package manager | Bun 1.4.0 |
| Language | TypeScript with strict checking |
| HTTP framework | Hono on Bun's native server |
| Protocol codec | `@hailproto/codec` from the sibling `hailproto` checkout |
| PLC client | Official `@did-plc/lib` |
| Provider persistence | PostgreSQL |
| Database access | Bun SQL and checked-in SQL migrations |
| Tests | Vitest |
| Public TLS proxy | Caddy |
| Local and POC orchestration | Docker Compose |
| PLC runtime | Upstream Node, pnpm, Express, and PostgreSQL stack |

The PLC checkout retains its upstream package manager and runtime. Bun is used
for Hail-owned TypeScript code, not as an unreviewed conversion of upstream PLC
software.

## Target Topology

```text
Internet
   |
   | HTTPS :443
   v
Caddy
   |-- Host: hailproto.app -> hail-app:3000
   `-- Host: hailproto.dev -> hail-dev:3000

Private container network
   |-- hail-app -> app PostgreSQL database
   |-- hail-dev -> dev PostgreSQL database
   |-- plc:2582 -> PLC PostgreSQL database
   `-- no public PostgreSQL or PLC listener
```

The two Hail services use the private PLC URL:

```dotenv
PLC_DIRECTORY_URL=http://plc:2582
```

All test clients and command-line tools that resolve a test DID must use the
same URL. A `did:plc` identifier contains no registry or network identifier, so
software using the production directory will not find these test identities.

## Public DNS And TLS

No public DNS change is required during the local implementation phases.

Before public deployment, create these records at the authoritative DNS
provider:

```dns
hailproto.app.  A  <public-vps-ipv4>
hailproto.dev.  A  <public-vps-ipv4>
```

Add `AAAA` records only when IPv6 is configured, reachable, and firewalled
correctly. A broken `AAAA` record can cause intermittent connection failures.

Requirements and cautions:

- Use a public VPS address, not an RFC1918, loopback, link-local, or other
  private address.
- Expose inbound TCP ports 80 and 443 to Caddy. Port 80 is used for ACME and
  HTTPS redirection; Hail federation itself uses HTTPS.
- Do not expose PostgreSQL or the PLC server to the public Internet.
- The `.dev` top-level domain is HSTS-preloaded and requires working HTTPS.
- Do not put a PLC URL in public DNS for this POC.
- Initially use DNS-only records if the DNS provider offers an HTTP proxy. A
  proxy can be enabled later after request limits, media types, cache behavior,
  and source-address handling have been verified.
- Hail clients must not follow federation redirects. Caddy must route the final
  operation URL directly rather than redirecting `/hail` operations elsewhere.

The expected public Hail service bases are:

```text
https://hailproto.app/hail
https://hailproto.dev/hail
```

The expected discovery resources are:

```text
https://hailproto.app/.well-known/webfinger
https://hailproto.app/.well-known/hail/addresses/{opaque-id}
https://hailproto.dev/.well-known/webfinger
https://hailproto.dev/.well-known/hail/addresses/{opaque-id}
```

If either apex domain already serves another application, preserve that
application and route only `/.well-known/webfinger`,
`/.well-known/hail/addresses/*`, `/hail/*`, and health paths to the Hail
provider. Decide this before changing DNS.

## Local Prerequisites

Verify the development tools before setup:

```bash
bun --version
node --version
pnpm --version
docker --version
docker compose version
git --version
```

Expected minimums for the initial implementation are Bun 1.4.0 and Node 24.
The pinned PLC checkout determines its exact pnpm requirement.

## Phase 1: Clone And Verify PLC

From `/home/j4crev/Dev`:

```bash
git clone https://github.com/did-method-plc/did-method-plc.git
cd did-method-plc
git rev-parse HEAD
```

The upstream development setup is:

```bash
make nvm-setup
make deps
make build
make run-dev-plc-with-db
```

`run-dev-plc-with-db` uses a disposable PostgreSQL container and is useful only
for an initial smoke test. The durable POC will use persistent PostgreSQL and:

```bash
make run-dev-plc
```

Verify a running directory:

```bash
curl --fail http://localhost:2582/_health
```

Expected result: a successful HTTP response. Verify persistence by creating a
fixture DID, restarting PLC and PostgreSQL, and resolving the same DID again.

Do not start the current pinned server without `DATABASE_URL`. Although an
in-memory database path exists in the source, startup at the pinned commit was
observed to fail when its sequencer accessed an undefined database. PostgreSQL
is therefore a required dependency for this POC, including local smoke tests.

## Phase 2: Scaffold The Provider

Create `/home/j4crev/Dev/hail-server-ts` as one reusable implementation. The
same built artifact runs with app or dev configuration.

Initial source layout:

```text
hail-server-ts/
|-- src/
|   |-- index.ts
|   |-- app.ts
|   |-- config.ts
|   |-- db/
|   |-- plc/
|   |-- identity/
|   |-- discovery/
|   |-- federation/
|   |-- delivery/
|   |-- jobs/
|   `-- cli/
|-- migrations/
|-- test/
|-- deploy/poc/
|-- package.json
|-- tsconfig.json
`-- bun.lock
```

During local POC development, consume the codec through the sibling checkout:

```json
{
  "dependencies": {
    "@hailproto/codec": "file:../hailproto/packages/hail-codec-ts"
  }
}
```

The backend also consumes the exact PLC library from the pinned sibling
checkout rather than an independently versioned npm release:

```json
{
  "dependencies": {
    "@did-plc/lib": "file:../did-method-plc/packages/lib"
  }
}
```

Both sibling libraries must be built before the server imports their
distribution output. A container build must use a context containing all three
repositories. Publish versioned packages before production rather than relying
on these filesystem relationships.

## Phase 3: Configuration And Process Lifecycle

Each instance receives environment-specific configuration:

```dotenv
NODE_ENV=development
PORT=3000
PROVIDER_ID=app
PUBLIC_ORIGIN=https://hailproto.app
HAIL_SERVICE_BASE=https://hailproto.app/hail
PLC_DIRECTORY_URL=http://localhost:2582
DATABASE_URL=postgresql://hail_app:replace-me@localhost:5432/hail_app
KEY_ENCRYPTION_KEY=replace-with-generated-secret
```

The dev provider changes `PROVIDER_ID`, both public URLs, its database, and all
secrets. Startup validation must reject missing values, malformed URLs, an
inconsistent service base, or a production service URL that resolves to a
private address.

Initial process endpoints:

```text
GET /health/live
GET /health/ready
```

Liveness reports only that the process can serve requests. Readiness verifies
required dependencies without leaking credentials or internal topology.

## Phase 4: Persistence

Use separate provider databases, even when one PostgreSQL cluster hosts both.
Add checked-in, forward-only SQL migrations and durable records for:

- local accounts and onboarding transitions
- encrypted custodial POC keys and public-key role metadata
- exact signed PLC operations and registration evidence
- PLC resolution cache and verification evidence
- exact Address Binding and Sender Profile representations
- grant lineages and terminal revocation tombstones
- immutable body bytes and hashed bearer authorizations
- outbound envelope correlation records
- inbound envelope replay and idempotency records
- delivery state and signed status snapshots
- a durable terminal-status outbox and retry schedule

Signed representations are stored as their exact received or generated bytes.
They must not be decoded and reserialized before hashing, ETag generation,
signature evidence storage, or duplicate comparison.

Envelope acceptance must transactionally serialize grant validation, replay
reservation, reply-capability claims, and the initial delivery state. Delivery
state advances through compare-and-set or row-locking semantics.

Run provider migrations explicitly with a populated `.env` file:

```bash
cd /home/j4crev/Dev/hail-server-ts
bun run db:migrate
```

Expected result:

```text
Provider database migrations are current
```

The server also applies pending migrations before opening its listener.
Migration application is serialized with a PostgreSQL advisory transaction
lock, and an already-applied migration must retain its original SHA-256
checksum. Editing an applied migration is an error; add a new numbered
migration instead.

## Phase 5: PLC And DID Boundary

Keep directory selection behind an interface so local POC resolution can later
be replaced by operation-log validation or mirrors:

```ts
interface PlcResolver {
  resolve(did: string): Promise<ResolvedHailDid>;
  submitOperation(did: string, operation: unknown): Promise<void>;
}
```

Implement canonical DID validation, role-specific key extraction, exact
`HailMessaging` service validation, a maximum five-minute POC cache, and one
forced refresh after an unknown key or signature failure. Never derive a PLC
network destination from the DID itself.

## Phase 6: Custodial POC Onboarding

Persist these states:

```text
reserved
prepared
submission-unknown
did-registered
address-staged
active
```

For each account:

1. Reserve an address and opaque tenant identifier.
2. Generate independent PLC rotation, `#hail-identity`, and
   `#hail-messaging` keys.
3. Build a regular `plc_operation` with `alsoKnownAs: []`.
4. Include the provider's public HTTPS Hail service base.
5. Retain the exact signed operation before attempting submission.
6. Submit it to the configured private PLC directory.
7. Reconcile ambiguous submission results without generating a new operation.
8. Read back and verify the operation and resulting Hail DID state.
9. Stage and publish the signed Address Binding.
10. Activate only after complete external-style verification succeeds.

The implemented custodial onboarding command performs steps 1 through 8 and
stages the binding from step 9:

```bash
cd /home/j4crev/Dev/hail-server-ts
bun run onboard -- alice@hailproto.app
```

Expected result:

```json
{
  "accountId": "<internal UUID>",
  "tenantId": "<opaque UUID>",
  "address": "alice@hailproto.app",
  "did": "did:plc:<24 base32 characters>",
  "state": "address-staged"
}
```

The address domain must equal `PUBLIC_ORIGIN`. Input ASCII case is
canonicalized before reservation. The command can be repeated after success or
after an ambiguous PLC request; it reuses persisted keys and the exact signed
genesis operation.

The POC generates:

- one exportable P-256 PLC rotation key
- one Ed25519 `#hail-identity` key
- one independent Ed25519 `#hail-messaging` key

Private key bytes are encrypted before database storage with AES-256-GCM. Each
key receives an independent random 96-bit nonce. Versioned additional
authenticated data binds the ciphertext to the account ID, role, algorithm,
and public key. The 128-bit GCM authentication tag is stored with the
ciphertext. The plaintext private bytes are never written to the database or
logs.

Before any PLC request, one transaction stores all encrypted keys, the exact
signed-operation JSON bytes, DAG-CBOR bytes, CID, expected state, registry
origin, and derived DID. The account is moved to `submission-unknown` before
the HTTP submission. A retry first checks the operation log and accepts only a
genesis with the persisted CID and bytes. A different genesis under the same
DID is treated as a hash-prefix collision and never made an ancestor.

Read-back verification checks the locally validated operation log, rendered
data, audit CID, nullification state, exact DAG-CBOR bytes, both Hail
verification methods, and the `#hail` service. Only then does the account enter
`did-registered`.

The command decrypts the identity key only after registration, signs the
Address Binding with deterministic Hail CBOR and tagged COSE_Sign1, verifies
the representation locally, hashes its exact bytes with SHA-256, and stores it
with a 90-day lifetime. It then enters `address-staged`. The command does not
publish WebFinger or activate the account yet.

## Phase 7: Discovery

Implement canonical Hail address handling and:

```http
GET /.well-known/webfinger
GET /.well-known/hail/addresses/{opaque-id}
```

Use the exact `https://hailproto.com/rel/address-binding` relation and the
required COSE media type. Enforce response limits, binding expiration, no
binding redirects, bounded WebFinger redirects, DNS rebinding protection, and
the one-hour maximum verified-result cache.

The local semantic lifecycle test is:

```bash
cd /home/j4crev/Dev/hail-server-ts
bun run activate:local -- alice@hailproto.app
```

It publishes these routes through the real Hono application:

```text
GET /.well-known/webfinger
GET /.well-known/hail/addresses/{binding-id}
```

Binding hosting and WebFinger selection are separate durable events. The
immutable binding URL is hosted while the account is `address-staged` before
an activation attempt selects it through WebFinger. An activation receives a
durable attempt UUID and moves the account to `activating`. Verification
failure conditionally withdraws only that attempt's selection and returns the
account to `address-staged`; it cannot withdraw a concurrently completed
activation.

The verifier checks canonical address selection, JRD subject and link
cardinality, bounded streamed response sizes, media-type equivalence, redirect
limits, no binding redirects, binding timestamps, deterministic COSE,
`#hail-identity` authorization, the validated PLC operation log, the exact
persisted `#hail-messaging` key, and the exact Hail service base. Activation
commits the selected binding digest and its verification mode.

`activate:local` uses an injected in-memory transport and records verification
mode `local`. It exercises protocol semantics but bypasses public DNS, TLS,
certificate validation, public reachability, and network-level DNS-rebinding
protection. It must not be presented as public-federation activation.

Public mode remains gated on a safe-fetch transport that pins validated public
DNS results to connections, applies the five-second connection and ten-second
overall deadlines, and revalidates every redirect target. It also requires a
bounded JSON parser that rejects duplicate JRD member names instead of relying
on `JSON.parse`. Do not expose a CLI that records verification mode `public`
until that transport, parser, and the public deployment are in place.

## Phase 8: Federation Operations

Implement in dependency order:

```http
GET  /hail/profiles/{sender_did}
PUT  /hail/grants/{grant_id}
POST /hail/envelopes
GET  /hail/bodies/{digest}
PUT  /hail/deliveries/{envelope_digest}
```

Hono handlers remain thin. Protocol validation, PLC resolution, safe network
fetching, transactions, and state transitions live in focused modules that can
be tested without an HTTP listener.

The Grant POC uses these explicit implementation policies:

- The transport and persisted representation ceiling is 262144 bytes, matching
  the codec's current tagged COSE input ceiling.
- Grant and revocation revisions, predecessor digests, consent evidence, and
  signature-verification PLC evidence are retained indefinitely for this POC.
- Incoming revisions verify only against the grantor's currently authorized
  `#hail-identity` key. Historical-key recovery remains deferred with the PLC
  recovery-window policy described under POC limitations.
- Revision 1 uses one issuance instant for `issued_at` and `updated_at`.
  Successors preserve `issued_at`, strictly increase `updated_at`, and reject
  signed timestamps more than 300 seconds in the future.
- At most one active Grant exists for a grantor/grantee DID pair. Re-subscribing
  after terminal revocation creates a new UUIDv7 lineage.
- The in-process publisher is only an executor over a PostgreSQL outbox. Signed
  state and retry responsibility commit before network I/O and survive process
  restarts. Claims use leases, preserve revision order, refresh the grantee's
  current PLC service on every attempt, and use bounded exponential backoff with
  jitter.
- The current slice authors initial active revisions and terminal revocations.
  General active revisions for scope changes, renewal, consent refresh, and key
  rotation remain future Grant work and are not represented as implemented.
- The public receiver uses a conservative process-local provider-wide limit of
  120 Grant requests per 60 seconds before PLC work and a 500 ms minimum for
  generic protected `400` responses. A distributed source-network limiter and a
  production-calibrated common response schedule remain deployment-hardening
  work; this POC control bounds aggregate work but is not the final abuse model.

Migration 7 stores immutable authoritative and received revisions, current
lineage pointers, terminal tombstones, exact consent evidence, signing PLC
evidence, and publication attempts. Grant creation and revocation write the
signed revision and outbox entry in one transaction. The receiving provider
validates current PLC state and the signature before disclosing local-account or
precondition detail, then atomically applies ordered revisions.

The public endpoint implements conditional exact-byte convergence:

```http
PUT /hail/grants/{canonical-lowercase-uuidv7}
Content-Type: application/cose; cose-type="cose-sign1"
If-None-Match: *
```

Revision 1 returns `201` with `Location` and a strong representation ETag. An
exact creation retry returns `412` with that same ETag. Later revisions require
`If-Match` for the predecessor digest and return `204`; an exact update retry
also returns `204`. All successful persistence occurs before the response.

### Phase 8-10 Implementation Checklist

The following six milestones decompose Phases 8 through 10 and the thin slice
in `BUILD_ORDER.md`; they do not add protocol scope:

1. **Sender Profile:** publish Alice's DID-scoped, `#hail-messaging`-signed
   profile with one category; retrieve and verify it from Bob's provider, then
   durably retain its exact representation, digest, revision, and PLC evidence
   for rollback checks and later grant consent evidence.
2. **Grant:** have Bob create and sign a grant for Alice; persist immutable
   revisions and publish them through `PUT /hail/grants/{grant_id}`. Implemented
   locally; public deployment verification remains part of Phase 10.
3. **Detached Body:** publish one plain-text Safe Portable Text body from
   Alice's provider and enforce recipient authorization, digest, media type,
   size, and availability during retrieval. Implemented locally; public
   deployment verification remains pending.
4. **Envelope Submission:** sign and submit one Alice-to-Bob envelope; enforce
   recipient, grant, category, timestamp, signature, and replay checks before
   any body transfer. Implemented locally with an indeterminate generic receipt;
   public end-to-end verification remains pending.
5. **Durable Delivery Worker:** persist accepted work before acknowledging it,
   retrieve and verify the body after acceptance, and durably store Bob's
   delivered message across process restarts. Implemented and tested locally;
   public end-to-end verification remains pending.
6. **Delivery Status:** have Bob sign and push a terminal status to Alice, then
   acknowledge the byte-identical status idempotently. Implemented and
   PostgreSQL-tested locally; public end-to-end verification remains pending.

The completed demonstration must also reject an unauthorized category, reject
new envelope acceptance when revocation commits first, preserve delivery
responsibility when acceptance wins that race, reject an invalid signature,
and treat an exact envelope retry as one delivery.

## Phase 9: Durable Delivery Work

Run persisted jobs for body retrieval, integrity checks, state transitions,
terminal status signing, and retry delivery. The earliest slice may execute the
worker loop in the server process, but accepted work must already be durable so
a restart does not lose responsibility.

Migration 10 persists leased delivery work, recipient-and-sender verified body
provenance, and recipient-visible delivered messages. The server runs one
delivery-work claim every five seconds. For isolated local processing, run
`bun run delivery:once` with the provider environment configured; this claims
at most one due item and prints `idle`, `on-hold`, `delivered`, or `failed`.
Repeated invocation after a crash recovers work when its lease expires.

The worker re-resolves the sender DID for each attempt and uses DNS-pinned HTTPS
GET with the signed bearer credential only in the Authorization header. It
does not follow redirects. A `404` triggers one current-DID refresh and a retry
only if the authenticated service endpoint changed. It bounds compressed
transfer and gzip output, checks any `Content-Digest` over transferred bytes,
then verifies the exact uncompressed size, SHA-256 digest, deterministic CBOR,
and `spt-1` schema. It persists retryable conditions with jittered backoff and
a finite signed deadline. A delivered transition stores verified body bytes,
the recipient-specific message, and terminal state in one transaction under a
delivery-row lock. A deadline or failure transition uses the same lock and
cannot publish a message after a competing terminal outcome.

Delivery state and its signed status snapshots are stored locally. An
authenticated submission may receive a `200` signed current status, including
`accepted`; `202` remains only an indeterminate network receipt. Bob pushes
terminal signed snapshots to Alice and retains a durable retry outbox.

The intended process split is:

```bash
bun run server
bun run worker
```

## Phase 10: End-To-End Scenario

The first successful scenario is:

1. Register Alice through the app provider.
2. Register Bob through the dev provider.
3. Publish and verify both Address Bindings.
4. Publish Alice's signed Sender Profile and category manifest.
5. Bob creates a grant for Alice.
6. Bob's provider publishes the signed grant to Alice's provider.
7. Alice's provider publishes a detached body and signs an envelope.
8. Bob's provider authenticates and atomically accepts the envelope.
9. Bob's provider retrieves and verifies the body.
10. Bob's provider durably stores the delivered message.
11. Bob's provider pushes a signed terminal status.
12. Alice's provider idempotently acknowledges that status.

## Phase 11: Single-Use Reply Capabilities

The reply authorization rules in [`../spec/envelopes.md`](../spec/envelopes.md#reply-authorization)
and terminal atomicity rules in
[`../spec/delivery-state.md`](../spec/delivery-state.md#terminal-transition-atomicity)
are the authority for this phase. Replies reuse `POST /hail/envelopes` and
the detached-body and signed-status operations; they do not depend on a Grant
in the reverse direction. A reply invitation is an explicit signed
`reply.allowed: true` with a signed `reply.until` on the original envelope.
Possession of its UUID alone does not authorize a reply.

Migration 12 adds a persisted authorization discriminator and original-message
reference to both sent and received envelopes, plus one durable capability row
for each outgoing replyable envelope. Existing Grant envelopes remain valid.
The capability's `available`, `claimed`, or `consumed` state and its claim
owner are serialized under a PostgreSQL row lock. A recipient checks the
original sent envelope's exact parties, signed permission and deadline, and
the authenticated reply signature before reserving a new reply. A duplicate
reuses its stored replay result; a competing sibling cannot take the claim.
`on-hold` retains the claim; the serialized terminal delivery transaction
consumes it on `delivered` or releases it on `failed` or `cancelled`. A released
invitation can accept one replacement with a **new** UUIDv7 before its signed
deadline. A delivered reply may opt in to a further single-use invitation,
forming a linear conversation; replies default to `reply.allowed: false`.

Local authoring from `/home/j4crev/Dev/hail-server-ts`, after publishing the
body bytes and using the correct provider environment:

```bash
bun run envelope:create -- <original-sender-did> <active-grant-id> <body-digest> updates --reply-until <future-unix-seconds>
bun run envelope:submit -- <original-sender-did> <original-message-id>
bun run body:publish -- <reply-sender-did> examples/alice-body.txt
bun run envelope:reply -- <reply-sender-did> <original-message-id> <published-reply-body-digest>
bun run envelope:submit -- <reply-sender-did> <reply-message-id>
```

The original and reply commands run on **different** providers. The first
sender must have a current Grant from the original recipient; the reply sender
needs the original *accepted* incoming envelope and the valid signed
invitation, not a Grant. Optional `--reply-until <future-unix-seconds>` on
`envelope:reply` invites exactly one further reply. Both creation commands
print the new message ID and payload digest without printing bearer tokens.
The recipient returns a signed current status when processing completes within
the response window; generic `202` remains indeterminate. Unsolicited or
expired invitations, wrong-party claims and competing siblings do not result
in acceptance or body retrieval. Exact retries preserve the original claim.

The existing provider environment is sufficient; this phase adds no secret
or configuration variable. The sender and recipient must each
retain their existing publicly activated custodial POC DID state. Recovery
after restart uses the committed capability, replay, delivery-work, and status
rows; the in-process workers remain executors over those durable records.
Do not delete an accepted reply or its claim while delivery is nonterminal.
Migration 12 is forward-only. A production deployment requires backups of
both provider databases and a matching provider image; reverting the image
alone does not reverse persisted reply state.

To verify the local PostgreSQL 14.4 integration case against a disposable
`DATABASE_URL`, run:

```bash
bun --bun vitest run test/reply-capabilities.integration.test.ts
```

It exercises competing signed replies, authenticated retry, on-hold claim
retention, failure and cancellation release, replacement delivery and terminal
consumption, expired or unsolicited invitations, a further solicited reply,
and independence from subsequent original-Grant revocation. Local validation
does not demonstrate public HTTPS or independent infrastructure. The first
public reply scenario requires a **new** active Grant and a fresh signed
original envelope: the prior end-to-end demonstration Grant is terminally
revoked and its envelope did not permit replies.

## Phase 12: Backend Hardening

The public POC proves one delivery and one invited reply. This phase closes
the remaining operational and conformance gaps before expanding the body
format or treating the POC as production-ready. The separate
[`production-portable-custody.md`](production-portable-custody.md) records the
user-held-key ceremony and the currently inactive transfer boundary. The
rules in
[`../spec/http-binding.md`](../spec/http-binding.md#bounded-response-schedule),
[`../spec/did-profile.md`](../spec/did-profile.md#key-rotation),
[`../spec/envelopes.md`](../spec/envelopes.md#validation-order), and
[`../spec/delivery-state.md`](../spec/delivery-state.md#terminal-transition-atomicity)
remain authoritative.

1. **Protected-response schedule and bounded work.** Measure complete
   validation paths on a representative supported host: malformed CBOR/COSE,
   unavailable local account, missing/revoked Grant, absent or competing reply
   claim, unknown key, invalid signature, authenticated duplicate and accepted
   envelope, and unknown/valid delivery-status correlation. Record sample size,
   latency distribution, concurrent load, clock source, machine profile and
   response shape without logging tokens or signed envelope bytes. Choose a
   minimum bound above observed normal validation time; use one monotonic
   schedule for generic responses, a bounded processing deadline for
   network-dependent PLC resolution, and a relationship-independent provider
   work limit. Randomized delays do not hide repeatable differences. Signed
   detailed responses may complete before the bound but must not be returned
   before the schedule. A processing timeout returns the same generic `202`
   as an unauthenticated miss; it is not an acceptance promise. Measure timing
   repeatedly through the real Hono routes before and after rollout.
2. **PLC key rotation and service moves.** Build fixture PLC operation logs
   with authorized key rotation and a new `HailMessaging` service base. Test
   current-role signature verification, forced refresh after an unknown or
   failed cached key, removal of old keys, DNS-pinned endpoint refresh after
   `404`/`421`, refusal to follow redirects, status re-signing under the new
   authorized messaging key without incrementing a semantic revision, and
   preservation of grant/reply/replay state through fenced ownership transfer.
   Do not simulate a real provider move by blindly changing PLC service state:
   the serialization fence and durable import in the delivery-state spec are
   required before continuity can be claimed.
3. **Negative and restart coverage.** Complete the verification matrix below
   with deliberately malformed signed objects, expired/mismatched bearer
   authorizations, decompression and SPT limit failures, concurrent replay
   submissions, restart after acceptance and during an ambiguous PLC request,
   and byte-identical retries after an ambiguous transport response. Verify
   protected `202`/uniform `404` shape and that no unauthenticated request
   creates replay, reply-claim, delivery, or message state. Use disposable
   PostgreSQL 14.4 fixtures and tests against the real application routing;
   retain exactly the signed and PLC evidence required for audit.
4. **POC-to-production boundary.** Resolve the PLC 72-hour recovery policy,
   portable custody and independent operation monitoring, calibrated
   source-network abuse limits, and migration/backups before any claim of
   independent production federation. Record tested commits, commands,
   observed timings, limitations, and restoration procedure before deploying
   a hardening change to both providers.

Start locally in `/home/j4crev/Dev/hail-server-ts` with the existing Bun
toolchain. For the first schedule slice, run `bun run typecheck`, `bun run
build`, and `bun run test test/envelope-routes.test.ts` followed by the entire
ordinary suite. Run the relevant opt-in PostgreSQL integration cases with a
disposable `DATABASE_URL` **sequentially**: concurrent initial migration
bootstraps can race on the migration catalog. Use a bounded observation
command on a representative host only after fixture preparation; compare
generic response status, headers and bytes as well as latencies, and keep
synthetic request counts below the provider-wide 120-per-minute limit.
The current 750 ms envelope/status minimum is a provisional implementation
value, not a measured production calibration. Body retrieval and Grant
protected responses have their own provisional schedules and will be measured
and aligned as this phase proceeds.

This phase adds no mandatory environment variable for the first local slice.
If a calibration or work limit becomes configurable, validate safe bounds at
startup and document both production values and fixture values. Check process
restarts and stable generic responses before a staged public rollout; keep a
logical backup of both provider databases and the previous image. Timing
measurements and fixture payloads must not appear in production logs or
contain bearer tokens, private keys, or populated `.env` values. Explicit
transport errors (`405`, `413`, `415`), public PLC-derived `421`, and
relationship-independent `429` remain outside the protected schedule.

### Fenced Provider-State Transfer Inventory (Local Prototype)

The continuity procedure in
[`../spec/delivery-state.md`](../spec/delivery-state.md#status-signature-profile)
requires an exclusive fence before exporting or importing an active DID.
The local migrations 13–21 gate writers on the account-row serialization
point, including Grant creation/revocation/publication, envelope acceptance and
reply claims, body authorization and sent-envelope creation, the delivery
worker, status revision signing and terminal-status publication, and account
activation or messaging-key changes. An unfenced PostgreSQL snapshot is not a
portable state transfer.

For one local DID, the transfer inventory includes:

- `provider_accounts`, public provider-key metadata, user-controlled public
  recovery/identity keys and monitor evidence in `portable_custody_evidence`,
  PLC operation evidence and read-back
  snapshots, hosted and selected `address_bindings`, and local
  `sender_profiles` with their signing/activation evidence;
- authoritative `grant_lineages`, immutable `grant_revisions`, consent
  evidence, terminal tombstones and leased `grant_publications`;
- `detached_bodies`, hashed `body_authorizations`, `sent_envelopes`,
  `received_envelopes`, and the complete `reply_capabilities` claim state;
- `delivery_work`, `verified_body_provenance`, `delivered_messages`,
  `delivery_status_payloads`, all retained `delivery_status_wrappers`,
  `terminal_status_publications`, and `sent_delivery_status` including audit
  gaps and signing PLC evidence.

Foreign-party records in one provider database must be exported only when
they belong to the migrating DID's serialization domain. The import must
validate all signed representations, FK relationships, replay identities,
lease ownership, current status revisions, and authorization references before
it becomes active. The new provider stays unable to process Hail operations
 until the old provider has stopped committing under the exclusive fence, the
validated snapshot is acknowledged, and the PLC messaging-key/service update
meets the recovery-window policy. An aborted cutover may release the old fence
only after invalidating the inactive import. Test concurrent acceptance,
 delivery completion, revocation, and status publication on both sides of the
 fence with disposable databases before a live cutover. The local fixture does
 this, but the live POC DIDs are custodial and registered only in a private PLC
 directory: they cannot be activated under the production portable profile.

### Phase 13: Portable-Custody Cutover Rehearsal (Local)

The proposed production ceremony, the selected user-controlled address-domain
policy and conservative 72-hour recovery quarantine are recorded in
[`production-portable-custody.md`](production-portable-custody.md). They require
user-held identity and top recovery keys, destination-owned operational keys,
and independent PLC monitoring. The existing custodial public POC accounts do
not meet those prerequisites; **do not invoke migration-fence or staging CLIs
against those accounts**.

The local provider prototype generates destination rotation/messaging keys
encrypted only under the destination provider's key, fences all source writers,
exports a signed snapshot without user or provider private-key ciphertext,
checks user-controlled identity consent over the exact snapshot and signed PLC
operation, and verifies the user's fresh Address Binding. The target stages
the snapshot inactive. Two agreeing PLC log/audit witnesses plus an independent
signed monitor attestation must remain stable for 72 hours of locally observed
time before the materialization method can run. In the disposable fixture it
imports the state transactionally, rewraps *only destination-owned* keys under
the imported account ID, re-signs the current Sender Profile, normalizes
inherited leases, fails expired pending work, and creates a signed activation
receipt. The old provider verifies it against current PLC state and remains
permanently fenced in `retired` state.

Use two disposable PostgreSQL 14.4 databases, one for each provider domain:

```bash
DATABASE_URL=postgresql://hail:password@127.0.0.1:5432/hail_source \
TRANSFER_TARGET_DATABASE_URL=postgresql://hail:password@127.0.0.1:5432/hail_target \
  bun --bun vitest run test/migration-fence.integration.test.ts
```

The fixture tests a writer that commits before the fence, rejected admissions
and worker/publication writes after it, an in-flight status attempt that
cannot commit after fencing, immutable export and target import verification,
user/private-key custody separation, invalid user signatures and incorrect
PLC operation signers, an inactive target before recovery finality, mirror and
monitor failures, an address-verification mismatch, transaction rollback on
account conflict, terminal status re-signing, and permanent source retirement.
The two-database fixture uses simulated independent read paths, monitor
operation, and user-controlled address publication. There is **no public
production activation or PLC submission CLI**. Full production deployment
still needs a real user-controlled vault and recovery test, independent
monitor and mirror operators, historical audit policy, external domain
publication, and a canonical `plc.directory` DID rather than the private
custodial demonstration DIDs.

## Required Verification Cases

Automated tests must cover at least:

- unknown sender and unavailable recipient state
- malformed CBOR or COSE
- invalid signatures and wrong Hail key roles
- missing, invalid, expired, or revoked grants
- a category outside grant scope
- expired envelopes
- exact duplicate submission
- message-ID reuse with different content
- concurrent submissions for one replay key
- invalid, expired, or mismatched body authorization
- body digest, size, media-type, and deterministic-encoding failures
- PLC key rotation and forced cache refresh
- `421 Misdirected Request` after a service migration
- restart during ambiguous PLC registration
- restart after envelope acceptance
- byte-identical retry after ambiguous transport failure
- common bounded timing behavior for protected generic responses

## Deployment Procedure

After local integration tests pass:

1. Provision one public Linux VPS.
2. Permit inbound TCP 22, 80, and 443; restrict SSH to trusted sources when
   practical.
3. Install Docker Engine and its Compose plugin.
4. Clone the three pinned repositories.
5. Generate independent database credentials and provider secrets.
6. Start private PLC and provider databases without publishing their ports.
7. Start both provider instances on the private Compose network.
8. Configure host-based Caddy routing for both domains.
9. Create the public DNS records only after the services are ready to answer.
10. Confirm Caddy obtained valid certificates for both domains.
11. Verify WebFinger, Address Binding, health, and federation endpoints from a
    machine outside the VPS network.
12. Run the complete end-to-end and negative test suites against public URLs.

### Selected Hosting Profile

The selected POC target is one Hostinger Ubuntu 24.04-or-newer VPS with at least 2 vCPU,
4 GB RAM, 40 GB storage, and a static public IPv4 address. Cloudflare remains
the authoritative DNS provider in DNS-only mode for initial validation.

Cloudflare Workers and Vercel are not selected because this POC requires three
durable PostgreSQL databases, a private long-running PLC directory, two
long-running Bun services, private service networking, and durable background
work. Their serverless execution models would split or replace the architecture
being tested rather than host it directly.

The checked-in deployment is:

```text
hail-server-ts/deploy/poc/compose.yaml
hail-server-ts/deploy/poc/Caddyfile
hail-server-ts/deploy/poc/.env.example
hail-server-ts/deploy/poc/README.md
```

It exposes only Caddy on TCP 80/443 and optional UDP 443. Provider, PLC API,
PLC sequencer, and PostgreSQL ports remain on private Compose networks. Caddy compression is
disabled so signed COSE retrieval never acquires an HTTP content coding.

### Cloudflare Records

After the VPS exists and its firewall permits TCP 80 and 443, create these two
records:

```dns
hailproto.app.  A  <VPS IPv4>
hailproto.dev.  A  <VPS IPv4>
```

Use `Name: @`, `TTL: Auto`, and `Proxy status: DNS only` in both Cloudflare
zones. Do not add `AAAA` yet. Confirm both public `A` lookups return the VPS
address before starting Caddy.

After IPv4 onboarding and public activation succeed, configure and externally
test static IPv6 on port 443. Add DNS-only apex `AAAA` records only after both
domains pass explicit `curl -6` tests.

### Public Verification Boundary

`activate:public` runs only with `NODE_ENV=production`. Its HTTPS transport:

- accepts only canonical HTTPS DNS URLs
- sends no authorization, cookies, or referrer
- resolves all addresses and rejects the target if any answer is private,
  loopback, link-local, reserved, mapped-private, or otherwise non-global
- pins one validated address into the actual TLS connection
- retains the original hostname for certificate and SNI verification
- applies a five-second connection timeout and shared ten-second operation
  deadline
- performs redirects only in the WebFinger verifier and revalidates every
  target
- streams responses under the 64 KiB JRD and 16 KiB binding limits
- rejects duplicate JSON member names at every nesting depth

Public activation stores verification mode `public`; local in-memory activation
stores mode `local`. The two are not interchangeable.

## Documentation Standard

Every implementation phase added to this guide must record:

- purpose and security assumptions
- exact command and working directory
- files created or changed
- configuration variables and generated-value instructions
- expected output or HTTP result
- verification command
- common failure modes
- restart, cleanup, or rollback behavior

Never record private keys, bearer tokens, database passwords, encryption keys,
or populated `.env` files. Commit only safe `.env.example` files.

## Implementation Log

### 2026-09-27: Architecture And Guide

- Selected one reusable provider implementation deployed twice.
- Selected a hybrid topology with public HTTPS Hail endpoints and a private PLC
  directory.
- Selected sibling checkouts under `/home/j4crev/Dev`.
- Confirmed the Hail repository uses Bun 1.4.0, Node 24 or newer, strict
  TypeScript, Vitest, and the private `@hailproto/codec` workspace package.
- Confirmed the official PLC implementation is
  `did-method-plc/did-method-plc`, uses Node and pnpm, serves on port 2582 by
  default, and requires PostgreSQL for a durable POC.
- Added this guide before creating the provider or PLC sibling repositories.

### 2026-09-27: Initial Scaffold

- Created `/home/j4crev/Dev/hail-server-ts` as an independent Git repository.
- Added Bun and Hono process scaffolding, strict environment validation,
  liveness and readiness endpoints, disclosure-safe fallback errors, and unit
  tests.
- Installed Bun 1.4.0 dependencies with Hono 4.13.9, `@did-plc/lib` 0.0.4,
  TypeScript 7.0.2, and Vitest 5.0.0.
- Built the sibling `@hailproto/codec` package before importing its distribution
  output.
- Cloned the official PLC repository at commit
  `996e23b5ced9c15b32bcc612dd304880342ca4ab`.
- Verified Node 26.7.0, Docker 29.7.2, and Docker Compose 5.5.1 on the development
  machine.
- Found that `corepack` is not installed on this machine. The PLC checkout pins
  pnpm 11.11.0. Installed that exact version with Bun, then successfully ran
  `pnpm install` and `pnpm build` without modifying the PLC checkout.
- Confirmed the pinned PLC server cannot start without `DATABASE_URL`; its
  sequencer attempts to access an undefined database. PostgreSQL is required.
- Docker 29.7.2 is present, but the current user cannot access the Docker socket.
  PostgreSQL-backed PLC startup remains blocked until Docker access is granted
  or an independently managed PostgreSQL URL is supplied.
- Wired the official PLC client's health operation into provider readiness.
  Liveness remains process-only; readiness now fails closed when PLC is
  unavailable.

### 2026-09-27: PostgreSQL Foundation

- Rebooted the development machine so the current login inherited membership
  in the `docker` group, then verified Docker with the `hello-world` image.
- Started the pinned PLC server through its PostgreSQL-backed ephemeral test
  harness and received `200 {"version":"0.0.0"}` from `/_health`.
- Added the first provider migration with durable account onboarding state,
  role-separated encrypted key records, exact PLC operation evidence, and
  immutable signed Address Binding storage.
- Added an advisory-locking, checksum-verifying migration runner using Bun SQL.
- Applied the provider migration twice against PostgreSQL 14.4 to verify
  idempotency. The resulting tables were `schema_migrations`,
  `provider_accounts`, `account_keys`, `plc_operation_evidence`, and
  `address_bindings`.
- Changed provider startup to apply migrations before listening and changed
  readiness to require successful queries to both provider PostgreSQL and the
  configured PLC directory.
- Ran provider PostgreSQL, PLC PostgreSQL, the official PLC server, and the Hono
  provider together. The provider returned `200` from `/health/ready`; both
  temporary PostgreSQL containers were then stopped and removed.

### 2026-09-27: Custodial Onboarding Through Address Staging

- Replaced the stale npm `@did-plc/lib` 0.0.4 dependency with the locally
  pinned official PLC library 0.1.0 from the sibling checkout.
- Added direct, pinned dependencies for PLC key generation, DAG-CBOR encoding,
  operation CIDs, and multibase encoding rather than relying on transitive
  packages.
- Added canonical Hail address handling for the provider-issued POC addresses.
- Added independent P-256 PLC rotation, Ed25519 identity, and Ed25519 messaging
  key generation.
- Added AES-256-GCM private-key encryption with per-record nonces and versioned
  account/role/algorithm/public-key AAD.
- Added regular `plc_operation` creation with `prev: null`, empty
  `alsoKnownAs`, the two Hail verification methods, and the canonical `#hail`
  `HailMessaging` service.
- Added atomic preparation, pre-request `submission-unknown` persistence,
  exact-operation retry, CID-based collision detection, complete PLC read-back
  verification, and monotonic state transitions.
- Added signed Address Binding generation, local signature verification, exact
  COSE byte retention, SHA-256 representation digesting, and 90-day expiry.
- Added `bun run onboard -- <address>` as a restart-safe CLI.
- Enforced the persisted PLC registry origin during every resumed query and
  submission so a configuration change cannot publish a prepared identity to a
  different registry.
- Recompute the operation DAG-CBOR, CID, derived DID, signature validity, and
  complete expected state from persisted bytes before every network action.
- Strengthened DID-document read-back checks to require exact Hail key
  multibase values, controllers, method types, cardinality, aliases, and the
  sole expected `#hail` service.
- Persisted the runtime-validated PLC document, data, operation-log, and audit
  snapshots in the same transaction that advances the account to
  `did-registered`.
- During live testing, the first PLC request succeeded but read-back initially
  failed because equivalent JSON objects were compared by property order. The
  verifier was corrected to use structural deep equality. Rerunning the CLI
  reconciled the already-registered persisted genesis without generating new
  keys or submitting a duplicate operation.
- Successfully onboarded `alice@hailproto.app` to an isolated local test DID
  and reached `address-staged`. A second invocation returned the same account
  and DID.
- Repeated the complete live test after the stricter evidence checks and
  verified that all three migrations applied and all four PLC read-back
  snapshots were retained.
- Verified three encrypted role-key rows with 12-byte nonces, one verified
  442-byte genesis DAG-CBOR representation, one 353-byte Address Binding COSE
  representation, a 32-byte digest, and a 90-day signed lifetime.
- Passed 13 unit tests and strict TypeScript checking. Temporary integration
  databases were stopped and removed after verification.

### 2026-09-27: Local Discovery And Activation

- Added Hono WebFinger and immutable Address Binding routes using the exact JRD
  and COSE media types.
- Split immutable binding hosting from WebFinger selection so the final binding
  resource exists before the domain selects it.
- Added streamed 64 KiB JRD and 16 KiB binding response limits, shared
  ten-second semantic verification deadlines, at most three WebFinger
  redirects, and prohibited binding redirects.
- Added parsed equivalent COSE media-type handling rather than raw string-only
  comparison.
- Added validated PLC operation-log, DID-document, identity-key, messaging-key,
  service, binding-signature, timestamp, representation, and digest checks.
- Allowed unrelated DID verification methods and services while enforcing one
  exact Hail entry for each required role after relative-ID expansion.
- Added durable `activating` state and attempt IDs. Conditional rollback cannot
  unpublish an account completed by a concurrent attempt.
- Added activation evidence constraints and explicit `local` versus `public`
  verification modes.
- Added `bun run activate:local -- <address>` for an in-memory Hono lifecycle
  test. It is deliberately not public-network verification.
- Applied all five migrations over both a previously active test account and a
  fresh database.
- Completed fresh onboarding and local activation for
  `alice@hailproto.app`, repeated activation idempotently, and verified the
  final 32-byte binding digest, hosted and selected timestamps, cleared attempt
  ID, and `local` verification mode.
- Passed strict TypeScript checking and 18 tests. Temporary integration
  containers were stopped and removed.

### 2026-09-27: Public Transport And Deployment Packaging

- Added duplicate-member-rejecting bounded JSON parsing for WebFinger JRDs.
- Added a certificate-validating Node HTTPS transport with all-answer public-IP
  filtering, DNS-to-connection pinning, credential isolation, IPv4/IPv6 range
  checks, connection timeout, and shared operation deadline.
- Added `bun run activate:public -- <address>`, restricted to production mode,
  with durable `public` activation evidence.
- Added a multi-stage provider Dockerfile that builds the pinned sibling Hail
  codec and official PLC library rather than relying on host build output.
- Added a two-provider Compose deployment with isolated provider databases,
  private PLC/database networking, read-only provider filesystems, health
  checks, and Caddy-only ingress.
- Corrected the official PLC production-image configuration to use
  `DB_CREDS_JSON`, `DB_MIGRATE_CREDS_JSON`, and `ENABLE_MIGRATIONS` rather than
  the development launcher's `DATABASE_URL`.
- Found and corrected a container build issue where inherited TypeScript build
  metadata suppressed missing PLC library output. The build now excludes
  `*.tsbuildinfo` and forces the library build.
- Installed sibling package runtime dependencies at their own module-resolution
  roots inside the provider image.
- Added canonical decoded startup validation for `KEY_ENCRYPTION_KEY` after a
  noncanonical 43-character test value passed the earlier shape-only check.
- Built both provider and official PLC images successfully.
- Started the private services and confirmed both providers, PLC, and all three
  PostgreSQL databases became healthy; the final deployment also runs the PLC
  sequencer as a separate private process.
- Onboarded and locally activated Alice and Bob from inside their respective
  built provider containers.
- Validated the Caddy configuration and removed the complete temporary stack
  and test volumes.
- Final review tightened IPv6 eligibility to global unicast `2000::/3`, moved
  DNS resolution under the operation deadline, preserved `__proto__` as an own
  JSON member, restricted whitespace to the JSON grammar, made active/local
  accounts require full re-verification before promotion to public evidence,
  and prevented concurrent activation attempts from sharing cancellation
  authority.
- Rebuilt a clean seven-service private stack with the PLC sequencer, confirmed
  its leadership, onboarded Alice, observed her PLC operation at sequence 1,
  and activated her locally from the built provider image.
- Passed strict TypeScript checking, 31 tests, Compose interpolation validation,
  Caddy configuration validation, and whitespace-error checks.

### 2026-09-27: Public POC Deployment

- Provisioned `2.25.253.153` with Ubuntu 26.04, 2 vCPU, 8 GB RAM, and 96 GB
  available storage.
- Verified the VPS ED25519 host key out of band before sending any deployment
  material.
- Installed Ubuntu's Docker 29.1.3 and Compose 2.40.3 packages.
- Enabled UFW with default-deny inbound policy and only SSH, HTTP, HTTPS, and
  HTTP/3 ingress.
- Disabled SSH password and keyboard-interactive authentication while retaining
  key-only root administration for this POC.
- Transferred source without Git metadata, dependencies, build output, or local
  environment files; generated all deployment secrets directly on the VPS in a
  mode-`0600` `.env` file.
- Corrected a Docker 29 build race by assigning the shared provider image build
  to one Compose service instead of building the same tag concurrently from
  both provider services.
- Published DNS-only Cloudflare apex `A` records for both domains. No `AAAA`
  records are present.
- Obtained valid Let's Encrypt certificates for both domains and confirmed
  external HTTPS readiness.
- Onboarded `alice@hailproto.app` as
  `did:plc:rewawq7tylmrzaaprd27sdhb` and `bob@hailproto.dev` as
  `did:plc:ih42yibclij7lv6264hoaodo`.
- Confirmed the PLC sequencer assigned sequence 1 and 2 respectively.
- Completed hardened public activation for both accounts; each durable account
  record reports state `active` and verification mode `public`.
- Confirmed public WebFinger and immutable COSE resources over HTTP/2 with exact
  media types, no content encoding, bounded content lengths, and Caddy-only
  public ingress.

### 2026-09-27: Sender Profile Slice

- Added the six-step implementation checklist as a decomposition of existing
  Phases 8 through 10 rather than new protocol scope.
- Extracted reusable current-state PLC resolution that validates the operation
  log, cross-checks document data, compares the complete rendered document,
  enforces distinct Hail keys, and canonicalizes the Hail service base.
- Added immutable local Sender Profile revisions signed by the current
  `#hail-messaging` key, exact COSE persistence, representation digests,
  idempotent unchanged-content retries, and transactional revision fencing.
- Added `GET /hail/profiles/{sender_did}` with exact path handling, content
  negotiation, strong ETags, conditional `304`, explicit Problem Details, and
  no content coding.
- Added hardened remote profile verification with current PLC authorization,
  safe public HTTPS transport, redirect rejection, size bounds, exact ETag
  checks, timestamp and rollback checks, and conditional retrieval.
- Added durable remote profile and PLC evidence retention so rollback and
  same-revision conflict protection survives process restarts and exact consent
  evidence is available to the grant milestone.
- Added `profile:create` and `profile:verify` CLIs plus the first Alice profile
  authoring example.
- Corrected PostgreSQL JSONB writes to bind structured values rather than JSON
  strings and retained decoding compatibility for previously stored onboarding
  evidence.
- Passed strict TypeScript checking and 44 tests. A clean seven-service local
  stack applied migration 6, created and idempotently reused Alice's profile,
  served its exact COSE bytes, and had Bob's provider verify and retain it twice
  with the second request using conditional `304` behavior.

### 2026-09-27: Signed Grant Slice

- Added canonical UUIDv7 generation and migration 7 for immutable Grant
  revisions, current lineage pointers, consent and PLC verification evidence,
  terminal tombstones, and a leased publication outbox.
- Added Bob-side `#hail-identity` signing with current PLC authorization,
  verified Alice Address Binding and Sender Profile consent hashes, one-active-
  pair enforcement, idempotent creation, and terminal signed revocation.
- Added Alice-side conditional `PUT /hail/grants/{grant_id}` with a 256 KiB
  streamed request ceiling, exact media and path handling, current PLC signature
  verification, protected uniform failures, strong ETags, ordered revision
  checks, and exact retry convergence.
- Extended the DNS-pinned HTTPS transport with a header-restricted `PUT` mode
  and added an in-process durable publisher with endpoint refresh, leased claims,
  revision ordering, bounded exponential backoff, jitter, and `Retry-After`
  handling.
- Added `grant:create`, `grant:revoke`, and `grant:publish` CLIs plus the closed
  `examples/bob-to-alice-grant.json` authoring document.
- Passed strict TypeScript checking and 77 ordinary tests. An opt-in PostgreSQL
  14.4 integration test applied migration 7 and exercised authoritative and
  received creation, exact retry, revocation, conflict rollback, publication
  ordering, acknowledgement, and cleanup against a clean database.
- Built and deployed provider commit `a2eb41fd280a9c1f7992bbb8a684544d4d341c83`
  after custom-format logical backups of both provider databases were written to
  `/var/backups/hail-poc/pre-grant-20260928T020119Z`. Both databases applied
  migration 7 and both replacement providers became healthy before testing.
- Bob created Grant `01a0e5c0-8657-7496-928b-a598cc79d0d0` for Alice's
  `updates` category. Revision 1 was 697 bytes and converged in one publication
  attempt with `201`; Bob's repeated unchanged create returned the same Grant ID,
  digest, and exact representation.
- Bob then committed terminal revision 2 locally. Its 731-byte representation
  carried the 32-byte revision-1 digest, converged at Alice in one attempt with
  `204`, and left both providers at current revision 2 with status `revoked`.
  Repeating the revoke command returned the existing revision and digest.
- All eight production containers remained healthy and provider logs contained
  no errors during the rollout and live Grant lifecycle.

### 2026-09-28: Detached Body Slice (Local)

- Added migration 8 for immutable per-sender exact deterministic CBOR bodies
  and recipient/message-scoped authorizations. Body bytes are content-addressed
  by SHA-256; the database stores only SHA-256 bearer-token hashes and retains
  each shared body through the latest authorization commitment.
- `body:publish` builds a plain-text `spt-1` document from a UTF-8 file,
  validates the codec schema and deterministic encoding, enforces 256 KiB, and
  publishes it for a publicly activated local sender DID. An exact repeat reuses the bytes.
- `body:authorize` allocates a random 32-byte token for one recipient DID and
  UUIDv7 message ID and returns it **once** to its local caller. Preserve that
  value for the future signed envelope; repeating this command with the same
  message ID is a conflict. No bearer token or populated environment file is
  committed to source control. The minimum commitment is 30 days from issuance.
- `GET /hail/bodies/{digest}` checks canonical unpadded base64url path and
  header token, token hash, expiration and digest match. It returns exact
  uncompressed CBOR bytes and a `Content-Digest` header on success. Invalid
  credentials and paths return uniform `404` Problem Details with a 150 ms
  process-local minimum response interval; valid-token missing bodies return
  retryable `503`. A process-local provider-wide rate cap applies before lookup.
- Local usage from `/home/j4crev/Dev/hail-server-ts` after setting the
  provider's existing `.env` values and applying migration 8:

  ```bash
  bun run db:migrate
  bun run body:publish -- did:plc:rewawq7tylmrzaaprd27sdhb examples/alice-body.txt
  bun run body:authorize -- did:plc:rewawq7tylmrzaaprd27sdhb did:plc:ih42yibclij7lv6264hoaodo <new-uuidv7> <digest-from-publish> <unix-seconds-at-least-30-days-ahead>
  ```

  The publish command prints the 43-character digest, exact size, media type,
  profile, and HTTPS URL. The authorize command prints the one-time bearer
  value. A recipient uses `GET` with `Authorization: Bearer <token>` and
  `Accept: application/hail-body+cbor` over HTTPS. Invalid credentials return
  `404`; the same valid credential may be retried until expiration. Client
  transport, envelope-signature binding, and receiver integrity verification
  are part of the subsequent envelope/delivery slices.
- Verified TypeScript and build, 82 ordinary tests, and a clean PostgreSQL 14.4 integration
  run of migration 8, exact-byte persistence, token hashing, expiration,
  mismatch rejection, and retention extension. The temporary database was
  removed. To repeat the integration case with a disposable database, set
  `DATABASE_URL` and run
  `bun --bun vitest run test/body-repository.integration.test.ts`.
- No public deployment or end-to-end body fetch has been performed for this
  slice. Rollback before a public rollout consists of redeploying the previous
  provider image; keep migration 8 applied because migrations are forward-only.
  A body or authorization already committed for a signed envelope must not be
  deleted before its availability commitment ends.

### 2026-09-28: Envelope Submission Slice (Local)

- Added migration 9 for byte-exact sent envelopes and received replay/acceptance
  records, including signed token-bearing representations, digests, signing PLC
  evidence, and accepted timestamps. An accepted row is durable work for the
  subsequent delivery worker; it does not mean the body was retrieved.
- Alice's `envelope:create` checks public activation, a currently active
  received Grant, category scope, a previously published body, and current
  sender PLC messaging-key authorization. It signs a fresh UUIDv7 envelope
  with a seven-day delivery deadline, 31-day body commitment and independently
  generated recipient-specific bearer token. One database transaction stores
  the signed bytes, token hash, and retention extension; the raw token appears
  only inside the persisted signed envelope and is never printed by this CLI.
- `envelope:submit` reads the stored representation by sender DID and message
  ID, refreshes Bob's current PLC service, and posts those exact bytes using
  DNS-pinned HTTPS without redirects. A `202 {"outcome":"received"}` response
  is explicitly **indeterminate**. The same command and message ID may be
  retried after a transport failure; do not run `envelope:create` again for
  the same logical send.
- Bob's `POST /hail/envelopes` applies the 16 KiB streamed limit and safe
  transport errors before protocol work. It performs a preliminary Grant
  candidate lookup, verifies the `#hail-messaging` signature against current
  PLC state, checks recipient public activation and service authority, then
  locks the authoritative Grant lineage while checking scope, expiry, replay,
  and acceptance. A Grant revocation committed first prevents new acceptance;
  an acceptance committed first remains durable. Exact retries do not create
  another acceptance, and authenticated message-ID conflicts are fenced.
  The endpoint emits only the privacy-preserving generic `202` receipt at a
  fixed 750 ms minimum. The measured, deployment-calibrated common schedule
  and signed detailed acceptance snapshot are future delivery-status work;
  no `202` claims successful Hail acceptance.
- After publishing Alice's body and **creating/publishing a new active Bob-to-
  Alice Grant** (the earlier demonstration Grant was terminally revoked), run
  from `/home/j4crev/Dev/hail-server-ts` with the appropriate provider `.env`:

  ```bash
  bun run db:migrate
  bun run envelope:create -- did:plc:rewawq7tylmrzaaprd27sdhb <new-active-grant-id> <published-body-digest> updates
  bun run envelope:submit -- did:plc:rewawq7tylmrzaaprd27sdhb <message-id-from-create>
  ```

  The first command prints a message ID, SHA-256 digest of the exact signed
  envelope **payload** bytes (not the COSE wrapper), and
  destination without printing the bearer token. The second prints the
  indeterminate `received` result or an authenticated signed current status
  when it is available within the response window. The public route is not deployed yet; a
  local end-to-end listener exercise and public verification are still needed.
- Local verification used PostgreSQL 14.4 for migration 9, exact sent-envelope
  persistence, token hashing, successful acceptance, exact retry, ID conflict,
  invalid signature, out-of-scope rejection, and acceptance versus revocation
  ordering. Run the integration test against a disposable `DATABASE_URL` with
  `bun --bun vitest run test/envelope-repository.integration.test.ts`.
  The disposable database is removed after testing; migration rollback is
  forward-only. Accepted rows and signed sent envelopes must remain available
  for the later body worker, retries, and status acknowledgments.

### 2026-09-28: Durable Delivery Worker (Local)

- Added migration 10 and transactionally coupled future envelope acceptance to
  an initial delivery-work row. Existing accepted rows from migration 9 are
  backfilled when migration 10 applies. Two workers claim with row locks,
  `SKIP LOCKED`, and expiring leases rather than duplicating delivery work.
- Added a credential-restricted DNS-pinned HTTPS body GET path, bounded
  identity/gzip transport handling, RFC 9530 Content-Digest checking when
  supplied, recipient/sender-specific body provenance, and exact CBOR/SPT
  verification. Missing authorization is permanent only after the required
  sender-DID refresh; `429`, `503`, transport failures, and interrupted streams
  follow retry classifications.
- Added `delivery:once` and an in-process loop that claims due work, applies
  bounded jittered backoff and Retry-After within the effective deadline, and
  stores delivered body bytes, visible message, and terminal delivery state in
  one locked transaction. A competing failure/deadline transition prevents
  late publication. Terminal rows are immutable in worker operations.
- Passed strict TypeScript checking, build, 89 ordinary tests, and a clean
  PostgreSQL 14.4 migration and integration scenarios for
  post-restart claims, expired-lease recovery, on-hold retry, idempotent
  delivery, permanent body failure, expiration before final publication, and
  grant-revocation ordering. The database container was removed afterward.
  To reproduce, set `DATABASE_URL` to a disposable PostgreSQL database and run
  `bun --bun vitest run test/envelope-repository.integration.test.ts`.
- The public stack has not been updated. For a future rollout, back up both
  provider databases, apply forward-only migrations 8–10, deploy the matching
  provider image to both instances, and verify a **new active Grant** before
  sending an envelope. A terminally revoked Grant cannot authorize a new one.

### 2026-09-28: Signed Acceptance And Terminal Status (Local)

- Corrected the status `envelope_digest` identity to SHA-256 over the exact
  deterministic **envelope payload bytes**, as the protocol requires. Earlier
  temporary integration databases were removed; no migration 9 data was
  deployed to production. Freshly created sent and received records agree on
  this digest and retain the full COSE representation separately.
- Added migration 11 for immutable deterministic status payloads, COSE wrappers
  and signing PLC evidence, a leased terminal publication outbox, and Alice's
  monotonic received-status record. Existing terminal rows from migration 10
  are queued when migration 11 applies. The Bob-side worker writes its terminal
  outbox entry in the same transaction as `delivered` or `failed`.
- Bob signs current status using the currently authorized local
  `#hail-messaging` key after checking public activation and the current PLC
  service. An authenticated eligible `POST /hail/envelopes` may return `200`
  with one tagged COSE_Sign1 accepted or later status snapshot; if processing
  cannot complete within the generic response window it returns the unchanged
  `202 {"outcome":"received"}`. The latter does **not** confirm acceptance.
- Bob publishes terminal `delivered`/`failed` snapshots to Alice's current
  DID-authenticated service via DNS-pinned HTTPS `PUT
  /hail/deliveries/{envelope_digest}`. The outbox persists claims, attempts,
  bounded jittered fixed-schedule retries, `Retry-After`, and acknowledgement.
  `204` alone ends retries; `202` is indeterminate. The deterministic status
  payload and revision remain stable if the local messaging key is replaced by
  a newly PLC-authorized key, allowing another retained COSE wrapper. The POC
  does not yet provide a key-rotation CLI.
- Alice checks the current `#hail-messaging` signer and exact pre-existing
  `(sender DID, message ID, recipient DID, payload digest)` correlation before
  returning `204` for new, duplicate, or stale valid snapshots. Unknown and
  unauthenticated pushes receive generic `202`; authenticated conflicting
  revisions or terminal transitions receive `409`. A first-observed terminal
  revision is accepted and its skipped revisions counted as an audit gap.
- Run `bun run status:publish` in the provider environment to claim at most
  one due terminal status. The server also runs the publisher loop every five
  seconds. `envelope:submit` now verifies and retains a signed `200` response
  at Alice; it still reports `received` without claiming acceptance for `202`.
- Passed the TypeScript checks, build, 92 ordinary tests and 11 disposable
  PostgreSQL 14.4 integration cases covering migration 11, signed acceptance,
  byte-identical status replay, stale acknowledgement, conflicts, audit gaps,
  terminal push, scheduled retry after `202`, and eventual `204`. Repeat with
  a disposable `DATABASE_URL` and
  `bun --bun vitest run test/envelope-repository.integration.test.ts`.
  Forward-only migrations 8–11 require backups before deployment to both
  providers. Provider source commit:
  `0dd5860` (`feat: add detached bodies and signed delivery`). No public
  rollout had been performed at the time of this local validation.

### 2026-09-28: Public Detached-Body And Delivery Verification

- Committed and pushed provider implementation `0dd5860` and protocol guide
  `58b25fe`. Rebuilt the provider production image on the VPS at
  `sha256:7f8d8bea504d42d12feee077bccc02a2cde0cab1a1cb3d46f9ac715941553f74`.
- Before replacement, saved and validated both PostgreSQL custom-format dumps
  under `/var/backups/hail-poc/pre-delivery-20260928T123933Z`. Retained the
  previous provider image as `hail-server-ts:pre-delivery-20260928T123933Z`.
  Both provider databases applied migrations 8–11 and both public readiness
  URLs returned `200`; all eight containers were running, with both providers
  healthy and zero restarts.
- Bob created new Grant `01a0e809-cf1c-7fa5-99f3-c783aa1bfd28` for Alice's
  `updates` category; its active revision 1 converged through one HTTP `201`
  publication attempt. Alice published a deterministic 120-byte SPT body at
  digest `gOa1zi1jmu_F_TJKHG-29WqYx2mq-Wc4ZnOMsrK3gd8`.
- Alice signed and persisted envelope
  `01a0e80a-6718-741b-a7ba-c2eae2481ba7`, with payload digest
  `4p3KSdxky9VLIDhMjPPS1w4haTKu5Pwj8EHTY5Cj4T0`. Bob returned a
  cryptographically verified `accepted` revision-1 status, fetched and
  verified the body over public HTTPS, and stored one delivered message. His
  terminal revision-2 push received HTTP `204` in one attempt; Alice retained
  `delivered` revision 2 with no audit gap. Retrying the identical envelope
  returned the signed delivered snapshot, without a second delivery.
- Public requests without a body token returned uniform `404` Problem Details;
  unsupported envelope and status methods returned `405`. A COSE envelope with
  a valid shape but an unauthorized signing key received only generic `202`
  and reserved no extra delivery; Alice's own CLI rejected an out-of-scope
  category before signing.
- Alice prepared a second signed envelope, then Bob committed Grant revocation
  revision 2. The tombstone converged at Alice; submission of the already
  signed second envelope returned indeterminate `202` while Bob recorded
  `unauthorized` with no delivery work. The first accepted message remained
  `delivered`. The demonstrated new Grant is terminally revoked.
- Production provider logs had no application errors. The detailed, measured
  common response schedule and full multi-provider adversarial timing trials
  remain deployment-hardening work beyond this successful POC exchange.

### 2026-09-28: Reply Capabilities (Local)

- Added forward-only migration 12 with explicit Grant-vs-reply authorization
  columns on sent and received envelopes, cross-references to the original
  received/sent message, and durable single-use reply-capability state.
- Sender authoring now optionally invites a reply through a signed `reply.until`
  value; `envelope:reply` signs an ordinary Hail Envelope using the recipient's
  accepted original message instead of requiring a reverse-direction Grant.
  The default reply has `reply.allowed: false`; an explicit further invitation
  can support a linear chain.
- Recipient validation performs a relationship-scoped preliminary sent-message
  lookup, authenticates the current sender messaging key, and transactionally
  locks the original sender's capability before admitting a reply. An identical
  authenticated retry preserves its claim; a sibling cannot claim the same
  invitation. The delivery transaction keeps the claim on hold, consumes it
  on `delivered`, and releases it on `failed` or `cancelled` so one replacement
  with a new ID may be admitted before `reply.until`.
- Passed strict TypeScript, build, and ordinary tests. PostgreSQL 14.4
  integration exercised six reply cases, including competing signed siblings,
  on-hold retention, terminal failure/cancellation release, replacement and
  consumption, expiry, unsolicited traffic, a further solicited reply, and
  independence from later Grant revocation. The existing 11-case envelope/status,
  one-case body, and one-case Grant integrations also passed after migration 12.
  Built the production image and validated the Compose interpolation. Provider
  source commit: `63d3188` (`feat: add single-use reply capabilities`).
- This was local validation only. Migrations 12 and the reply endpoints were
  not yet deployed at the time of this test. Public reply verification needs a fresh active
  Grant and a fresh original envelope that explicitly permits replies.

### 2026-09-28: Public Single-Use Reply Verification

- Committed and pushed provider source `63d3188` and protocol guide
  `1d3253d`. Backed up and validated both provider PostgreSQL databases at
  `/var/backups/hail-poc/pre-reply-20260928T171842Z` before rebuilding and
  replacing the two providers. Retained the old image under the matching
  `hail-server-ts:pre-reply-20260928T171842Z` tag. The new provider image is
  `sha256:18a415d5ce77f97308643a427b8c2cf31f7af89012ea699a58d550ae594b7db3`.
  Both databases applied migration 12, and both public readiness endpoints
  passed. All eight containers were running; both providers were healthy with
  zero restarts and no application errors in their logs.
- Bob created a new active Grant `01a0e908-a1ae-77ab-802d-052ef09727f5`
  for Alice's `updates` category; revision 1 converged with HTTP `201`. The
  previously demonstrated Grant remained terminally revoked.
- Alice signed and submitted fresh original message
  `01a0e909-54d0-70df-959c-fc5b4201ac09` with an explicit reply deadline
  of Unix second `1793208073` for Bob's DID. Bob returned signed `accepted`,
  retrieved and verified the body, stored the delivered message, and pushed a
  signed terminal status; Alice retained `delivered` revision 2.
- Bob published an independent body and signed two distinct replies referencing
  Alice's original message, without an Alice-to-Bob Grant. They were submitted
  concurrently. Alice accepted and delivered only reply
  `01a0e90a-a0d8-7a21-bfe1-3a4487024d47`. Reply
  `01a0e90a-79c8-75e0-83a1-83b63b487dca` received generic `202` but was
  durably recorded as `unauthorized`, with no delivery work. The invitation
  row identified Bob as its sole permitted recipient and ended in `consumed`
  with the accepted reply's message ID.
- Alice's terminal `delivered` revision 2 reached Bob in one status-publication
  attempt with HTTP `204`. Bob retained the signed status and an exact retry
  of the winning reply returned `delivered` revision 2 without a duplicate
  message. A further reply from Alice was refused because Bob's reply had
  `reply.allowed: false`. The Grant for this reply test remains active.

### 2026-09-28: Backend Hardening, First Local Slice

- Added the Phase 12 checklist above before starting implementation. From the
  development client to the public dev provider, eight sequential samples of
  each generic protected outcome (`malformed` CBOR, missing Grant, and invalid
  signature for a candidate Grant) returned the same `202` receipt. Their
  observed medians were 782, 781, and 782 ms respectively, with observed
  95th-percentile samples of 881, 783, and 785 ms; network jitter is included.
  These 24 samples are a baseline, **not** calibration of the provisional
  750 ms server-side floor: authenticated, concurrent, and status paths still
  require complete-path measurements on the supported host.
- Replaced separate envelope/status scheduling logic with one shared,
  monotonic provider-wide work gate: a provisional 750 ms response floor,
  10-second protected processing deadline, and 32 concurrent validations.
  Saturation yields a relationship-independent `429`; requests missing the
  response window receive the exact generic `202`, never a misleading
  acceptance receipt. After the deadline, verification checkpoints prevent a
  delayed PLC response from creating new replay or delivery state. When the
  official PLC client's HTTP request cannot be cancelled, its still-pending
  work retains a gate slot rather than allowing unlimited new requests.
- Added repeated Hono response observations, shared gate and timeout checks,
  and a delayed PLC fixture proving that an aborted validation never reserves
  an envelope. The provisional values are not exposed as unvalidated startup
  environment variables. Grant and body schedules have not yet been aligned.
- Built a two-operation fixture with the pinned PLC library: signed genesis
  followed by signed messaging-key rotation and HTTPS service migration.
  The resolver validates the complete operation log and rendered document;
  an old-key envelope succeeds before rotation and is rejected afterwards,
  while a newly authorized key succeeds. A body `404` at the old authenticated
  endpoint triggers fresh PLC resolution and retrieval at the new endpoint,
  without following an HTTP redirect. This tests resolution and endpoint
  selection, **not** continuity-preserving provider migration: the fenced
  state export/import ceremony is still required by the specification.
- Ran TypeScript, build, ordinary protocol tests, and sequential PostgreSQL
  integration tests for the envelope/status and reply paths. This slice is
  local only; the public providers continue to run the prior migration-12
  image. The next hardening work is transport-level PLC request cancellation,
  complete-path timing calibration on the VPS, remaining negative/restart
  cases, and the fenced state-transfer test.

### 2026-09-28: Backend Hardening, Bounded PLC Read Slice

- Replaced unbounded PLC *reads* with an adapter that obtains data from the
  configured private directory using a single cancellable five-second
  request/stream deadline, a 1 MiB decoded-byte ceiling, no redirects, and
  duplicate-member-rejecting JSON parsing. Canonical DID validation occurs
  before constructing directory paths. `404` still raises the official
  `PlcClientError` shape needed for ambiguous genesis reconciliation.
- Left `sendOperation` delegated to the pinned official PLC client. A write
  whose result is ambiguous is still reconciled against the persisted signed
  genesis CID and bytes before any retry. Write cancellation and full
  ambiguous-write restart coverage remain separate hardening work.
- Added fixtures for stalled response headers, a stalled streamed body,
  declared and streamed size excess, malformed/duplicate JSON and bodyless
  `404`. The request-level gate continues to bound outstanding protected work
  even if the remote side does not honor abort.
- Verified the adapter read-only against the existing private PLC directory
  through a temporary authenticated SSH tunnel. Alice's and Bob's public Hail
  DIDs each resolved with one validated operation and their expected
  `https://hailproto.app/hail` and `https://hailproto.dev/hail` services. Alice's
  audit log returned one entry and an unknown syntactically valid DID returned
  an onboarding-compatible `404`. The tunnel was then closed. No PLC operation
  or provider schema was modified.
- On the representative two-provider VPS, ran a one-off read-only Hono
  measurement harness inside the existing dev provider container using its
  real PostgreSQL and private PLC dependencies. For each of eight conditions
  (malformed CBOR, absent Grant, absent reply, invalid signature, previously
  rejected envelope, authenticated exact duplicate, unknown status, and valid
  duplicate status), recorded eight sequential and eight concurrent samples.
  The maximum observed 95th-percentile *unmasked validation* sample was
  81 ms sequentially and 312 ms with eight simultaneous requests. Under that
  same eight-way load, Hono response 95th-percentile samples ranged from
  751 to 757 ms. Generic paths returned `202`; authenticated exact duplicates
  returned signed `200`, and valid duplicate statuses returned `204`. All
  generic responses were the same JSON representation. The harness printed
  only case labels, counts, HTTP statuses, and aggregate milliseconds, never
  signed bytes or bearer credentials. It created no new message or Grant.
  These modest samples support the provisional 750 ms floor for this POC
  hardware, but do not establish a production bound under sustained load or
  cover unavailable local accounts, unknown current keys, or every status
  validation variant.
- Extended the PostgreSQL status integration with a fixture that replaces the
  currently authorized messaging key after terminal delivery. Bob rewraps the
  **same deterministic terminal payload bytes** using the new key without
  incrementing revision 2; both old and new signing wrappers remain retained.
  Alice acknowledges the new current-key wrapper as an exact semantic
  duplicate and rejects the old-key wrapper under the rotated current state.
  The separate signed PLC operation-log fixture verifies the role change;
  a complete fenced provider-state transfer remains a later exercise.
- Run `bun run typecheck`, `bun run build`, and `bun run test` locally, plus
  sequential PostgreSQL integration cases on a disposable database. The first
  hardening tranche passed 104 ordinary tests, 12 envelope/status and 6 reply
  PostgreSQL integration cases, a production-image build, and Compose
  validation. Provider source commit: `021dced` (`feat: bound protected
  processing and PLC reads`). At local validation time these changes were not
  deployed. The floor remains provisional pending sustained-load calibration,
  and the fenced migration exercise remains outstanding.

### 2026-09-28: Public Backend-Hardening Slice Verification

- Committed and pushed provider source `021dced` and protocol guide `e3f5f54`.
  Saved and validated both provider database custom-format dumps at
  `/var/backups/hail-poc/pre-hardening-20260928T222933Z`, and tagged the old
  image `hail-server-ts:pre-hardening-20260928T222933Z`. Deployed the shared
  image `sha256:76e04125b365a2b59dac2a36d8dba81629005deb9f58335694a5625922b8cb0a`
  to both providers. This slice introduced no schema change: both databases
  stayed at migration 12. Both public readiness endpoints returned `200`.
- On the deployed image, bounded private-PLC reads resolved Alice and Bob from
  their fully validated one-operation logs, returned their expected Hail
  services, retrieved one audit entry each, and mapped an unknown canonical
  DID to onboarding-compatible `404` without a public PLC listener.
- Eight simultaneous Hono requests for each of eight protected paths returned
  the expected generic `202`, signed `200`, or valid status `204`. Across those
  paths the observed response 95th-percentile samples were 750–757 ms; the
  maximum observed 95th-percentile direct validation sample was 168 ms. An
  exact public terminal-status retry returned bodyless `204`. From an external
  development client, eight HTTPS samples each for malformed envelope and
  unknown status had median 782 ms and observed 95th-percentile samples of
  857 and 859 ms, respectively, including network variation. These short
  samples do not establish a sustained-load production calibration.
- Restarted `hail-dev` and then `hail-app` deliberately. Both recovered
  readiness; byte-identical retries of Alice's original envelope and Bob's
  accepted reply each returned the persisted signed `delivered` revision 2.
  The recipient databases retained exactly one delivered row and one
  body-retrieval attempt for each. All eight containers were running, both
  providers were healthy with zero unexpected restarts, and logs contained
  no application errors. The complete PLC write-ambiguity restart fixture
  and fenced provider-state migration test remain outstanding.

### 2026-09-28: Ambiguous PLC Write Restart Fixture (Local)

- Added an opt-in PostgreSQL 14.4 integration test for custodial onboarding
  after a lost PLC write response. In one fixture the private directory
  persisted the signed genesis but the response and immediate read-back were
  unavailable; the account remained `submission-unknown`. A newly constructed
  service and repository reconciled that exact persisted genesis after restart
  without a second submission or new keys. In another fixture the first
  operation was not stored; after restart the provider retransmitted the
  persisted signed operation with the identical DAG-CBOR bytes, CID, DID and
  encrypted keys, then completed the read-back and binding staging.
- A conflicting genesis fixture occupied the persisted DID with different
  operation bytes. The provider rejected it before making a PLC submission
  and kept the prepared account; it did not treat the collision as an
  ancestor. The test uses the pinned PLC library's normal genesis encoding and
  signed-operation verifier and makes no public PLC write.
- Reproduce with a **disposable** `DATABASE_URL` from
  `/home/j4crev/Dev/hail-server-ts`:
  `bun --bun vitest run test/onboarding-restart.integration.test.ts`.
  Test cleanup deletes only its isolated generated accounts and keys. The
  remaining fenced-transfer record inventory and required writer fence are
  documented above; no provider migration or new schema has been deployed.

### 2026-09-29: Portable-Custody Cutover Rehearsal (Local)

- Replaced the proposed custodial rewrap path with the user-held-key ceremony
  in `docs/production-portable-custody.md`. The user selected an independently
  controlled address domain and a conservative 72-hour PLC quarantine. The
  user identity and top recovery private keys are generated and retained in
  the test client, never inserted into provider `account_keys` or exported.
  Destination-owned provider rotation and messaging keys are independently
  generated and encrypted only at the destination.
- Added forward-only migrations 13–21 for the source DID fence, signed
  snapshots and staged imports, custody/monitor evidence, user-authorized
  exact PLC cutover operation, target key preparation, destination Address
  Binding, finality observations, transactional import and target activation
  receipts. No migration in this set has been applied to the public providers.
- The source signs a digest of an immutable snapshot using its **provider
  messaging key**; it exports public operational metadata, protocol state,
  bodies and necessary bearer-bearing signed envelopes, but no source private
  key bytes or provider-wrapped ciphertext. Staging requires a separate
  user-identity signature over snapshot digest and destination state, a
  top-recovery-key-signed exact PLC operation with the current predecessor and
  preserved aliases, and a matching user-signed destination binding.
- The destination remains inert until two independently validated PLC
  operation/audit witnesses and a separately signed monitor coverage record
  agree on the new service, keys and CID for 72 hours from first local
  observation. A final external-style address verification and a fresh
  assessment precede transactional materialization. The fixture imports the
  complete record domain, re-encrypts **only destination-owned keys** under
  the imported account ID, renews the Sender Profile under the new messaging
  key, resets stale work/outbox leases, fails work whose signed deadline
  expired during quarantine, and gives the source a signed receipt; the old
  fence remains permanent in `retired` state.
- A disposable two-database PostgreSQL 14.4 fixture covered six cutover cases:
  a pre-fence writer committing first; blocked admission, Grant changes,
  reply claims, delivery completion and in-flight status publication after
  fencing; immutable export and import integrity; provider-held identity-key
  rejection; invalid or lower-priority signatures; mirror/monitor disagreement;
  72-hour gating; user-controlled address mismatch; atomic rollback on a target
  account conflict; expired work failure; current-key status signing; and
  receipt-authorized old-provider retirement. Existing onboarding, Grant,
  body, envelope and reply integration cases also passed after migration 21.
- This remains an isolated rehearsal. The independent mirror and monitor
  witnesses and address verifier are injected fixtures, not independently
  operated production services. The live POC DIDs are custodial and exist only
  in a private PLC registry; they cannot be promoted into production portable
  custody by applying these migrations. Public-registry submission,
  user-controlled client/vault onboarding and Grant/Binding signing, monitor
  provisioning, historical PLC evidence policy and a real user-domain cutover
  remain required before a production-ready release.

### 2026-09-29: Independent PLC Monitor Prototype (Local)

- Created `/home/j4crev/Dev/hail-plc-monitor-ts` as a separate Bun and
  PostgreSQL project with its own migration, signing key and operational
  database. The user chose a desktop/Bun **reference client**, without
  restricting future mobile custody implementations, and a separately
  operated user host for production independent monitoring. A provider-hosted
  bootstrap copy is explicitly marked as non-independent.
- The monitor retains a global PLC `/export?after=<seq>` cursor and checks
  contiguous sequence progression. For enrolled DIDs it validates the full
  signed log, rendered data and non-nullified audit CID, records unexpected
  operations without silently updating expected state, and durably records
  export gaps and coverage loss after 24 hours. Its signed out-of-band alert
  outbox retries through a DNS-pinned HTTPS webhook. A local user-operator
  reviews an exact CID and complete PLC state before changing expectations.
- The independently held Ed25519 monitor key signs the same deterministic
  coverage attestation consumed by the provider's cutover gate. A successful
  attestation requires an approved current operation, acknowledged
  unexpected-operation alert, recent healthy polling and no coverage-gap
  alerts. The PostgreSQL integration test covers durable cursor restart,
  changed state, downtime, gap detection, alert retry and attestation
  interoperability with the provider verifier.
- The project has not been deployed to an independent user-owned host and
  cannot yet bootstrap a large canonical PLC export from an authenticated
  checkpoint. Its separate mirror operators and a full second-device recovery
  ceremony also remain to be selected and tested. The private-registry POC DIDs
  cannot be treated as monitored public-registry identities.

### 2026-09-29: Local Portable-Custody Release Checkpoint

- Provider portable-transfer implementation `74c6e7b` was committed and
  pushed. Its migrations 13–21 remain **unapplied** on the public provider
  databases, which still run the verified migration-12 hardening image. A
  production-image build, 105 ordinary tests and 29 sequential PostgreSQL
  integration cases passed in local/disposable environments. The two-database
  cutover fixture remains a rehearsal with simulated mirrors, monitor and
  user-domain address verification.
- Created and published the independent monitor prototype at
  <https://github.com/j4crev/hail-plc-monitor-ts> (`b0ed06d`) and the
  platform-specific user-key reference client at
  <https://github.com/j4crev/hail-user-client-ts> (`a271519`). The reference
  vault generates user recovery and identity keys locally, encrypts them with
  a random 256-bit recovery secret, and signs the exact PLC, Grant, binding
  and migration-consent objects without giving their private bytes to a
  provider. Mobile clients may satisfy the same protocol outcomes using
  their own platform-backed storage and recovery UX.
- The monitor's bounded client read-only test retrieved PLC export sequences
  1 and 2 and validated Alice's and Bob's one-operation private-registry logs;
  the authenticated temporary tunnel was closed afterwards. Eight monitor
  ordinary/integration tests and two client tests passed. These isolated POC
  DIDs are not public PLC identities, so this is a compatibility check rather
  than independent public coverage. No monitor service or user vault was
  deployed to a public/user-owned host.
- The user has not yet provisioned a separate user-controlled monitor host or
  an independently verified public PLC export checkpoint/mirror. The current
  public POC remains on the previously verified runtime. Do not deploy the
  local portable migrations to the existing custodial accounts or describe a
  provider-hosted bootstrap monitor as provider-independent. The remaining
  production requirements and address/cutover policy are tracked in
  `docs/production-portable-custody.md`.

Later implementation sessions should append dated entries containing tested
commit IDs, executed setup commands, verification results, and any deviations
from this method.
