# Hail Managed Identity Custody Profile v1

Status: Draft candidate — milestone 7 specification/conformance work. This is not
a reviewed production release or permission to enable public registration. The
identifier `hail-managed-custody-v1` names this custody profile, not a new Hail
wire object, COSE algorithm, account API or PLC operation format.

The [onboarding profile](account-onboarding.md) remains the baseline. A production
provider must continue to support portable owner-controlled custody. Managed v1
is a separately, explicitly selected alternative with different identity custody;
provider-held recovery remains the custodial POC, not this profile. All shared
onboarding, Hail key-role, backup, monitoring, registration, discovery and delivery
requirements apply unless the difference is stated below.

## Authority and disclosure

| Role | Custodian | Authority |
| --- | --- | --- |
| Highest-priority PLC recovery | Owner/controller, outside provider control | Exact reviewed PLC genesis, updates and recovery |
| Lower-priority PLC rotation | Provider | PLC updates; not threshold control |
| `#hail-identity` | Provider | Authorized Grants and Address Bindings |
| `#hail-messaging` | Provider | Envelopes, replies, Sender Profiles and delivery status |

An owner/controller may be a person or organization, including the controller of
an agent. Actor type never selects custody. Consent to managed identity custody
must precede provider identity signing and be recorded separately from recovery
custody and PLC verification/monitoring mode. Labels are declarations, not
cryptographic proof that another party lacks a key copy.

Each key is generated independently for one DID and one role. Both Hail keys are
distinct Ed25519 keys with the existing exact did:key/Multikey encoding; PLC
rotation keys use the permitted P-256 or secp256k1 types. The provider generates
identity, messaging and lower rotation keys locally and proves possession before
activation. The owner generates the top recovery key outside provider control,
verifies an independent backup and never uploads its secret/private material.
An unused local client identity key is not the managed DID's active identity.

The provider can create valid identity consent signatures without an additional
owner identity signature. This must be disclosed; it is neither message
confidentiality nor threshold control. A lower-priority provider PLC update can
become current immediately, including one removing owner authority. Independent
detection and timely higher-priority recovery remain necessary within PLC's
72-hour window. Holding owner recovery does not prevent interim impersonation.

## Onboarding and activation

1. Select managed custody explicitly and reserve inactive local resources. Retain
   account-bound custody consent, owner recovery public key, provider role public
   keys, registry origin and expected complete PLC state. Do not claim portable
   identity custody or fabricate independent evidence for a private-PLC account.
2. For a new DID, the owner reviews and signs the exact regular `plc_operation`
   genesis with `prev: null`, owner recovery first, provider rotation below all
   owner recovery keys, distinct provider Hail roles, prepared HTTPS service and
   empty `alsoKnownAs`. No addresses or unnecessary metadata enter PLC state.
   The reference new-genesis signer supports exactly two rotation keys, two Hail
   methods and one service; broader state needs a separately reviewed ceremony.
3. Derive DID/CID from the exact signed DAG-CBOR bytes, apply PLC limits and retain
   the operation before submission. Only canonical `https://plc.directory` writes
   establish public Hail v0 registration. Never create disposable public identities
   as tests. Private-PLC tests remain explicitly isolated.
4. Reconcile ambiguous writes against the same exact operation. Every retry checks
   owner signature, DID, public roles, selected provider and retained full state,
   even after the client's vault is bound. A confirmed hash-prefix collision is
   handled by the existing explicit new-ceremony exception, not automatic keys.
5. The provider signs the Address Binding using its managed identity key after
   verified registration. Hosting precedes selection; external discovery verifies
   exact address, DID, binding, identity/messaging roles and prepared service.
6. Independent monitor/read evidence, recovery backup verification and shared
   production PLC authority policy must pass before public activation. Record
   the profile version separately from monitor/registry/activation modes. Current
   `poc-local` managed custody rows do not satisfy this production evidence.

Existing-DID onboarding preserves unrelated keys, methods, services and ordered
aliases under the existing onboarding rules. An existing Hail account instead
requires its retained lifecycle or a fenced transition; managed selection never
overwrites continuity-bearing state or promotes a lower-priority owner key.

## Routine account operation and recovery

The account API authenticates the caller, checks current account/generation,
scopes, fences and lifecycle, then uses only that account's managed signer.
Automation may sign only under an explicit account-bound policy with bounded
actions/scopes/expiry. Missing credentials or an unavailable owner signer never
silently selects managed custody. Humans and agents follow identical rules.

Grant expansion still needs verified evidence and consent. Restrictions and
terminal signed revocation remain unilateral; no unsigned blocking is introduced.
Binding renewal requires deliberate authority and preserves the 90-day maximum.
Credential rotation never changes identity custody or recovery authority.

