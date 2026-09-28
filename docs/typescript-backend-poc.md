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

### Phase 8-10 Implementation Checklist

The following six milestones decompose Phases 8 through 10 and the thin slice
in `BUILD_ORDER.md`; they do not add protocol scope:

1. **Sender Profile:** publish Alice's DID-scoped, `#hail-messaging`-signed
   profile with one category; retrieve and verify it from Bob's provider, then
   durably retain its exact representation, digest, revision, and PLC evidence
   for rollback checks and later grant consent evidence.
2. **Grant:** have Bob create and sign a grant for Alice; persist immutable
   revisions and publish them through `PUT /hail/grants/{grant_id}`.
3. **Detached Body:** publish one plain-text Safe Portable Text body from
   Alice's provider and enforce recipient authorization, digest, media type,
   size, and availability during retrieval.
4. **Envelope Submission:** sign and submit one Alice-to-Bob envelope; enforce
   recipient, grant, category, timestamp, signature, and replay checks before
   any body transfer.
5. **Durable Delivery Worker:** persist accepted work before acknowledging it,
   retrieve and verify the body after acceptance, and durably store Bob's
   delivered message across process restarts.
6. **Delivery Status:** have Bob sign and push a terminal status to Alice, then
   acknowledge the byte-identical status idempotently.

The completed demonstration must also reject an unauthorized category, reject
new envelope acceptance when revocation commits first, preserve delivery
responsibility when acceptance wins that race, reject an invalid signature,
and treat an exact envelope retry as one delivery.

## Phase 9: Durable Delivery Work

Run persisted jobs for body retrieval, integrity checks, state transitions,
terminal status signing, and retry delivery. The earliest slice may execute the
worker loop in the server process, but accepted work must already be durable so
a restart does not lose responsibility.

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

Later implementation sessions should append dated entries containing tested
commit IDs, executed setup commands, verification results, and any deviations
from this method.
