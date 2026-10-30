# Production release readiness

This checklist tracks readiness for real users while registration remains invite-only.
Checked items require implementation and recorded verification, not merely a plan.
Publication, supported-platform claims and live operational evidence remain separate
from repository changes. Initial assessment: 2026-10-29.

## Database and release gates

- [x] Add a mandatory CI runner for provider, transfer-target and monitor integration suites using disposable PostgreSQL databases; fail on missing configuration or skipped tests. Exercised locally across all 48 suites.
- [x] Repair stale integration fixtures and require a successful complete integration run: all 48 suites pass with no skipped tests (2026-10-30).
- [x] Test fresh current-schema initialization, repeated startup, current authority/evidence constraints and current-code transfer round trips. Unreleased historical schemas are not a compatibility commitment.
- [ ] Establish the first supported release baseline and its future upgrade tests when a stable release is actually published.
- [x] Make release publication depend on the full reusable CI workflow at the release revision.
- [ ] Confirm hosted CI passes and configure repository branch/tag protection settings.
- [x] Add the browser recovery cryptography check to CI; verify it locally in Chromium.
- [x] Repair and gate the full browser wizard flow; supported real-device validation remains tracked separately below.

## CLI distribution

- [x] Document versioned binary download, checksum verification, PATH setup, upgrade and uninstall.
- [x] Verify agreement between Cargo, package, binary and release-tag versions.
- [ ] Publish the first tested GitHub release and verify its downloaded artifact on a clean machine.
- [ ] Specify and test the minimum supported Linux distribution/glibc version; avoid relying on a moving build runner as the compatibility promise.
- [ ] Add artifact provenance/signing verification and document the trust model.
- [ ] Decide whether macOS, ARM64 and Windows are needed for the initial audience; validate each platform before claiming support.
- [ ] Consider a convenience installer after the manual download path is proven.

## CLI documentation

- [x] Add a Markdown reference covering every command and option, including required flags, values, defaults and conditional requirements; enforce generated inventory freshness in CI.
- [x] Add an existing-web-user quickstart: browser login, scoped credentials, account and inbox reads.
- [x] Link installation, quickstart, reference, workflows and script/output contract from the CLI and project READMEs.
- [ ] Review per-command examples, scopes, provider gates, output/artifact behavior and recovery instructions for completeness with a new user.

## Stable data and upgrades

- [ ] Replace the pre-launch reset policy with an approved stable-release compatibility and data-preservation policy before real users depend on it.
- [ ] Define supported CLI/server/protocol versions and deprecation/upgrade notice.
- [ ] Classify database migrations by old-application compatibility and specify roll-forward or restore procedures for incompatible changes.
- [ ] Demonstrate an upgrade and application rollback with new writes preserved; do not equate image rollback with database rollback.

## Recovery and browser acceptance

- [ ] Restore a fresh encrypted provider backup off-host, compare records and decrypt retained operational keys; record dated evidence in protected operator records.
- [ ] Verify monitor recovery, durable coverage and alert delivery after interruption.
- [ ] Define acceptable data-loss and recovery-time targets and measure the restore drill against them.
- [ ] Test lost-device/passkey account recovery from the saved recovery package on a clean device, with understandable user instructions.
- [ ] Validate signup, resumable setup, login and recovery on each promised desktop/mobile browser; include synced passkeys, hardware keys and cross-device flows as supported.
- [ ] Decide whether post-signup browser recovery is required for the initial audience; until implemented, publish and test the CLI/operator-assisted route.

## Operations, security and user commitments

- [ ] Implement asynchronous email bounce/complaint handling and delivery monitoring.
- [ ] Measure capacity and overload behavior; define alerts for disk/storage pressure, delivery backlog and dependency failures.
- [ ] Confirm current backup, readiness and monitor alerts actually reach the operator; record a simulated-failure drill.
- [ ] Set retention/cleanup policies for data, backups, retry artifacts and retained application images.
- [ ] Publish accurate privacy, account-closure, support and vulnerability-reporting documentation; review commitments with the operator.
- [ ] Review signup recovery-material handling, account isolation, credential lifecycle and custody/transfer security.
- [ ] Validate independent-provider interoperability before advertising broad federation/portability support.
- [ ] Name and train a backup incident operator when coverage requirements justify it; current single-operator coverage must remain explicit.

## Database failures resolved during pre-launch cleanup

There is no supported historical release to upgrade from. Tests now exercise the
current schema instead of reconstructing old development databases and attempting
long downgrade sequences. Current authentication, evidence retention and transfer
correctness remain requirements. All database items below passed the complete 48-suite integration gate;
the result is recorded in the evidence log.

