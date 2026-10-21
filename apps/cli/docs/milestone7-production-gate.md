# Milestone 7 — managed-profile foundation and production gates

Status: managed/read-evidence v1 profiles frozen October 13, 2026. Package version stays **0.1.0**. Milestone 6
is committed locally as client `d7a9830` and provider `0ac5461`; neither was pushed.
The milestone-7 work now includes the managed draft/genesis slice and the next
read-evidence/monitor-bootstrap and durable cutover-evidence slices. These are local reference checks, not
completion of the production federation gate.

## First slice

The protocol repository now has a
[managed-custody v1 candidate](https://github.com/j4crev/hailproto/blob/main/spec/managed-custody.md)
covering explicit identity/recovery custody, owner authorization, account isolation,
public onboarding, independent evidence, transitions and MC-01–MC-14 conformance
cases. Portable production support remains required; candidate managed custody is
a distinct alternative, not portable identity control or fully custodial recovery.

`reviewManagedGenesis()` reuses the official PLC schema and key parser. It checks
the reference new-DID subset: owner recovery first, one distinct PLC-supported
provider rotation key, two distinct Ed25519 Hail keys, no unused local vault key
in provider roles, empty aliases, one canonical HTTPS Hail service and no extra
state. Managed signing applies the 7,500-byte PLC limit and refuses fresh genesis
for a bound vault. Binding rechecks the public-role/state constraints as well as
the existing owner signature and exact derived DID.

Signup reconstructs its reviewed genesis on **every** retry, verifies exact
retained full state, owner signature and derived DID before registration, even
when the vault was already bound by an interrupted attempt. It retains the
same signed operation/binding and never re-signs to hide response ambiguity.
This retry proof applies to both custody profiles; the extra managed-role checks
apply only to explicit managed signup.

## Recorded verification

- Client `bun run typecheck`: passed.
- Client `bun run test`: **7 files / 12 tests passed**, including two new
  managed-genesis checks for the reference parts of MC-02/MC-03/MC-04.
- Client `bun run build` and `bun run smoke -- dist/hailp`: passed; executable
  version remains 0.1.0 and offline private vault operations still work.
- Provider `test/self-service.integration.test.ts` and
  `test/account-access.integration.test.ts`: **6 PostgreSQL integration tests
  passed** against a disposable local PostgreSQL 14.4 database. Both signup
  custody profiles, exact retries and independent owner access recovery remain
  compatible. Self-service tests use in-process transport/private PLC fixtures;
  they are not public-registry or independent monitoring evidence.

The new negative cases include wrong rotation priority/type, key reuse, malformed
or missing Hail keys, unused local identity substitution, extra services/methods/
aliases, unsafe/noncanonical endpoints, oversized operations, provider-only
signature, portable-as-managed binding and bound-vault replacement. A lost signup
response is resumed with identical artifacts; changed retained state/signature/
DID/custody preparation is rejected before registration transport. Public/private
custody cannot be proved solely from these public-key shape checks.

## Read-evidence and monitor-bootstrap slice

The [PLC read-evidence policy candidate](https://github.com/j4crev/hailproto/blob/main/spec/plc-read-evidence.md)
defines current read agreement, independent reader/operator declarations,
reviewed per-DID bootstrap, full backfill and fresh v2 coverage. The provider now
validates complete canonical/audit history with the pinned official PLC priority/
recovery-window validator and compares both readers' complete evidence, not only
head CIDs. Configured observers use bounded, credential-free transport pinned to
their declared origin. Private registration records and private-Poc assessments
cannot be promoted to public eligibility.

Monitor migration **3** preserves existing cursor/history/alerts/approvals, adds
durable `caught_up` state and stores original reviewed bootstrap CID/state/time
separately from later expected-state approvals. HTTPS enrollment requires the
reviewed file. Full pages remain `backfilling`; failed/gapped polls clear readiness;
only a short/empty contiguous page establishes catch-up. Enrollment does not invent
a healthy poll, and never-healthy enrollment also records a durable outage alert.

Reviewed enrollment emits domain-separated monitor **v2** evidence, including
bootstrap CID, full-state digest and contiguous export sequence. Public cutover
requires v2, five-minute freshness and the same canonical pre-cutover checkpoint
state in both readers. Legacy v1 remains verifiable for POC use but cannot satisfy
the public gate. No late-sequence skip or automatic legacy-to-reviewed relabeling
was added. The sequence is a trusted monitor assertion, not a cryptographic
directory checkpoint or proof of independent host administration.

### Additional recorded gates (October 11, 2026)

| Gate | Result |
| --- | --- |
| Provider `typecheck` and `build` | Passed |
| Provider PLC read-evidence/client/rotation checks | 3 files / **9 tests passed** |
| Provider fenced-transfer integration against two disposable PostgreSQL 14.4 databases | **16 tests passed** |
| Monitor `typecheck` and `build` | Passed |
| Monitor complete suite, including disposable PostgreSQL integration | 3 files / **14 tests passed** |

Checks cover head-only/changed/duplicate audits, priority/nullification/window
errors, equal heads with different annotations, wrong bootstrap digest, legacy
public-proof refusal, private registry/profile promotion, missing/shared/operator
origin boundaries and read outage. Monitor checks prove reviewed-state refusal,
checkpoint preservation after approval, partial backfill, restart, stale health,
durable gaps, never-healthy outage and an attestation blocked behind a failing
poll. Legacy rollback/re-upgrade preserves rows and starts new catch-up; rollback
refuses incomplete readiness or loss of any reviewed bootstrap checkpoint.

The tests use mocked PLC readers/export and local PostgreSQL. They do not contact
public PLC, establish real independent operator control or prove production
monitor availability. The disposable container was removed; live providers and
monitor databases were not changed. CLI package version remains **0.1.0**.

## Durable provider cutover-evidence slice (migration 40)

Provider migration **40** adds append-only `public_cutover_evidence` and a separate
`public_cutover_evidence_selection`; no existing signed manifest, account or
observation shapes change. The bounded deterministic-CBOR archive includes both
complete validated reader histories/documents and canonical signed DAG-CBOR
representations, operator/origin declarations, original bootstrap state, exact
monitor payload/signature/key, submitted operation bytes and import digest, and
local observation/verification times. It contains no private keys, bearer
credentials or message bodies.

The gate retains the bundle and selects its digest atomically with eligibility
after locking/rechecking the unchanged staged import. Failed reads or an import
changed while verification was paused retain no new bundle. Identical encoded
observations deduplicate, including concurrent/fresh-instance retries; new times/
observations append evidence and keep previous bytes. Signed operations and transfer
IDs are never regenerated as a retry shortcut.

Public activation rechecks exact selected digest, archived integrity/signature,
import correlation and existing live freshness. The same ownership transaction
seals the selected digest/activation time. A migration-39-style digest-only public
writer is refused by the native schema guard. Changing selection during address
verification prevents materialization; active response recovery uses the sealed
original proof plus current destination checks. Private transfer/return/recovery
continues using its separate gate and produces no public archive.

### Recorded gates

| Gate | Result |
| --- | --- |
| Provider typecheck/build | Passed |
| PLC read-evidence/client/rotation and archive-size checks | 3 files / **10 tests passed** |
| Public fenced transfer, migration-40 preservation/rollback and legacy-history migration integrations | 3 files / **18 tests passed** |
| Private-POC forward/return/coordinated recovery integrations | **2 tests passed**, both PLC race orders |

Migration tests preserve old table fingerprints and bearer access across upgrade,
repeat, guarded rollback and re-upgrade. Old active rows are not backfilled with
fabricated proof. Rollback refuses any retained bundle/selection. Integration
checks prove exact signed bytes, immutable archives, atomic publication, stale/
swapped selection refusal, activation sealing and lost-response recovery without
another evidence selection. Histories survive working-row cleanup by independent
historical transfer IDs. The old migration-39 abandonment refusal is tested after
rolling back empty migration 40 so a later-version guard cannot mask that proof.

All checks used local disposable PostgreSQL 14.4 and mocked PLC readers. No live
schema, independently administered service or public PLC operation was changed.
CLI remains **0.1.0**. Existing public activations without retained proof require a
separate reviewed recovery ceremony; the new runtime does not retroactively claim
their missing evidence. Rollback is supported only before retaining new proof.

## Routine public authority slice (migration 41)

The provider now supports explicit `PLC_AUTHORITY_PROFILE=strict-public-v1` with
bounded JSON reader/operator declarations and the canonical public registry.
Server HTTP/services/workers, normal operator CLIs and address discovery share
`createHailDidResolver()`. Every strict resolution reads both witnesses again,
validates complete current state/audit agreement and distinct Ed25519 roles, and
retains an immutable 8 MiB-bounded resolution bundle before returning keys. There
is no cross-call cache, stale/degraded fallback or guessed current endpoint.

Migration **41** leaves old signed/account/envelope shapes untouched and creates
no evidence for old decisions. Accepted inbound envelopes atomically bind sender
and recipient proof digests, exact signed-representation digest, local account,
parties/message ID and acceptance time. Stale (>30 s), wrong-DID/role/service or
mixed proof rolls back acceptance/claims/work. A messaging-key rotation stops new
old-key verification; already accepted work and original proof bindings remain.
Duplicate acceptance does not rewrite its original authority history.

The strict profile is a current-read policy, not owner intent or finality: a valid
provider-signed PLC change can become current immediately and remains recoverable.
Independent monitoring and timely owner recovery still matter. Prototype custodial
onboarding and activation tools refuse strict mode before database/network work;
they cannot supply the missing production owner/monitor ceremony. Private-POC
tools remain behind their pinned-registry checks. CLI package stays **0.1.0**.

### Recorded gates

| Gate | Result |
| --- | --- |
| Provider typecheck/build | Passed |
| Complete non-PostgreSQL suite | **118 tests passed**, 68 PostgreSQL tests skipped in that invocation |
| Fresh authority/envelope decision, public retention, migration-40 and legacy-history integrations | **19 tests passed** |
| Private-POC transfer/return/coordinated recovery | **2 tests passed**, both PLC race orders |

New tests prove malformed/shared-reader/private-registry configuration refusal,
prototype ceremony refusal, bounded hung-reader/clock failures, actual retention
before returning keys, no fallback after outage, immediate messaging-key changes,
original accepted proof preservation, atomic wrong/stale-proof rollback and guarded
schema rollback/re-upgrade without fabricated legacy proof. Source/target fixtures
use local disposable PostgreSQL 14.4 and mocked PLC readers, not real independently
administered infrastructure. No public registry writes or live rollout occurred.

Only envelope admission has action-bound links in this slice. Other consumers
retain verified resolution bundles but still need exact per-action bindings and
freshness at their commit/signing boundary. The new provider-local immutable history
is not silently inserted into the signed v2 transfer manifest; history transport,
restoration and owner-monitor onboarding remain their separate proof gates.

## Public Grant authority slice (migration 42)

Migration **42** adds immutable action links from each strict-public Grant revision
to the exact retained PLC decisions used for its signer, recipient and refreshed
consent evidence. Authoritative creation/update/revocation and received Grant import
validate freshness, DID, role, key and service at the repository transaction boundary;
failure rolls back lineage, revision, consent and publication writes together. Exact
received retries reuse the original retained decision, and unilateral revocation
requires only fresh grantor authority plus previously retained consent.

Focused verification passed provider typecheck, **24 non-PostgreSQL tests** and
**5 PostgreSQL integration files**, including stale/mixed proof rollback, exact retry,
immutable links, key/service matching, guarded migration rollback and adjacent
Grant/migration regressions. These use mocked readers and disposable PostgreSQL, not
independently operated infrastructure or a live public registry.

## Public signing authority slice (migration 43)

Migration **43** adds one immutable action-link table for selected Address Bindings,
authored Sender Profiles and Delivery Status wrappers. Each owning transaction checks
fresh strict-public DID, role, key and service authority and links the exact signed
representation digest to its retained resolution bundle. A failed check rolls back the
binding selection, profile revision or status payload/wrapper together. Exact retries
keep the first immutable link while still requiring a fresh current authorization check.

Focused verification passed provider typecheck/build, **20 non-PostgreSQL tests**,
the strict-public PostgreSQL proof, **14** binding/status lifecycle integrations,
**16** migration-fence integrations and **2** private transfer/return/recovery cases.
Stale profile authority rolls back its revision; wrong role/key/service evidence fails;
links reject mutation and guarded rollback. The strict evidence uses mocked readers and
disposable PostgreSQL, not live independent infrastructure.

## Public owner/monitor onboarding slice (migration 44)

Migration **44** adds an opt-in `PUBLIC_SELF_SERVICE_ONBOARDING=true` ceremony that is
available only with canonical `https://plc.directory` and `strict-public-v1`. Public
preparations are separate from private-POC records and bind the owner recovery key,
selected custody, generated provider keys, external monitor origin/key, backup
confirmation and signup-token hash. The owner signs the exact complete genesis.
Ambiguous writes reconcile and retry only those bytes; independent strict readers must
confirm the exact CID, roles and service before the Address Binding is staged.

Signup then deliberately pauses with DID/CID for owner-reviewed monitor enrollment.
The new genesis-specific monitor attestation proves immutable reviewed bootstrap state,
complete contiguous backfill, a fresh healthy poll and no recorded coverage/export/log
gap without inventing a transfer ID or prior checkpoint. Retrying `hailp account create`
with that artifact atomically seals custody, monitor payload/signature, strict PLC read
digest, exact genesis/binding digests and public activation before issuing credentials.
Owner-controlled and managed profiles share the owner-top genesis proof; only managed
mode stores the provider identity secret.

Local gates passed provider/client/monitor typechecks and builds, **118 provider
non-PostgreSQL tests**, **12 client tests**, **8 monitor PostgreSQL tests**, the focused
two-custody public-onboarding integration, **16 migration-fence integrations** and
**2 private transfer/return/recovery cases** on clean databases. Tests prove ambiguous
write recovery, stale-monitor rollback, immutable evidence, guarded rollback and exact
activation retry. Readers, PLC and monitor are fixtures: no public registry write,
independent deployment, real alert delivery or external supervision was performed.

## Same-provider custody-transition slice (migrations 45–46)

Migration **45** implements the first positive MC-11 direction:
owner-controlled → managed at the current provider. Preparation durably retains
a fresh encrypted provider identity, the complete expected PLC state, a fresh
managed Address Binding, serving generations, and an exact digest over retained
Grant history plus proposed successors. Every active authoritative predecessor
must already be acknowledged; terminal lineages are preserved without a new
revision.

The owner separately signs the exact full-state PLC operation and a
domain-separated approval binding the direction, provider, old/new keys,
predecessor CID, history checkpoint, binding, and generation change. Ambiguous
PLC submission observes or resubmits only that operation. One account-locked
transaction archives portable custody evidence, installs the matching managed
key/evidence and binding, appends Grant successors, revokes credentials, drains
worker leases, and advances the serving generation. Database guards prevent
mixed active custody and fence ordinary writes while preparation is open.

`hailp account custody managed` retains the operation and approval before
submission. After a lost completion response, the owner can obtain a fresh
owner-recovery credential and replay that state without re-signing. Focused
PostgreSQL proof covers lost-response recovery, changed operation/approval
refusal, exact completion replay, preserved signed predecessor bytes, unchanged
terminal Grants, single active custody, credential/lease invalidation, generation
advance, and guarded rollback. It uses local PLC/read fixtures and does not prove
public infrastructure or managed provider migration.

Migration **46** adds the reverse managed → owner-controlled direction without
exporting the provider identity key or promoting the vault's unused managed-era
identity. The client first persists a fresh encrypted identity, then signs the
reviewed binding and every acknowledged active Grant successor. The owner recovery
key authorizes the same exact PLC/history/generation approval used by the forward
path. Atomic materialization deletes the provider identity secret and managed
record before installing portable custody evidence; terminal Grants and original
representations remain unchanged. Rollback is refused once reverse evidence exists.

## Remaining gates and next implementation order

| Gate | Current evidence | Needed before enabling |
| --- | --- | --- |
| Managed-profile review/conformance | `hail-managed-custody-v1` and `hail.plc-read-evidence-v1` frozen; applicable private-fixture MC-01–MC-14 review complete; provider migration 50 enforces retained versions | Preserve passing conformance evidence; public/deployment portions remain in their corresponding gates |
| Shared PLC authority policy | Deployed strict-public providers default to one canonical `/log/audit` read, retain complete evidence and use public canaries as diagnostics; optional replicas remain fallback-only | Preserve authority history across transfer/restoration and complete recovery-window operational exercises |
| Strict-public managed runtime | Separate disabled-by-default runtime and two-phase CLI completion; injected strict resolver/monitor A → B → A proof, retained cutover sealing and fail-closed configuration | Keep disabled until independent deployment, recovery/load controls and permanent public canary gates pass |
| Independent monitor/bootstrap | Separately hosted public monitor retains complete per-DID audits for two canaries; reviewed onboarding attestations and signed external email alerts are live | External dead-man supervision plus real outage, disagreement and recovery proof; same hosting-provider failure remains a shared risk |
| Public onboarding | `hailproto.app` and `hailproto.dev` activated backed-up owner-controlled `plc.directory` canaries through independent signed monitor evidence; Sender Profiles, reciprocal Grants and bidirectional delivery passed | Production identity policy, abuse controls and cross-host operational proof |
| Historical reconciliation / managed transitions | Both same-provider directions and configured-registry A → B → A managed moves prove acknowledged predecessors, fresh intended-party identity, preserved terminal/history bytes and atomic generation/custody cutover | Operationalize managed moves; reconcile unsupported history or keep it explicitly blocked |
| Cross-host operation/restoration/load | Local/private continuity and migration proofs | Independently operated infrastructure, calibrated limits and latest accepted-state/ownership restoration under failures |

The first history-transport slice now versions new portable snapshots as v3 and
carries account-scoped envelope, Grant and signing authority links with exactly
their referenced immutable PLC resolution bundles. The source rejects missing,
dangling, cross-account, wrong-subject, digest-mismatched or representation-mismatched
history before signing; the destination applies the same closed-domain validation.
Retained v2 snapshots and their original signature domain remain readable for exact
retries, but cannot be presented as new history-preservation evidence. Destination
retention keeps transported history source-attributed inside the exact signed
manifest rather than refreshing it into current action authority.

Focused local proof passes provider/client typechecks, both non-database suites,
the 16-case fenced-transfer PostgreSQL integration with envelope/Grant/signing
history and tamper refusal, and the two-race private forward/return/recovery
integration through the real CLI. These use disposable local databases and do not
prove independent cross-host restoration.

Cross-provider managed migration now has local configured-registry proof through
destination materialization, exact source retirement and disposable-database
A → B → A proof in provider migration 49. The separate `PUBLIC_MANAGED_TRANSFER`
runtime now passes the same round trip under the real strict-public resolver and
public cutover gate with injected readers/PLC only. It remains disabled. Public
owner-controlled onboarding and messaging are now deployed, but no public managed
transfer has been attempted. Independent provider infrastructure and restoration
rehearsals remain next before enabling that runtime.
Local implementation does not settle pre-migration historical authority,
nullified-branch reconciliation or operational independence.
Production infrastructure still needs explicit independent hosts/operators, durable
owner recovery material, alert supervision and calibrated abuse limits.
