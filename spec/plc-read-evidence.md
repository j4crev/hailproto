# PLC Read Evidence Policy v1

Status: Draft candidate, milestone 7. This defines the next reference verification
slice, not completed production federation or reviewed historical-object authority.
It preserves PLC/Hail object formats and the canonical `https://plc.directory`
write registry. Independent deployment, operator trust and recovery evidence
remain required; local tests cannot establish administrative independence.
Reference monitor coverage has a separately versioned v2 representation below;
this does not change existing Hail COSE objects or portable snapshot formats.

## Read agreement and authority

For new public cutover authorization, query two configured, independently operated
canonical HTTPS DNS origins. Record their reviewed operator identifiers and the
source/destination provider operators. Reader operators must differ from each
other and from both providers. Origins on a provider's hostname or two ports of
the same reader hostname are not independent witnesses. These are explicit
configuration declarations, not cryptographic proof of administrative control.
Construct readers through `createIndependentPlcObserver(origin, operator)` so
their bounded, redirect-rejecting, credential-free transport actually uses the
declared origin. Source registration evidence must name the canonical public
registry; private registration and private-POC assessments cannot be relabeled.

Both reads must validate the complete canonical operation log and resulting full
state. Retrieve the complete audit, correlate every operation's DAG-CBOR CID,
DID and directory annotation, replay acceptance and recovery using the pinned
PLC priority/window validator, and require the computed nullifications and
non-nullified chain to match the audit and canonical log. A head-only audit,
changed operation under the same claimed CID, hidden canonical predecessor,
invalid fork or conflicting state is a refusal, not a partial success.

Witnesses must agree on the full canonical state/log and audit evidence, including
nullified-operation representations and directory annotations, not only the head
CID. Audit timestamps are directory claims used to check the PLC window; they
are not self-authenticating creation-time or historical-acceptance proof. A
monitor checkpoint/trusted observation cannot be replaced by timestamp matching.

No stale read cache substitutes for a missing/disagreeing witness on this path.
The caller bounds transport time and response size. The reference audit validator
caps complete histories at 1,000 entries; larger histories require a separate
bounded pagination implementation rather than truncation. The cutover assessment
must still be no more than 30 seconds old at activation commit. Routine production
authorization/cache rollout is separate and must consume equivalent evidence;
this policy does not silently replace the POC resolver for every request.

### Routine `strict-public-v1` authority

The reference runtime now has an explicitly selected `strict-public-v1` resolver
for ordinary HTTP/worker/operator resolution. Each call independently reads both
configured witnesses, validates complete canonical/audit evidence, requires full
agreement and valid distinct Ed25519 Hail roles/service, and durably retains a
bounded verification bundle before returning keys. There is **no cross-call
resolution cache**, outage fallback or single-reader fallback. The whole call is
bounded at 15 seconds by default (maximum configurable constructor bound 30 seconds).

Current keys/endpoints are those in the agreed currently selected valid PLC state,
including immediately current provider-signed operations that remain recoverable.
Removed keys are not authorized for new verification merely because an earlier
resolution was retained. This policy establishes consistency with supplied PLC
evidence, not owner consent to a change, physical custody, independent operator
control or recovery-window finality. Independent monitoring/recovery remain
activation prerequisites and their separate production gates. Historical-object
reconciliation is not inferred from current resolution or payload timestamps.

Provider migration 41 stores immutable `hail.public-plc-resolution` v1 bundles
with policy/registry/DID/head CID, complete reader documents/state/log/audit and
canonical operation bytes, operator/origin declarations and local read/verification
times. Inbound envelope acceptance binds both sender and recipient digests, exact
COSE representation digest, account/parties/message ID and acceptance time in the
same admission transaction. Decisions must be no more than 30 seconds from their
verification time, agree with the signing key/local service and reference retained
bytes. Stale/mixed/mismatched proof rolls back the received row, reply claim and
delivery-work enqueue. Duplicate accepted representations keep their original
bindings; newly read evidence does not rewrite accepted history.

This is the first action-bound routine consumer. Other services receive strict
fresh resolutions and retain their read bundles, but their action-specific
bindings still need implementation. Provider-local immutable authority history is
not yet included in the existing signed v2 portable snapshot; a separately reviewed
history/export profile is required before claiming cross-host proof preservation.
Archived reads never become authorization for a later action simply by refreshing
their timestamps. Migration 41 fabricates no old proof and refuses rollback after
any new resolution/action evidence exists.