- [x] Replace retired TypeScript CLI launches with Rust, real test CA/server certificates and Rustls trust configuration. Account-access, account-API, credential-rotation and Grant-update suites pass.
- [x] `browser-authorization.integration.test.ts`: remove the historical downgrade ladder; retain PKCE, generation and cross-provider rejection tests.
- [x] `connection-federation.integration.test.ts`: migration 86 permits authenticated historical delivery restoration with a newly assigned local cursor; frozen new delivery remains blocked. Full independent-provider handover passes.
- [x] `custody-transition.integration.test.ts`: run current-schema custody round trips and connection preservation without intermediate schema downgrades.
- [x] `managed-profile-version-migration.integration.test.ts`: test explicit supported profile/evidence versions on a fresh current schema with valid PLC evidence, rather than backfilling an obsolete schema.
- [x] `passkey-session.integration.test.ts`: retain expiry, serving-generation and revocation checks, including persistence across restart; remove obsolete successful-downgrade scenarios.
- [x] `private-poc-migration.integration.test.ts`: distinguish immutable message history from local cursor/read/trash state. Both transfer/return/abandonment orderings pass; regression checks reject missing or altered archived messages and preserve current presentation choices.
- [x] `provider-roles.integration.test.ts`: test reservation, authorized ownership and refusal to replace a current role owner, without synthesizing an unclaimed pre-reservation legacy account.
- [x] `public-cutover-evidence-migration.integration.test.ts`: test current access, evidence immutability, cleanup retention and refusal of digest-only activation without an obsolete table inventory.
- [x] `public-onboarding.integration.test.ts`: retain owner/managed onboarding and immutable authority checks; remove the old schema rollback ladder.
- [x] `public-plc-authority.integration.test.ts`: retain fresh-read, outage, rotation and history checks; prove repeated startup preserves evidence instead of downgrading storage.
- [x] `serving-history-migration.integration.test.ts`: prove current retirement archives preserve exact bytes, reject mutation, and survive restart; remove legacy import/backfill and downgrade expectations.
- [x] `shared-plc-evidence.integration.test.ts`: compact the current schema's supported inline representation, preserving exact portable bytes, linked authority and retry behavior, without schema rollback.
- [x] `check-browser-wizard.ts`: update rich-text and inline connection reply fixtures; verify recipient, connection epoch and original-message binding, delivered status, and disabled replies after disconnection. Gate the complete flow in CI.

## Migration 86 rollout

Normal server startup applies `0086_handover_delivery_cursor.sql`. It replaces one
trigger function and rewrites no account, message or evidence rows. The exception
still requires the authenticated staged import and exact equality for every
message field except the destination-assigned `delivery_sequence`.

Application rollback should leave this additive database correction installed.
The explicit schema rollback restores the old function without deleting data,
but reintroduces the import failure when cursor values differ. The TypeScript
return-history correction is also required for successful return transfers.
No live deployment or database update has been performed by this task.

## Evidence log

Record completed repository checks below. Keep secrets, backup contents and sensitive
incident details out of this file; link to protected operator evidence where appropriate.

### 2026-10-30 — browser wizard repaired

- Reproduced the timeout waiting for the obsolete connection reply composer link.
  The reader now uses an inline reply form; no application behavior change was needed.
- Full built-client `test:wizard` passes in local Chromium with virtual WebAuthn
  and local provider fixtures, including signup, login, messaging, connections,
  permissions and account security. Connection replies now exercise submission
  through the provider proxy and redirect to delivered Sent status.
- Corrected stale reply-form IDs so collapse/cancel assertions inspect the actual
  form. Client typecheck reports zero errors and zero warnings.
- CI runs the full wizard after browser recovery cryptography checks; the release
  workflow inherits this gate. Hosted CI execution and real-device browser/passkey
  acceptance are not established by this local fixture run.

### 2026-10-30 — database failures resolved

- Full `bun run test:integration` against disposable PostgreSQL 18.6: **48 suites,
  zero failures, zero skipped tests**, exit 0. This includes every previously
  failing suite and the monitor suite; test databases were removed afterward.
- Server typecheck passes. Ordinary server tests: **49 files / 233 tests pass**;
  the 48 database suites omitted by that ordinary command are covered by the
  separate complete integration gate above.
- Migration 86 forward application, explicit function rollback, reapplication
  and repeated startup were exercised on a disposable database with seeded
  account/generation rows. The rows remained unchanged and the function was
  restored correctly. Fresh initialization is also covered by every full-gate suite.
- Return-transfer regressions retain a message delivered before the original
  move, force a different destination cursor, preserve read/trash choices made
  at the destination, and reject missing messages or changed body digests.
- `git diff --check` passes. No historical schema compatibility was added;
  no production database was reset, modified or deployed.

### Initial assessment and release-tooling verification

- Initial assessment found an existing Linux release workflow but no GitHub releases,
  source-first installation docs, and database suites omitted by normal CI environment.

- Added [release process](release-process.md) with local test commands, release
  candidate checks and publication/download verification.
- Local PostgreSQL 18.6 full run: 48 suites, no skips, 16 initially failing.
  Targeted reruns confirm four formerly failing CLI suites now pass. Twelve suites
  remained unresolved after that initial assessment; they were addressed in the
  subsequent current-schema repair described above.
- Native CLI builds; server and client typechecks pass (client: zero errors/warnings).
  Client production build and isolated Chromium recovery-cryptography check pass.
- Reference covers 65 commands and 43 options. Freshness check passes and a stale
  copy is rejected. Correct release version/tag passes; mismatched tag is rejected.
  Missing database-runner configuration fails immediately. Workflow YAML parses
  and `git diff --check` passes.
- Local test runtime was Bun 1.4.4; CI remains pinned to 1.4.0. Hosted CI and
  downloaded-release verification remain outstanding. No live deployment,
  registration change, tag, release or production data mutation was performed.

Attachments, public discovery, branding polish and opening registration are outside
this release checklist unless the initial audience explicitly needs them.
