# Security review

Reviewed baseline: `407380b`, 2026-10-22. This is a source review with bounded local
checks, not a certification or a production penetration test. The defensive fixes
below have been applied locally; no dependency upgrades or live-provider attacks
were performed. Work after the scope clarification used source review and
regression tests, not further exploit demonstrations.

## Current status

| Finding | Severity | Status |
| --- | --- | --- |
| S1: bootstrap enrollment authorization | High | Fixed: legacy credential proxy disabled; use owner-authorized enrollment. |
| S7: migration preparation outside admission transaction | High | Fixed: authenticate before preparation; key preparation and admission commit together. |
| S2: shared ingress quotas | Medium | Fixed: trusted per-client and authenticated-account budgets plus a separate overload ceiling. |
| S3: mutable verified Buffer evidence | Medium | Fixed: copy input into an independent Uint8Array. |
| S4: CLI response buffering | Low | Fixed: streaming byte limit and cancellation. |
| S5: repeated signed alert delivery | Low | Open: needs atomic delivery deduplication. |
| S6: protected key-ID BOM normalization | Low | Fixed: preserve BOM and reject noncanonical identifiers. |

Validation/interoperability concerns and dependency advisories below remain open.
Existing unexpected passkeys or orphan migration rows, if any, are not removed
automatically by these code changes; inspect and remediate those operationally.
Finding descriptions and line references below refer to the reviewed baseline;
each fixed finding has a separate applied-change note.

## Priority findings

### S1 — High: unauthenticated bootstrap passkey enrollment

- Locations: `apps/gui-poc/src/routes/auth/enroll/options/+server.ts:4–7`,
  `apps/gui-poc/src/routes/auth/enroll/complete/+server.ts:5–8`,
  `apps/gui-poc/src/lib/server/canary.ts:14–18`.
- Condition: `HAIL_GUI_CREDENTIAL_FILE` points to an account credential with
  `account:read` and `credentials:write`, and the enrollment routes are reachable.
  The checked-in public Compose configuration does **not** set this credential.
- Both endpoints require only the public Origin string, then exercise the
  server-held credential. A direct HTTP client can supply that Origin; no victim
  session, owner proof, or bootstrap secret is required.
- An attacker can request registration options, register their own authenticator,
  and sign in as the bootstrap account. Server registration remains available
  after the first passkey: `apps/server/src/accounts/passkeys.ts:37–100` accepts
  the credential without recent passkey verification. Challenges are single-use;
  the bootstrap credential is not.
- Local proof: both GUI handlers returned 200 and exercised bootstrap authority
  without a cookie or Authorization header. A separate real PostgreSQL/WebAuthn
  proof registered two attacker passkeys and authenticated into account/grant
  read and message read/write scopes. A fresh session can also approve CLI access.
- Fix: remove this unauthenticated credential proxy. Use the existing short-lived,
  single-use owner-authorized enrollment capability, or authenticated recent
  verification. Disabling `HAIL_GUI_CREDENTIAL_FALLBACK` alone does not fix these
  routes. Immediate mitigation: unset the bootstrap credential outside controlled
  local setup; if exposed, revoke it and inspect/revoke unexpected passkeys and
  sessions.
- Retained checks: `apps/gui-poc/src/lib/enrollment-security.test.ts`.
- Applied: both legacy endpoints now deny enrollment unconditionally; the login
  page no longer advertises bootstrap enrollment. Existing owner-authorized
  recovery/enrollment and recent-passkey management paths remain available.
- `HAIL_GUI_CREDENTIAL_FALLBACK=true` deliberately enables fixed-account access;
  do not expose that rollback mode publicly.

### S7 — High: migration preparation could survive failed invitation admission

- Baseline locations: `apps/server/src/migration/managed-invitation-receiver.ts:55–56`,
  `apps/server/src/migration/target-keys.ts:88–97`.
- When managed transfer routes are enabled, preparation previously preceded
  authority validation and persisted keys through a separate root connection.
  Failed admission could therefore leave a prepared DID slot without a matching
  invitation. The unique slot prevents subsequent managed or portable admission,
  while invitation-based cleanup does not discover that orphan.
- Applied: managed authority validation now runs before preparation. Both managed
  and portable receivers use a transaction-scoped target for preparation, signing
  reads, and admission, so a later failure rolls back the whole operation.
- Regression coverage injects authority and offer-service failures into otherwise
  valid test fixtures and checks that no keys or invitation rows remain; normal
  admission and exact retry still succeed.
- Retained check: `apps/server/test/managed-invitation-receiver.integration.test.ts`.
- Existing orphan slots require operator inspection. No bulk deletion or cleanup
  migration was added, to avoid removing legitimate standalone preparations.

### S2 — Medium: anonymous traffic consumes every user's account/auth quota

- Locations: `apps/server/src/accounts/routes.ts:48–64`,
  `apps/server/src/accounts/passkey-routes.ts:31–40`. The same design also appears
  at `apps/server/src/bodies/routes.ts:36–44`, `envelopes/routes.ts:40–46`,
  `grants/routes.ts:63–90`, and `migration/rate-limit.ts:15–16` (all under
  `apps/server/src/`). It affects delivery as well as account access.
