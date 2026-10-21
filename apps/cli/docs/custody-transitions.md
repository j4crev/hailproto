# Custody changes, managed migration and return transfers

Status: milestone-7 reference design. Both strict-public same-provider custody
directions and the local configured-registry managed path through source
retirement are implemented; production cross-provider rollout remains disabled.
This document specifies the local lifecycle
and its implementation gates; it does not amend Hail federation formats or settle
production historical PLC authority. The [protocol custody direction](https://github.com/j4crev/hailproto/blob/main/docs/production-portable-custody.md#managed-profiles-and-people-or-agents),
[DID profile](https://github.com/j4crev/hailproto/blob/main/spec/did-profile.md#provider-migration)
and [historical-key decision](grant-key-reconciliation.md) remain the baseline.

## Decisions

- The owner retains the highest-priority PLC recovery key in both profiles.
  A provider credential or provider-held identity signature cannot authorize
  changing custody, replacing owner recovery authority or moving a managed DID.
- A custody change replaces identity authority with a freshly generated key
  controlled by the intended party. Downloading an old managed private key
  cannot establish owner control: the provider may retain a copy.
- A managed move replaces the departing provider's identity, messaging and
  lower-priority rotation keys together. No provider private key is transferred.
  An owner-controlled move can preserve the owner's identity key, as today.
- Historical evidence is immutable. An unchanged DID URL does not make old and
  new public keys interchangeable. A custody label is neither key authority nor
  proof of physical custody.
- Custody change, forward migration, return transfer and rollback are distinct
  owner-authorized actions. None is inferred from missing keys or a failed retry.

## Authority matrix

Let `U` be the owner's top recovery key, `Iu` an owner-controlled identity key,
and `Ip`, `Mp`, `Rp` one provider's identity, messaging and lower rotation keys.

| Action | Required new authority | Authority removed from current PLC | Preserved |
| --- | --- | --- | --- |
| Owner-controlled → managed, same provider | Fresh provider `Ip` | Old `Iu` as current identity | `U`, existing provider `Mp/Rp`, DID/service/address |
| Managed → owner-controlled, same provider | Fresh client `Iu` | Old provider `Ip` as current identity | `U`, existing provider `Mp/Rp`, DID/service/address |
| Managed provider A → managed provider B | Fresh B `Ip/Mp/Rp` | A `Ip/Mp/Rp` | `U`, DID, unrelated PLC state |
| Managed provider A → owner-controlled provider B | Fresh client `Iu` and B `Mp/Rp` | A `Ip/Mp/Rp` | `U`, DID, unrelated PLC state |

Every row requires the owner's exact full-state PLC signature with `U` and
separate purpose-bound approval of the custody/data transition. A managed
provider's identity signature can authenticate its retained Hail history, not
stand in for independent owner approval. New identity keys prove possession
before preparation can advance. Client-held recovery/identity private bytes
never go to a provider; provider-held private bytes stay at their generating
provider. Key destruction is useful hygiene, not proof that an old key was not
copied. Current authority is removed through the validated PLC operation.

All updates preserve unrelated rotation keys, verification methods, services
and ordered `alsoKnownAs` entries. Keys removed are explicitly named outgoing
provider/identity roles, not every key absent from a convenient template. PLC
capacity limits still apply. A failed capacity/role check requires a deliberate
new preparation, not silent removal of unrelated authority.

Same-provider owner control still leaves that provider's lower-priority PLC
authority powerful. It is not threshold control or a promise that the provider
cannot subsequently replace the identity key. Production requires independent
monitoring and the existing PLC recovery procedure.

## Signed records and preparation

Use a separately versioned reference-provider transition profile; do not make
managed accounts pass the existing identity-signed portable handshake by
changing a flag or borrowing an unused local vault key. The current portable
manifest v2 and its provider-held-identity rejection remain unchanged.

Preparation records bind a transition ID, nonce, DID, current provider/custody,
intended provider/custody, complete expected PLC CID/state, old public role keys,
proposed public role keys and a short expiry. The owner signs the exact record
with recovery authority using a purpose-specific domain-separated signature;
the current reference owner key is P-256, verified through the existing account-
access crypto primitives. This is a proposed local format, not an alternate
signature algorithm for existing Ed25519 Hail objects.

Use distinct purposes for preparation, address selection, final commit and
abandonment. Preparation may allocate inert keys/slots, but does not authorize
PLC submission or release a fence. Final commit additionally binds the exact
source snapshot digest, historical-evidence checkpoint digest, selected address,
destination Offer/reservation digests, custody direction and DAG-CBOR hash of
the owner-signed PLC operation. The owner signs final approval only after those
values are available. Retain every exact representation before submission;
changing a direction, key, provider, checkpoint or predecessor is a new action,
not an exact retry. New signatures are never minted to hide an ambiguous write.

For cross-provider moves, retain destination-origin proof and the source-signed
invitation/challenge from the current handshake. The new profile's destination
Offer must bind its proposed identity key and intended custody as well as
messaging/rotation keys. The owner explicitly selects an address beneath the
destination's domain. Providers cannot use managed identity signing to approve
their own removal or extend the owner's intent. Source bearer credentials are
never forwarded; destination credentials are established by explicit owner login.

## Same-provider custody transition

1. Read and validate complete current PLC/custody state and owner recovery
   authority; generate the proposed identity key at its intended custodian.
2. Inventory identity-signed Grant/binding history and acknowledged predecessor
   checkpoints. Complete the historical-key gate below before accepting a final
   transition. Prepare the replacement binding for the same address.
3. Authenticate account administration and independently verify owner approval.
   Acquire a transition fence at the account-row serialization point. Drain or
   invalidate worker leases and freeze the complete DID-owned domain, including
   managed Grant signing; capture the exact history/checkpoint digest.
4. The owner signs the complete reviewed PLC operation and final transition
   approval. Keep `U` first; replace only `hail-identity` for this same-provider
   action. Preserve current messaging/service and the lower rotation key unless
   separate reviewed authority explicitly changes them. The client compares the
   exact pre-transition state with the proposed operation and refuses any other
   alias, service, verification-method or rotation-key change. That comparison
   does not replace independent-reader proof that the supplied pre-transition
   state is the current public PLC state.
5. Submit the same operation until its exact CID is observed, using the existing
   PLC trust gate. Unknown intervening operations require recovery classification,
   not automatic rebasing on an unapproved predecessor.
6. While still fenced, establish the new binding's exact signed bytes and
   verified publication; verify new-key possession and custody classification.
   Atomically install new active custody evidence and identity role, archive
   previous evidence, invalidate old credential/challenge generations, then
   resume under one serving generation. Never leave both active custody rows.
7. Reconcile eligible active Grant successors under the new key before their
   normal mutation paths resume. Establish fresh credentials deliberately:
   identity proof for owner-controlled custody, owner-recovery proof for managed.

The identity signer changes only when the observed PLC, active custody record,
binding and local key role agree. A label flip is not a commit. Returning to the
previous custody choice is another owner-approved rotation, never restoration
of a retired private key through a database toggle.

The client preserves its existing recovery key/record when preparing a fresh
identity key; creating a new vault with an unrelated recovery key is not a
custody transition. Verify an independent backup of the resulting owner-held
material and update the monitor's reviewed expected CID/state. Managed custody
does not eliminate owner recovery backup or independent production monitoring.
Materialization needs a narrow generation-checked transaction under the account
lock; it must not disable the existing fence triggers for unrelated writers.

## Managed provider migration

Use the existing fenced transfer serialization and activation machinery, with
a new explicit manifest/profile version for managed history. The new profile
must carry source/destination custody, old/new identity public keys and verified
historical checkpoints; its keys table carries public role evidence only.
Destination-local prepared identity ciphertext is never part of the export.
The managed snapshot also preserves owner-recovery custody evidence, which is
absent from today's portable `TRANSFER_TABLES` serialization.

The order remains owner-approved preparation → origin-confirmed Offer → owner-
approved address selection → final source fence → immutable export → owner-
approved exact cutover → inactive validated import → observed PLC/binding →
destination activation → signed source retirement. The destination constructs
its active owner/managed custody record from the reviewed destination profile,
not by treating the source's old record as current destination authority.

The final PLC operation removes A's `Ip/Mp/Rp` and installs the explicitly
selected B/client identity and B operational keys, keeping `U` first. Keeping
A's identity public key current while promising A will stop signing is not a
managed migration. B never imports A's provider-held identity private key.

Import and activation preserve accepted envelopes, replay/rejection records,
Grant lineage/tombstones, reply claims, body provenance, deterministic status
payloads and ordered outbox responsibilities. Messaging rotation permits a new
status wrapper around the same payload/revision; it does not permit replacing
accepted envelope bytes, resetting attempts, extending deadlines or inventing
semantic status revisions. Old workers remain fenced. Expired work follows the
existing delivery deadline rules after continuation.

### Native managed migration implementation checklist

This checklist tracks the narrow MC-12 slice. It remains local-only until every
item has focused proof; it must not contact public PLC infrastructure or claim
independent reader/monitor operation.

- [x] Bidirectional same-provider custody rotation with fresh intended-party
  identity, acknowledged Grant successors, exact retries and atomic generations.
- [x] Migration 47: durable managed-transfer profile, source/destination custody
  declarations, fresh destination identity material and guarded rollback.
- [x] Owner-recovery handshake: one exact A → B intent and address selection;
  provider identity signatures cannot substitute for owner authorization.
  The versioned grant, source acknowledgement, selection and exact snapshot-v4
  approval validators are implemented. Source admission is durable and refuses
  changed retries; destination ingress returns the exact retained Offer, and the
  owner vault can sign each owner artifact. The authenticated source API, pinned
  destination HTTPS route and separate durable managed-Offer retry worker are
  implemented locally. B now atomically reserves the owner-selected address,
  signs the exact reservation and durably retries its signed fence request to
  A. `hailp account managed-transfer offer|status|select` now retains and
  validates the exact owner-signed grant, source acknowledgement, destination
  Offer, owner selection and destination reservation across ambiguous retries.
- [x] Destination Offer: fresh B identity, messaging and rotation keys, with all
  private material encrypted and retained only at B.
- [x] Managed snapshot v4: the local exporter carries source-attributed managed
  custody, serving generation, exact authority/Grant/binding/PLC history and
  public role metadata only. Its validator rejects history-checkpoint changes;
  provider/client private keys and bearer credentials are excluded.
- [x] Source fence/export: the managed source fence validates the exact
  owner grant, A acknowledgement, B Offer, owner selection, B reservation and
  B fence request against strict current custody. It refuses active worker
  leases and unacknowledged active Grant predecessors, then blocks ordinary
  writes. Export is immutable, source-messaging signed and exact-retryable.
- [x] Owner-approved cutover evidence and inert staging: the owner vault builds
  and signs an exact PLC operation that removes A's rotation role, installs B's
  fresh identity/messaging/rotation roles, preserves top recovery and unrelated
  PLC state, and enforces the PLC size limit. The owner-recovery approval binds
  that operation to the exact handshake, snapshot-v4 digest and history
  checkpoint. B revalidates current strict A authority, every retained artifact
  and B's prepared private-key possession, creates a B-identity-signed binding,
  and stores one exact-retryable inactive import. No account is materialized and
  no PLC operation is submitted by this gate.
- [x] PLC submission/observation and destination materialization: configured-registry
  submission reconciles an ambiguous write and requires strict readers to
  confirm the exact retained operation and destination roles without contacting
  the public directory. Migration 49 then atomically consumes the reserved
  address, installs only B's fresh keys and managed-custody record, preserves
  accepted work/history, creates acknowledged-predecessor Grant successors,
  advances beyond the source generation and activates the inert import. No
  credential is transported; fresh access still requires owner-recovery login.
- [x] Source retirement and exact retry/recovery under lost Offer, export, PLC,
  activation and retirement responses. B signs the exact retained activation
  receipt with its current messaging key; A checks current PLC authority,
  archives once and accepts only byte-identical retirement retries.
- [x] Disposable-database A → B → A proof including stale workers, terminal
  Grants, history bytes, changed-artifact refusal and guarded rollback. The
  return validates A's immutable retired projection, installs fresh A roles at
  generation 3, preserves terminal Grant bytes, creates the active Grant's next
  successor, revokes old credentials, rejects stale generation-1 work, retires
  B exactly and redacts every prepared private-key field from archived imports.

The narrow slice refuses unacknowledged/conflicting Grant predecessors, nullified
or disputed PLC history, mixed custody, non-strict authority and pre-existing
destination ownership. Those cases remain separate reconciliation work.

### Managed private-PLC operationalization checklist

Migration 49 is deployed to both POC providers, but the managed completion path
is deliberately not wired into startup and its federation routes remain disabled.
Before calling managed migration usable on the private-PLC POC:

- [x] Add one disabled-by-default private-PLC managed-transfer feature flag and
  reject incompatible registry/profile configuration at startup.
- [x] Wire managed invitation, reservation, fence, export, staging, configured-
  registry submission, activation, receipt and retirement services into startup.
- [x] Add authenticated source export and bounded, exact-artifact destination
  completion APIs without exposing private keys or source credentials.
- [x] Add `hailp account managed-transfer export`, cutover signing and completion
  commands with durable state and byte-identical retry checks.
- [x] Complete a disposable HTTPS `hailproto.app → hailproto.dev → hailproto.app`
  managed move against the configured private PLC.
- [x] Restart providers between phases and deliberately lose Offer, export, PLC,
  activation and retirement responses; resume only the retained exact artifacts.
- [x] Verify fresh owner-recovery login, no credential transport, old credential/
  worker rejection, message and Grant continuity, terminal evidence, and serving
  generations `1 → 2 → 3`.
- [x] Retain pre-rollout backups and evidence, roll providers individually, verify
  external readiness/alerts, and keep managed routes disabled after any failed gate.

Completed October 13, 2026. The live disposable round trip used DID
`did:plc:j5x2ftke7574uzkjgj547loq`; retained server evidence and verified backups
are under `/var/backups/hail-poc/pre-managed-operationalization-20261013T004200Z`.
The live run covered provider restarts and deliberately lost Offer, reservation,
export, completion/activation and retirement responses. The disposable-PostgreSQL
proof covers a lost PLC response, non-empty message/active-Grant/terminal-Grant
continuity and stale-worker rejection. Both providers run source `5d4d219` and
image `hail-server-ts:poc-managed-operationalization-20261013-fix1`. This remains
a configured private-PLC POC, not independent/public production evidence.

### Production enablement: required versus deferrable

The private PLC runs the same directory implementation as the public service, so
it can prove protocol behavior and most operational controls. Its observations
remain `poc-local`: they do not prove public deployment configuration, operator
independence, network behavior, limits or reader agreement. The remaining items
below block public managed migration; owner-controlled public-alpha onboarding is
already enabled separately.

#### Complete before the public managed-transfer switch

- [x] Freeze and review the enabled managed-custody/read-evidence profile, complete
  all applicable conformance cases against private fixtures, and version every
  retained production record.
- [x] Implement a separate, disabled-by-default public managed-transfer runtime
  using the strict public resolver and cutover evidence. Keep the private gate
  incompatible with `https://plc.directory` and test the public path through
  injected fixtures without weakening that guard.
- [x] Deploy a separately hosted public monitor with reviewed bootstrap, complete
  per-DID audit retention, bounded freshness and externally hosted signed email
  alerts; enroll both public alpha canaries.
- [ ] Add external monitor dead-man supervision and exercise live disagreement/gap
  refusal and recovery-window outages. Same-host or same-provider failures are not
  independent evidence.
- [x] Establish durable off-VPS owner-recovery backups and automated weekly VPS
  backups for the public alpha.
- [ ] Establish production provider-key protection, least-privilege operator access,
  rate/size limits, audit retention and incident ownership.
- [ ] Exercise cross-host backup/restore from the latest accepted private state,
  including stale credential, challenge, worker, lease and generation rejection.
- [ ] Handle unsupported historical states safely using private/synthetic histories:
  acknowledged predecessors may migrate; unacknowledged, conflicting, nullified or
  disputed history must reconcile under a reviewed algorithm or remain blocked with
  an operator-visible recovery path. Supporting every historical edge case is not a
  launch requirement.
- [ ] Define and exercise pre-activation abandonment and ambiguous-activation
  recovery against the private PLC, including delayed replay of signed operations.
  Automated rollback is optional, but reopening a stale source, relying on expiry,
  or silently losing accepted state is forbidden.
- [ ] Calibrate and enforce a documented supported load envelope on private clones,
  then prove alerts and recovery at that boundary. Do not load-test the public PLC;
  unbounded scale testing is not required.

The first item completed October 13, 2026. The frozen identifiers are
`hail-managed-custody-v1` and `hail.plc-read-evidence-v1`; their
[MC-01–MC-14 review](https://github.com/j4crev/hailproto/blob/main/spec/managed-custody-conformance-v1.md)
maps each private-fixture proof and explicitly leaves public/deployment evidence
to the gates below. Provider migration 50 backfills candidate rows, requires new
managed/onboarding/transition writers to retain the managed profile, and versions
public onboarding, resolution and cutover evidence independently from custody,
registry and activation modes. Legacy exact private-POC snapshot retries remain
readable but cannot be promoted to strict-public evidence.

The second item completed October 13, 2026, in private/injected fixtures only.
`PUBLIC_MANAGED_TRANSFER` is off by default and requires production strict public
authority, two reviewed readers, both provider operator declarations and a pinned
independent monitor. It rejects private-POC gates. The public runtime uses full
public cutover evidence and seals its selection atomically with activation; the
private runtime and registry guards remain separate and unchanged.

For public transfers, first run `hailp account managed-transfer complete --state
<state> --snapshot <snapshot>` to stage/submit the exact operation. An
`awaiting-monitor` response does not activate or retire either provider. Obtain a
fresh reviewed v2 monitor report for that operation, then retry with
`--monitor-attestation <private-json-file>` (`{payload, signature}`, canonical
base64url bytes). Only the monitor report may be refreshed; snapshot, approval
and PLC operation stay exact. Private transfers reject this option. Fixture tests
exercise both profiles through `A → B → A` and fail closed on missing/invalid/
stale/gapped/wrong-bootstrap reports, reader outages/disagreement and profile
mismatch. No public PLC request or deployment change accompanied that fixture gate;
the later owner-controlled alpha deployment did not enable public managed transfer.

#### Final evidence that requires the public environment

- [x] Bootstrap the monitor against the actual public PLC and prove complete current
  history, bounded freshness and external signed-alert delivery for enrolled DIDs.
- [x] Create backed-up, non-user public alpha canaries for both providers and retain
  their exact genesis/write/readback and onboarding-monitor evidence.
- [x] Perform low-rate public TLS, strict-public evidence, Sender Profile, Grant and
  bidirectional message-delivery smoke checks without malformed or high-volume traffic.
- [ ] Add external health supervision and prove public outage recovery and supported
  service limits without load-testing `plc.directory`.
- [ ] Use a reviewed permanent canary for the managed `provider A → provider B →
  provider A` round trip before enabling public managed transfer.

Hardware-backed/device-keystore integration, cross-platform binaries, automatic
provider discovery and a polished consumer review UI are valuable follow-up work,
not universal backend production blockers. They become release requirements only
when the chosen client platform, custody threat model or product promise depends
on them.

## Historical identity and binding gate

The implemented same-provider paths accept only active authoritative
Grant lineages whose current publication is acknowledged. It precomputes a
higher revision with unchanged authorization/consent and the exact predecessor,
then installs those successors in the custody transaction. Terminal lineages are
left unchanged. Unacknowledged and conflicting predecessors still block.
Managed cross-provider materialization now applies the same acknowledged-
predecessor rule and signs a successor with the destination identity. Production
enablement remains gated on operational wiring and the production controls above.

- Retain each original COSE representation/digest, exact signer public key,
  validated PLC operation/audit evidence, trusted observations/checkpoints,
  consent bindings/profiles and ordered publication/receipt history.
- For active authoritative lineages, establish the exact acknowledged
  predecessor and required ordered publications before planned rotation.
  After authoritative rotation, reconcile a higher revision with unchanged
  authorization/consent and the exact predecessor digest. Never re-sign the
  same revision or create a new Grant ID as a repair shortcut.
- Terminal tombstones remain terminal immutable evidence; do not append an
  active or "rekeyed" terminal successor merely to update the signer.
- Unacknowledged, ambiguous or conflicting predecessors require historical
  verification and sequential receiver reconciliation. No silent key fallback,
  unsigned blocking or automatic permission extension is introduced.
- Preserve old bindings and their domain-selection/acceptance evidence for
  audit, but publish a fresh binding under the new current identity key before
  normal address intake resumes. Do not treat an expired/removed-key binding
  as current discovery authority just because it is retained in history.
- Historical verification must classify nullified/recovered PLC branches and
  establish authority at the relevant accepted state. A payload timestamp,
  directory timestamp, old DID URL or public log membership alone is not proof.

This gate covers incoming counterpart evidence as well as local authoring.
Production cache/finality and historical verification rules still require the
shared DID-profile specification work; this local design does not define them.

## Return to a former provider

The [migration 36–38 foundation](generation-bound-return.md) captures immutable
retired history and proves generation-bound stable-owner private-POC returns.
Migration 49 adds the managed A → B → A materialization proof with fresh provider
roles. The managed runtime remains disabled on the VPS, and neither local proof
establishes public historical authority or post-export abandonment safety.

Treat A → B → A as two new transfers, not an undo of A → B. A generates fresh
operational keys and a fresh import/Offer/transfer ID; a retired identity key
is not reused for a managed return. B supplies the latest fenced serialization
domain, including work accepted after the first move. A's old export cannot be
substituted for B's current snapshot.

Current blockers are concrete: fences and authorizations are keyed by DID,
exports reference the fence's transfer ID, the account's DID is unique, and
`stageImport()` rejects an existing local account for that DID. Activation
inserts snapshot-owned rows rather than replacing a retired working projection.
Removing a fence or deleting old rows to make those constraints disappear
would destroy evidence and can reactivate old credentials/workers.

Implementation decision: separate immutable lifecycle history from the single
live working projection. Archive each retired transfer's exact export, consumed
handshake, PLC/custody evidence and retirement receipt under its transfer ID;
use a serving generation for the current DID-owned projection. Preserve existing
account/message/Grant identifiers and foreign-key relationships, rather than
inventing a second live DID account. Old history is readable evidence, not a
second executable outbox.

A compatibility migration must preserve legacy v2 bytes and retired receipts,
backfill generation/history links and leave the current active pointer unchanged.
Credentials, login challenges and worker claims bind their admitted generation;
revoke old credentials/challenges before reopening the projection. Losing the
old fence must never make a previous token or lease usable again.

For the first returning materialization, lock the affected DID/account and
shared Grant ownership rows, archive the retired projection, validate the
incoming latest snapshot, then replace only that DID's working domain and
publish a new active generation atomically. Preserve collocated counterpart
ownership/receiver associations; never delete another account's Grant evidence.
Retained replay records and revision checkpoints that are still required but
missing/conflicting in the incoming snapshot block activation. Archive older
evidence separately; do not merge stale delivery/status rows into current work.

No return path is enabled until its preservation and competing-worker tests
pass. The required schema/serialization changes need their own reversible
compatibility migration; this document adds no columns or runtime exceptions.

## Post-export abandonment and recovery

An import invalidation receipt is necessary but not sufficient to reopen an
exported source. **PLC operations have no consent expiry.** A previously signed
cutover may be submitted by a relayer after a provider has invalidated its slot.
The rollback protocol must make that exact operation unable to advance current
PLC state, not merely stop one provider's worker.

| Observed phase | Intended action |
| --- | --- |
| Before source fence | Existing signed pre-fence cancellation and source no-fence receipt |
| Fenced, no export | Reviewed coordinated abort; invalidate the target session/final pushes before source resumption; preserve replay tombstones |
| Exported, target never active | Owner-authorized abandonment plus target invalidation/quiescence and a protective source PLC operation |
| Target operation committed, target never active | Append an owner-signed source-restoring operation to that recognized current state, then complete the same coordinated invalidation/resumption proof |
| Target active or activation outcome uncertain | Continue forward or perform a new reverse transfer of the target's latest fenced state; never reopen the stale original export |
| Unexpected lower-priority fork | Validate audit/fork point and use the separate recovery procedure within PLC's window; do not adopt the unwanted operation as a normal ancestor |

For exported-but-never-active abandonment:

1. Owner recovery approval names source/target, transfer/generation, snapshot,
   prepared operation CID and observed PLC baseline. Fence both lifecycle
   executors and quiesce/inventory submission attempts, including ambiguous ones.
2. Target atomically invalidates staging and activation eligibility and retains
   an exact signed receipt binding all those identifiers and the invalidated
   prepared operation. No expired lease or stale completion may reactivate it.
3. Owner signs and retains a full-state protective operation keeping service at
   the source and removing prepared target authority. If the cutover has not
   committed, advance the recognized current predecessor with top owner
   authority; otherwise append to the recognized committed cutover. Verify the
   exact new current CID/state through the applicable trust gate.
4. Demonstrate that the earlier prepared operation's `prev` is stale and cannot
   nullify that top-owner-signed protective successor. PLC recovery requires a
   strictly higher-priority signer than the first nullified operation; the same
   top key cannot nullify its own already accepted successor. Thus a committed
   top-owner cutover is restored by a normal append, not a same-key fork claim.
5. Exchange durable source/target acknowledgement of invalidation and the
   protective CID. Only then install a new source serving generation, reconcile
   its published binding and revoke stale credentials/challenges/leases before
   resuming. Release target reservation only with that coordinated proof.

A target that is offline, uncooperative, active, or ambiguous cannot supply this
never-active proof; the source stays fenced. Owner recovery may restore DID
authority without recovering lost accepted state. That is an explicit continuity
loss, not a successful rollback. Neither restoring a database dump nor waiting
for consent/reservation expiry establishes exclusive ownership.

## Implementation order and executable proof gates

Steps 1–4 gate identity-changing/managed paths. Stable-owner-identity private-POC
return and abandonment can proceed with the generation/history work and their
own proof gates without first enabling identity-key reconciliation. That narrower
proof still does not settle production historical authority or managed migration.

1. Implement historical-key verification/reconciliation and the acknowledged
   active-lineage path. Prove original signatures/digests, terminal tombstones,
   unavailable receivers, lost acknowledgements and nullified-branch handling.
2. Implement serving-generation/history migration and exact transition records.
   Prove byte-preserving upgrade/rollback, current pointer preservation, stale
   credential/challenge/lease rejection and collocated-account isolation.
3. Implement same-provider transitions in both directions. Prove new-key
   possession, top-owner authorization, atomic custody classification, exact
   PLC retries, binding replacement, preserved consent and no private-key export.
4. Implement the separately versioned managed transfer profile. Prove old
   provider `Ip/Mp/Rp` removal, destination-local keys, fresh owner login and
   unchanged accepted message/status/outbox semantics through interruption.
5. Prove A → B → A with retained history and concurrent stale A workers/tokens,
   using work created/acknowledged at B between moves and both custody profiles.
6. Implement and prove abandonment with races at staging, PLC send, publication,
   activation and acknowledgement. Delay/replay the original signed operation
   after invalidation/protective cutover; reject it without opening a second
   writer. Reject stale completion after invalidation and changed receipts.
7. Prove active-target reverse transfer from the latest state, including accepted
   work, delayed status acknowledgements, restart and coordinated backup restore.

Completion conditions are one executable owner, preserved accepted-state and
historical evidence, exact retries and no credential/key forwarding. Negative
guards already present in the portable implementation are not proof of return
or post-export recovery. The roadmap's return/rollback item stays open until the
positive round trips and race tests above are implemented and pass.

### Existing implementation seams

In the sibling provider repository, `src/accounts/access.ts` supplies independent
owner-recovery proof and rejects mixed active custody evidence;
`src/grants/service.ts` and `src/grants/repository.ts` hold identity-epoch changes;
`src/migration/transfer.ts` validates portable snapshots and rejects a destination
that already has the DID; `src/migration/activation.ts` materializes only a fresh
destination; and `src/migration/fence.ts` permits release only before export.
Migrations 13, 14 and 21 show the current DID-keyed fence/export/retirement links.
These are the seams to extend, not alternate services that bypass their guards.

PLC's strict higher-priority fork requirement is implemented in the workspace's
`did-method-plc/packages/lib/src/data.ts` `assureValidNextOp()` function: its
recovery signer set is the keys preceding the first nullified operation's
signer. `test/private-poc-migration.integration.test.ts` and
`test/migration-fence.integration.test.ts` are the existing forward-transfer,
expiry, fence and accepted-state regression baselines, not return-proof tests.
