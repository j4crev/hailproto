# Custody changes, managed migration and return transfers

This reference describes implemented custody and provider-transfer behavior and
its authority requirements. Public and private execution are separate opt-ins;
inspect each provider's configuration rather than inferring enablement from this
file. Normative authority remains in the [DID profile](../../../spec/did-profile.md)
and [managed custody profile](../../../spec/managed-custody.md).

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
invitation/challenge from the current handshake. The managed profile's destination
Offer must bind its proposed identity key and intended custody as well as
messaging/rotation keys. The owner explicitly selects an address beneath the
destination's domain. Providers cannot use managed identity signing to approve
their own removal or extend the owner's intent. Source bearer credentials are
never forwarded; destination credentials are established by explicit owner login.

## Same-provider custody transition

Migration 75 supports settled connection history in both custody directions.
Successful cutover retires all existing personal and expiring connection codes;
create new codes after signing in with fresh credentials. Established connections,
disconnect tombstones, consent bytes and messaging authority are preserved.
Pending connection approvals, admission/disconnect/replication work, message targets
and active handovers must finish before preparation. Obsolete native connection
records remain unsupported, as they do for provider transfers.

The owner-approved history checkpoint includes the existing portable connection
history digest and `invalidate-at-cutover` share policy. Preparation captures it
under the account lock before the custody fence is released. Code retirement,
pair-generation advancement and key installation commit atomically. Exact retries
after an ambiguous PLC response or local failure reuse the original approval.

Deploy schema and application together. Old writers with retained connections are
refused before journaling a new PLC submission. For rollback, finish pending
connection-bearing custody transitions first; migration 75's down migration restores
the old guards without deleting history or reviving codes. Public enablement remains
controlled by `PUBLIC_CUSTODY_TRANSITIONS` and the existing deployment gates.

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
an explicit managed manifest/profile version carrying source/destination custody,
old/new identity public keys and verified
historical checkpoints; its keys table carries public role evidence only.
Destination-local prepared identity ciphertext is never part of the export.
The managed snapshot also preserves owner-recovery custody evidence. Portable
and managed snapshot formats retain their separate validation/signature domains.

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

## Production enablement: required versus deferrable

Each participating public provider needs key protection, least-privilege access,
backup/restore, rate and size limits, audit retention, incident ownership and
external overload alerts. A rehearsal on shared operator infrastructure does not
prove unrelated-provider interoperability. Keep `PUBLIC_MANAGED_TRANSFER=false`
until the deployment's controls are verified. Separate private-PLC gates must not
be used against the public registry.

Public completion stages/submits the exact operation first. If it returns
`awaiting-monitor`, obtain fresh reviewed coverage for that operation and retry
with `--monitor-attestation`. Only the monitor report may be refreshed: snapshot,
approval and PLC operation remain exact. Private transfers reject that option.
See [CLI workflows](cli-workflows.md#start-a-managed-account-provider-move).

Unsupported, unacknowledged, conflicting or nullified history must remain blocked
unless a reviewed recovery procedure establishes authority. No public PLC load
test is required; qualify service limits with controlled fixtures and verify
public connectivity and alerting separately. Hardware-backed client keys and a
consumer review UI are separate product work, not substitutes for these controls.

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
shared DID-profile specification; this local reference does not redefine them.

## Return to a former provider

Treat A → B → A as two new transfers, not an undo of A → B. A generates fresh
operational keys and a fresh import/Offer/transfer ID; a retired identity key
is not reused for a managed return. B supplies the latest fenced serialization
domain, including work accepted after the first move. A's old export cannot be
substituted for B's current snapshot.

Separate immutable lifecycle history from the single
live working projection. Archive each retired transfer's exact export, consumed
handshake, PLC/custody evidence and retirement receipt under its transfer ID;
use a serving generation for the current DID-owned projection. Preserve existing
account/message/Grant identifiers and foreign-key relationships, rather than
inventing a second live DID account. Old history is readable evidence, not a
second executable outbox.

Credentials, login challenges and worker leases bind their admitted serving
generation. Authentication and transactional admission reject stale generations,
even if a token's revocation flag is cleared. Imported leases are cleared while
attempts, deadlines and retry schedules are retained. Retired outgoing and incoming
transfer evidence is immutable and cannot become a second executable outbox.

For returning materialization, lock the affected DID/account and
shared Grant ownership rows, archive the retired projection, validate the
incoming latest snapshot, then replace only that DID's working domain and
publish a new active generation atomically. Preserve collocated counterpart
ownership/receiver associations; never delete another account's Grant evidence.
Retained replay records and revision checkpoints that are still required but
missing/conflicting in the incoming snapshot block activation. Archive older
evidence separately; do not merge stale delivery/status rows into current work.

Application rollback must preserve generation-aware readers and writers after
advancement. Schema rollback cannot discard the only surviving archive or undo
later migrations. Old snapshots retain their exact bytes/signature domains;
compatibility does not authorize reopening retired state.

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

## Recovery implementation boundary

The private-PLC `PrivatePocTransferAbandonment` coordinator is an integration-only
path, not a public route or `hailp` command. It covers a staged, never-active target.
Independent owner approvals bind source/target, transfer, generation, snapshot,
prepared cutover CID, nonce and an acceptance window. Resumption additionally binds
the target invalidation digest and protective operation CID.

Invalidation retains an exact prepared-target-key receipt while holding the address
reservation. Release verifies current protective PLC authority, records immutable
import/handshake/observation evidence and a nonce tombstone, then releases the slot.
Source resumption verifies the origin-confirmed destination signature, original
binding and fenced generation, revokes old credentials/leases, advances generation
and preserves accepted work. Lost replies recover the same signed results.

Unknown forks, unavailable counterpart proof and expired/conflicting source bindings
remain blocked. An active or uncertain target requires forward completion or a new
reverse transfer. This private recovery path is not general public abandonment.

## Connection history and cleanup

Settled supported connections survive same-provider custody changes and configured
provider transfers. Retire old share codes at committed cutover, preserve connection
IDs/epochs and immutable consent/terminal history, and require fresh destination codes.
Pending work must drain; missing orchestration or unsupported native records fail closed.

Pre-launch cleanup must inventory exact accounts/pairs and dependent approvals,
proofs, message targets and envelopes, verify a backup, and preserve referential
consistency. Recreate removed relationships through fresh consent; do not invent
historical signatures or erase unrelated messages, keys or recovery material.

## Verification

Provider suites cover custody transitions, managed network orchestration,
private-PLC migration, serving-history preservation and connection handover.
Run them against disposable databases. Preservation requires one executable owner,
exact signed history, stale-token/worker rejection and accepted-work continuity;
a negative refusal test alone does not prove a successful transfer or recovery.