- There are separate account and authentication counters, but each is shared by
  all users in a server process. Requests are charged before authentication;
  authentication routes also accept anonymous requests with a supplied Origin or
  no Origin on allowed server-facing routes.
- Local proof: 120 unauthenticated account requests caused the next bearer request
  to receive 429 before authentication. Likewise, 120 malformed authorization
  requests made a subsequent logout return 429. Roughly two requests per second
  per serving instance can keep legitimate users blocked.
- Fix: separate anonymous and authenticated budgets; key them by trusted client
  address and authenticated account/session respectively. Keep any global overload
  ceiling separate and meaningfully higher. Do not trust arbitrary forwarded IP
  headers without a configured trusted proxy boundary.
- Applied: Caddy overwrites an internal client-address header at the private
  provider boundary. Anonymous and federation ingress use bounded per-client
  buckets, authenticated account traffic uses an account-local bucket, and
  transfer ingress retains a separate database-backed overload ceiling. Direct
  development requests share the deliberately unidentified bucket rather than
  trusting caller-supplied forwarding headers.

### S3 — Medium: Buffer input makes verified evidence mutable

- Locations: `packages/hail-codec-ts/src/cose.ts:91,221`.
- `Buffer` is a valid `Uint8Array` input, but `Buffer.slice()` aliases its backing
  memory rather than copying it. Consequently both the input and the
  `representationBytes` getter can mutate retained, already-verified bytes.
- Local proof: after genuine Ed25519 verification, overwriting the input or a
  getter result changed later representation reads. The decoded payload remained
  unchanged. This breaks the verified object's evidence-integrity contract; it
  is **not a demonstrated signature forgery** or remote authentication bypass.
- Fix: take an actual byte copy with `Uint8Array.from(representation)` at entry;
  ensure all exposed byte getters return independent copies.
- Retained checks: `packages/hail-codec-ts/test/security.test.ts`.
- Applied: the parser now copies input with `Uint8Array.from`; input and getter
  mutation tests verify that retained signed evidence remains unchanged.

### S4 — Low: CLI browser authorization buffers before enforcing its limit

- Location: `apps/cli/src/browser-login.ts:18–26`.
- The 65,536-byte response limit is checked only after `response.arrayBuffer()`.
  A malicious/compromised selected provider can stream far more data into memory
  before rejection. The 20-second timeout bounds duration, not allocated bytes.
- Local proof: a 1 MiB response was fully consumed and never cancelled before
  the "too large" error. No large-memory or machine-crashing proof was attempted.
- Fix: enforce the limit while streaming and cancel on overflow, following the
  existing bounded reader in `apps/cli/src/account-api.ts:102–127`.
- Retained check: `apps/cli/test/browser-login-security.test.ts`.
- Applied: response reading now enforces the byte limit per chunk and cancels on
  overflow or read failure; invalid response representations are cancelled too.

### S5 — Low: valid signed monitor alerts can be replayed to send repeated email

- Location: `apps/plc-monitor/deploy/cloudflare-alert-worker/worker.ts:73–85`.
- Signatures are checked, but alert IDs are not deduplicated and timestamps do
  not expire. Anyone possessing one genuine signed request can replay it without
  the signing key. Possession is required; HTTPS does not expose requests to
  arbitrary passive observers.
- Local proof: replaying identical signed bytes three times returned 204 three
  times and sent three emails. Ordinary delivery retries can also duplicate mail.
- Fix: deduplicate verified alert IDs before sending; define bounded freshness
  and retention rules compatible with delayed retries. Use atomic deduplication
  if concurrent delivery matters; eventually consistent KV alone can race.
- Deferred: reliable suppression must handle concurrent deliveries and retries;
  no non-atomic KV-only claim was added as a misleading partial fix.

### S6 — Low: TypeScript normalizes a noncanonical protected signer identifier

- Locations: `packages/hail-codec-ts/src/cose.ts:31,169`; compare
  `packages/hail-codec-go/cose.go:322–324`.
- The default `TextDecoder` strips a leading UTF-8 BOM. A protected `kid` with
  BOM bytes before the DID URL therefore compares equal to the canonical key ID.
  TypeScript accepts it; Go rejects it as the wrong key role.
- This is a strict-profile/cross-implementation discrepancy, not demonstrated
  signer impersonation: the actual protected bytes remain signed.
- Fix: preserve the BOM (`ignoreBOM: true`) and require exact canonical UTF-8
  identifier bytes rather than normalized equivalence.
- Retained check: `packages/hail-codec-ts/test/security.test.ts`.
- Applied: `ignoreBOM: true` preserves identifier bytes for the existing exact
  signer-role comparison. The regression verifies noncanonical IDs are refused.

## Validation and interoperability concerns

These do not establish an authentication bypass or an image-decoder exploit:

- **Malformed PNG accepted:** `packages/hail-codec-ts/src/validation.ts:545–571`
  and `packages/hail-codec-go/assets.go:14–57` accept an image with illegal IHDR
  bit depth/color type, zero CRCs, and invalid IDAT content when its digest and
  dimensions match. Go's standard PNG decoder rejects it. Improve structural
  validation (header parameters, ordering, CRCs), retain pre-decode dimension
  bounds, and continue treating image bytes as untrusted. Do not assume a valid
  digest establishes a safe image.
- **Encoder/decoder resource accounting differs:**
  `packages/hail-codec-ts/src/cbor.ts:168–175,198–209` counts map values but not
  keys; `src/scan.ts:80–86` counts both. An SPT-1 body with 2,500 short spans
  encodes to 65,080 bytes, then both TS and Go reject it for excessive items.
  Align accounting and add an encode/decode boundary test.
- **HTTPS link grammar differs:** `packages/hail-codec-ts/src/validation.ts:524–527`
  accepts `https:example.com`; `packages/hail-codec-go/payload.go:1063–1066`
  rejects it. Specify one canonical wire grammar and cross-language edge vectors.

## Dependency advisories

`bun audit` reported five advisories; these are dependency matches, **not five
demonstrated remotely exploitable application vulnerabilities**:

| Package | Severity | Advisory / relevant exposure |
| --- | --- | --- |
| `source-map-js@1.2.1` | High | GHSA-68fv-2mgg-jv7q; indexed-source-map event-loop DoS. Found through Vite/PostCSS; no production hostile-source-map path established. |
| `@vitest/mocker@5.0.0` | Moderate | GHSA-qxg6-89mg-rqv8; unauthenticated manual mock registration injection. Test tooling; update to at least 5.0.3 and do not expose test servers. |
| `@vitest/mocker@5.0.0` | Moderate | GHSA-xp26-3454-mjgp; Windows redirect-allowlist traversal. Test tooling; update to at least 5.0.3. |
| `hono@4.13.9` | Moderate | GHSA-5r4p-p66f-jhc7; static-path double-decoding. Update to at least 4.13.11; no `serveStatic` use found in server application code. |
| `cookie@0.6.0` | Low | GHSA-pxg6-pf52-xh8x; invalid cookie name/path/domain handling. No attacker-controlled cookie attributes established here. |

Refresh the lockfile deliberately and rerun tests/builds; no automatic dependency
changes were made. Also update the old `postgres:14.4-alpine` deployment pin to a
supported patched release; container/OS vulnerability scanning was not performed.

## Tests, evidence, and limits

Retained regression tests are ordinary passing tests for the applied defenses.
They check denial of legacy enrollment, independent verified-byte copies,
canonical protected key IDs, bounded response consumption, and migration rollback
under injected dependency failures. There are no expected-failure markers masking
unfixed vulnerabilities in the final test additions.

From the repository root:

```sh
bun run test:ts
bun run typecheck
```

For focused verification, run the affected workspace's Vitest against the retained
test path above. The migration integration check requires a disposable
`DATABASE_URL`; the other new checks do not. Existing database suites must not be
pointed at production databases.

Executed existing checks:

- After fixes, `bun run test:ts`: **444 passed**, with **103 database-dependent
  tests skipped** when no database URLs are set. No expected failures.
- `mise exec -- go -C packages/hail-codec-go test -count=1 ./...`: passed.
- Isolated local PostgreSQL, server suite run serially: **223 passed, 22 skipped**.
- After fixes, managed preparation/admission/orchestration suites: **4 passed**,
  including the new rollback assertions and managed provider round trips.
- After fixes, portable migration/cancellation/cleanup suites on fresh source and
  target databases: **5 passed**. The disposable database container was removed.
- Four remaining two-database transfer suites on fresh databases: **20 passed,
  1 failed**. The failure at `apps/server/test/migration-fence.integration.test.ts:1000`
  expects an error containing `bootstrap v2`, but the operation correctly rejects
  with `Public cutover requires a reviewed bootstrap monitor attestation`.
  This is an assertion/message mismatch, not a demonstrated acceptance bypass;
  later assertions in that test were not reached.
- Monitor's existing database suite also passed (15 existing tests including
  unit tests). Workspace-wide typechecking passed after the fixes.
- GUI production build passed; final GUI typecheck reported no errors or warnings.
- An initial concurrent cross-workspace database run failed because monitor and
  server shared a migration namespace and exhausted connections; separate
  databases/serial server execution resolved that harness problem. Reusing dirty
  transfer databases also caused unrelated global-count assertions; fresh
  transfer databases removed those failures.

Reviewed areas include strict CBOR/COSE and role checks, hostile parser limits,
account scopes and ownership, WebAuthn/session/enrollment/PKCE boundaries,
onboarding, identity encryption, CLI private state/vault handling, GUI rendering,
monitor notification transport, and dependency/deployment configuration.
This was not exhaustive fuzzing, a cryptographic proof, or an infrastructure audit.
Live PLC smoke testing and actual production configuration were not exercised.