`PLC_AUTHORITY_PROFILE=strict-public-v1`, explicit `PLC_PUBLIC_READERS` JSON and
`PLC_PROVIDER_OPERATORS` JSON select this candidate policy only with canonical
`PLC_DIRECTORY_URL=https://plc.directory`. The existing POC profile remains the
default. Normal server/worker/operator paths and address discovery share the
factory; explicitly private-POC tools remain pinned to their private registry.
Prototype custodial onboarding and local/public activation tools refuse the
strict profile rather than substituting for the missing owner/monitor ceremony.
Selecting a read policy does not declare the whole deployment production-conforming.

## Reviewed monitor bootstrap and coverage

Enrollment pins the owner-reviewed DID, exact expected operation CID, **complete**
PLC document-data state and out-of-band alert destination. All fields, including
ordered aliases, must agree with validated current reads before durable enrollment.
The legacy private-POC enrollment convenience is not production bootstrap proof.
Persist the original reviewed checkpoint separately from mutable expected state.
Approving a later operation never overwrites the bootstrap CID/state/time.

A monitor using the current export protocol starts from sequence zero and completes
contiguous backfill. An arbitrary high cursor is not a trusted checkpoint. Since
the export has no cryptographic global checkpoint proof, no late-sequence import
command is introduced. Future bootstrap from a high sequence must specify a
separately trusted, independently verified export checkpoint and preservation
proof before it can replace complete backfill.

A full export page can indicate remaining backlog. It advances the durable cursor
but leaves `caught_up=false`; only a short/empty contiguous page establishes
current catch-up. Enrollment never manufactures a healthy poll. Failed reads,
gaps, invalid logs and new full pages clear readiness. A restarted monitor retains
both cursor and readiness, and must prove fresh health before attesting. A poll
after more than 24 hours without healthy coverage still records the durable gap
alert, including enrollment that never completed its initial backfill; catching
up or delivering the alert does not erase that gap. A stopped process still needs
independently operated external health supervision to report loss while offline.

Attestation requires approved expected state, delivered out-of-band notification,
no recorded coverage/export/log gaps, completed backfill and a healthy poll within
five minutes. Public cutover consumes a signature from the enrolled monitor key
with an observation no older than five minutes, allowing at most 300 seconds
future clock skew. Coverage must begin no later than the first retained cutover
observation. This is not proof that the monitor host is independently operated;
its key and implementation must be enrolled through the reviewed owner channel.

### Reference monitor attestation v2

Use the existing deterministic CBOR/signature record with domain separation
`hail.independent-plc-monitor.v2\0` and Ed25519. The closed payload contains:

```text
type: hail.plc-monitor-attestation
version: 2
did, transfer_id, operation_cid, monitor_origin
coverage_since, observed_at: nonnegative Unix seconds
bootstrap_cid: original reviewed operation CID
bootstrap_state_digest: unpadded base64url SHA-256 of deterministic CBOR
                        encoding of the complete reviewed PLC DocumentData
export_sequence: positive safe integer, last contiguous processed sequence
```

The provider verifies the original checkpoint is in both canonical histories
**before** the current cutover, derives its complete state from that prefix and
requires the signed state digest to match. Missing/nullified/current-head-only
bootstrap checkpoints require recovery classification, not implicit re-enrollment.
The export sequence is a trusted monitor assertion, not a cryptographic directory
checkpoint or independently verified global height. Freshness and full-backfill
checks remain required even for valid v2 signatures.

V1 retains its original `hail.independent-plc-monitor.v1\0` context and closed
eight-field payload for legacy/POC verification. The public gate rejects v1;
existing enrollments are not automatically stamped as reviewed or upgraded to v2.
The monitor emits v2 only when a retained reviewed bootstrap exists. New reviewed
enrollment needs its own retained lifecycle; deleting old history to relabel an
existing enrollment is not an upgrade workflow.

### Reference onboarding monitor attestation v1

Genesis onboarding cannot use the transfer attestation: there is no earlier
checkpoint or transfer ID. After owner-reviewed enrollment and complete contiguous
backfill, the monitor may sign this closed deterministic-CBOR payload with Ed25519
and domain separation `hail.independent-plc-onboarding-monitor.v1\0`:

```text
type: hail.plc-onboarding-monitor-attestation
version: 1
did, operation_cid, monitor_origin
coverage_since, observed_at: nonnegative Unix seconds
bootstrap_state_digest: unpadded base64url SHA-256 of deterministic CBOR
                        encoding of the complete reviewed genesis DocumentData
export_sequence: positive safe integer, last contiguous processed sequence
```