Fresh owner authentication after account-access expiry requires independent owner
proof, using owner recovery for managed accounts. A provider identity signature
cannot authorize issuing owner credentials, changing custody, replacing recovery
or moving the DID. Local access recovery is not PLC identity recovery. Challenges
are one-time, provider/account/purpose/scope bound; terminal credentials stay
terminal and old generations never regain authority.

## Custody changes and managed migration

These are separately versioned owner-approved transitions, not ordinary onboarding
or a switch on the current portable manifest. Use the
[reference transition design](https://github.com/j4crev/hail-user-client-ts/blob/main/docs/custody-transitions.md)
for implementation sequence and proof requirements. A final transition must:

- Obtain independent top-owner authorization for complete PLC state and the exact
  custody/data transition, after snapshot/history and destination evidence exist.
- Replace outgoing provider identity, messaging and rotation authority with fresh
  intended-party keys; downloading an old managed key does not establish ownership.
- Preserve unrelated PLC state, original signed history, consent, publication
  receipts, accepted message/reply/body/status obligations and serving generations.
- Prove historical authority and reconcile active Grant predecessors without
  re-signing old revisions, reviving tombstones or inventing fresh IDs as repair.
- Keep the source fenced until verified activation/retirement or coordinated
  protective recovery. Expiry alone never releases an exported fence/reservation.
- Establish fresh provider-local credentials through explicit owner login; export
  no bearer credentials or provider/client private keys to the destination.

The current stable-owner portable transfer proof is not a managed migration
proof. The reference provider implements both same-provider custody directions
for acknowledged authoritative Grant predecessors, with fresh intended-party
identity, exact owner approvals and atomic custody/generation cutover. An owner
return never exports the provider key or promotes the unused managed-vault key.
Unacknowledged/nullified history and cross-provider managed execution remain
disabled pending equivalent proof.

## Conformance cases and acceptance evidence

An implementation claiming this candidate profile must satisfy every applicable
case, including operational evidence. Passing a structural validator or negative
guards alone does not establish production or physical custody conformance.

| ID | Positive case | Required refusal / evidence |
| --- | --- | --- |
| MC-01 | Explicit managed identity and owner recovery declaration | Reject actor-inferred custody, fallback, mixed active evidence and portable relabeling |
| MC-02 | Owner recovery first; independent provider rotation and distinct Ed25519 Hail roles | Reject reused/malformed/wrong-role keys, unexpected genesis state, wrong recovery order and local unused identity |
| MC-03 | Exact top-owner-signed genesis and DID/CID | Reject provider-only signature, wrong derived DID, changed artifacts and bound-vault genesis replacement |
| MC-04 | Ambiguous write reconciles identical operation | Restart/lost response preserves keys, bytes and DID; changed retained preparation/operation fails before another submission |
| MC-05 | Public canonical registration with retained non-disposable owner material | Reject private registry as public proof and confirmed occupied DID; retain collision evidence |
| MC-06 | Independently verified recovery backup | Restore on an independent installation/device; provider has neither private recovery nor backup secret |
| MC-07 | Independent monitor and validated read paths | Prove expected-CID bootstrap, alerts, missed/restarted events, outage/disagreement refusal and recovery-window response |
| MC-08 | Binding/provider key possession and end-to-end activation | Reject unverified publication, mismatched keys/service, stale reservation and fake public/independent labels |
| MC-09 | Authorized account-bound managed operations | Cross-account/scope/generation/fence failures; untrusted message data is never authority |
| MC-10 | Independent owner account-access recovery | Reject provider identity substitution, stale/consumed challenge and terminal credential revival |
| MC-11 | Same-provider custody changes with fresh intended-party identity | Prove owner authorization, atomic evidence/generation change, exact PLC/binding retries and preserved history |
| MC-12 | Managed A → B and return with fresh B/A keys | Prove removal of outgoing identity/messaging/rotation authority, history and accepted-work continuity under races/restarts |
| MC-13 | Historical object audit and coordinated recovery | Prove nullified-branch classification, receipt reconciliation, never-active protective resumption and latest-state reverse transfer |
| MC-14 | Independent infrastructure and restoration/load evidence | Prove cross-host ownership/accepted-state preservation, calibrated limits, recovery deadlines and backup restoration |

Before production acceptance, resolve the four shared policies in
[DID profile — Before Production](did-profile.md#before-production): current
authority/cache during recovery, independent mirrors/checkpoints/outages,
historical evidence, and pending-window migration ownership/recovery. This draft
does not settle those policies or label local POC evidence as independent proof.

The next [read-evidence policy candidate](plc-read-evidence.md) and reference
monitor migration 3 now cover full audit agreement, explicit reader/operator
selection, reviewed bootstrap, contiguous catch-up and fresh v2 attestation for
public cutover. These are local implementation parts of MC-07/MC-13; independent
deployment and full production/historical evidence remain separate acceptance.