The attested operation must be both the current operation and the immutable reviewed
bootstrap checkpoint. Expected state, current validated state and bootstrap state
must match exactly. The monitor requires completed backfill, delivered enrollment
notification, no recorded coverage, export or invalid-log gap, and a post-enrollment
healthy poll within five minutes. The provider
requires an observation no older than five minutes and binds the exact attestation,
genesis, strict read evidence and Address Binding in the activation transaction.
This proves local monitor readiness, not independent administration or external
supervision; deployment evidence must establish those separately.

## Recovery window, migration and historical evidence

The public cutover path still requires the exact staged full-state operation
authorized by the current index-zero owner recovery key, destination key possession,
published binding, source fence and monitor/read agreement. It may become eligible
without a blanket 72-hour wait. Eligibility alone does not activate an import,
retire a source or release a fence. Any outage, disagreement or changed operation
requires classification/recovery; there is no automatic rebasing or new signature.

An unexpected provider-signed operation may become current immediately under PLC;
it is not fresh owner intent merely because two directories report it. Preserve
the expected checkpoint, report the change and use the validated higher-priority
recovery procedure within 72 hours. Detection must occur within 24 hours; five-minute
attestation freshness does not alter the PLC recovery window.

Retain exact signed PLC operations/CIDs, canonical and nullified audit history,
complete resulting state, reader origins/operators, trusted observation times,
owner-approved checkpoints, signed monitor evidence and exact signed Hail-object
representations/publications/receipts. Provider migration 40 now retains a bounded
immutable verification bundle for each successful public cutover observation and
seals the exact selected digest at activation. Routine authorization/onboarding
retention and historical acceptance/nullified-branch reconciliation remain gates.
Directory replay establishes consistency with supplied annotations; it does not
alone prove when an old Hail signature was accepted or authorize a new signer epoch.

### Reference durable cutover evidence

The internal `hail.public-cutover-evidence` v1 deterministic-CBOR bundle contains
the transfer/DID/account and canonical registry/policy identifiers; exact import
manifest digest and submitted signed-operation JSON bytes/CID; first observation,
read-start and verification times; declared provider and reader operators/origins;
each reader's document, complete state/log/audit and canonical signed-operation
DAG-CBOR bytes; original bootstrap CID/digest/full state; and exact monitor payload,
signature and public key. It includes no account credentials, private key records
or message bodies. Each bundle is bounded at 8 MiB with bounded codec depth/items/
components; oversized verification fails rather than storing partial evidence.

`public_cutover_evidence` is append-only, addressed by SHA-256 of the exact bundle
bytes within its transfer. Identical encoded observations deduplicate. A new read
or verification time is a new observation and appends evidence without replacing
the signed PLC operation or monitor artifacts. This is not a request to generate a
new transfer/message ID. Historical identifiers do not reference recyclable working
rows, so later retirement/cleanup cannot cascade away the proof.

`public_cutover_evidence_selection` tracks the current staged selection. Public
activation requires the digest returned by its live assessment, the unchanged
staged import, matching observation/time and validated retained bytes/signature.
The ownership transaction seals that selected digest with the exact activation
time. The native schema guard refuses digest-only public activation by an older
writer. Activated selections and evidence bytes cannot be updated/deleted/truncated.

Active completion retries require that sealed original correlation and existing
current destination-key checks; they do not select fresh evidence or replay a
cutover. Missing legacy public proof is not reconstructed after activation. No
archived bundle substitutes for fresh reads to authorize a new activation or
ordinary public account action.

Migration 40 changes no legacy signed/account/observation row shape and fabricates
no proof for old rows. Its guarded rollback is permitted only before any new
evidence/selection exists and without later migrations; sole retained evidence
is never discarded. The private-POC gate remains separate and creates no public
bundle. These are local reference enforcement rules, not a live rollout or proof
of independent reader/monitor administration.

## Conformance checks

- Equal heads with different audit bytes/annotations, incomplete audits, wrong
  DID/CID/state, impossible priority recovery and inconsistent nullification fail.
- Duplicate/noncanonical reader origins, missing/reused operator declarations,
  provider-operated readers, private registry/profile promotion and witness outage
  fail before new eligibility is stored.
- Monitor state/checkpoint mismatch fails before enrollment; full-page backfill,
  failed polling, stale health, future-clock anomalies and durable gaps prevent
  coverage attestation, including after restart.
- Lost responses preserve the same operation, enrollment and contiguous cursor;
  retries cannot replace expected state or clear gaps by asserting a new label.

These checks implement parts of MC-07/MC-13 in [managed-custody.md](managed-custody.md).
They leave the broader four [production DID policy](did-profile.md#before-production)
requirements open until routine enforcement, complete retained evidence, reviewed
monitor/bootstrap trust and independent cross-host recovery have been proved.
