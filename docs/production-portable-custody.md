# Production Portable Custody And Provider Cutover

Status: Design and implementation work in progress. This document records the
production-facing decisions and the prerequisites that the isolated custodial
POC cannot satisfy. The protocol specifications in `../spec` remain
authoritative; a rule proposed here is not a federation requirement until its
corresponding specification is updated and reviewed.

## Authority And Key Custody

The user-controlled client generates and retains the top PLC recovery key and
the `#hail-identity` signing key. The provider never receives their private
bytes, even encrypted under a provider-controlled key. The user's independent
encrypted backup and recovery-material check must succeed before public
activation. The source and destination providers each generate their **own**
lower-priority PLC rotation and `#hail-messaging` keys; neither provider
receives the other's private operational keys. The source's operational keys
are historical evidence, not usable destination signing keys.

An out-of-provider PLC monitor maintains a durable cursor, validates the full
log and aliases, detects an unexpected operation or coverage loss within 24
hours, and alerts the user out of band. A database field claiming that the
monitor or backup was confirmed is not independent proof: production
activation needs authenticated monitor evidence and a verified user recovery
check. The client-to-provider API and encrypted vault representation remain
local implementation details, but these outcomes are mandatory under
`spec/account-onboarding.md`.

The initial TypeScript desktop/Bun client is a **reference implementation and
test driver**, not a platform requirement. Mobile and other clients may use
their own OS-backed keys and recovery user experience so long as they produce
the same exact signed PLC operation, migration consent, Grants and Address
Bindings and satisfy the provider-independent backup/recovery outcomes.

## Portable Transfer Ceremony

1. The destination generates and durably encrypts its own provider PLC
   rotation and messaging keys under its own encryption key. It gives the
   public `did:key` values, transfer ID, and final HTTPS Hail service base to
   the user-controlled client and source. The target proves possession of
   both private operational keys before staging; its import slot cannot serve
   the DID yet.
2. The source checks the validated current PLC log: the user recovery key is
   first in the ordered rotation keys, the provider key has lower priority,
   the identity key is the user's public key, and the source service and
   messaging key are current. It commits an exclusive DID fence. Every local
   writer shares the account-row serialization point, including Grants,
   replay, reply claims, deliveries, and status publication. Workers skip
   fenced work rather than taking new leases.
3. The source exports a complete, immutable snapshot of the DID's state. It
   signs a domain-separated digest using its **current provider messaging
   key**, recording validated PLC evidence. The export contains public key
   metadata and the exact signed protocol records, body bytes and
   authorizations needed for continuation. It contains **no private user or
   provider key bytes or provider KEK-wrapped ciphertext**. Transfer occurs
   over an authenticated, private administrative channel.
4. The user-controlled client validates the snapshot digest and destination
   keys/service, then signs domain-separated migration consent with its
   `#hail-identity` key. That consent binds the DID, transfer ID, exact
   snapshot digest, source and destination service bases, user recovery and
   identity public keys, both destination provider public keys, and SHA-256
   of the **exact reviewed signed PLC operation's DAG-CBOR bytes**. The
   consent also binds a user-controlled **destination Hail address**. The
   client signs a fresh Address Binding for that address using its identity
   key, and the address-domain operator publishes the exact binding and
   WebFinger selection independently of the departing provider. The provider
   receives only payload and signature bytes, never a user private key.
   Independently, the user reviews and signs the **exact full-state PLC
   update** with the top recovery key. This unusual use of the offline key is
   a deliberate, high-stakes provider-transfer ceremony, not routine Grant
   signing. The full update preserves all unrelated keys, services, and
   non-Hail aliases in their original order; it changes only the reviewed
   Hail service, messaging key, and provider rotation key.
5. The destination verifies the source's PLC-authorized operational signature,
   the user's current identity signature, the exact manifest digest, complete
   references and signed bytes, and the reviewed PLC operation. It requires
   the operation's predecessor to equal the current valid CID, verifies its
   signature against the user-held top recovery key, and rejects unapproved
   alias, key, or service changes. It durably
   stages the state **inactive** and acknowledges the exact transfer ID and
   digest over the authenticated administrative channel. It also verifies
   the exact user-signed destination Address Binding, but does not infer
   control of a domain solely from a signed DID assertion. The old provider
   remains fenced; it never receives the destination private messaging key.
6. Submit the exact signed PLC update to the canonical public write registry
   and reconcile an ambiguous result by CID and operation bytes. Do not activate
   the destination just because the directory immediately renders a new
   service. Validate the chain and nullification state through independent
   read paths and apply the finality policy below. Only then materialize the
   imported state in a single transaction, normalize stale leases, re-check
   body/deadline and status responsibilities, publish a current Sender Profile
   signed by the destination messaging key, verify the user-controlled
   address's external WebFinger/Binding selection, and make the destination
   active. It signs an activation receipt under its current messaging key;
   only after verifying that receipt and current PLC state may the old provider
   mark its permanent fence `retired`. It never resumes signing or accepting
   envelopes for the DID.

## Conservative Recovery-Window Policy To Validate

The published PLC operation is recoverable for 72 hours. A conservative Hail
policy is to quarantine *new* signing and envelope acceptance at both
providers until at least 72 hours after the destination first records matching,
fully validated observations from two independently operated PLC read paths.
Before takeover it rechecks both paths, the canonical audit/nullification
record and uninterrupted independent-monitor coverage. A later observation,
new fork, invalid signature, mirror disagreement, missing monitor evidence or
unavailable read path fails closed rather than falling back to a stale key.
Directory timestamps alone do not prove the passage of time; the local
observation time and monitor attestation are explicitly trusted inputs.

During the quarantine, accepted envelopes remain durable obligations. Delivery
deadline and body-availability commitments still apply; a message that can no
longer be completed must eventually fail under the existing signed-status
rules. A generic HTTP receipt cannot pretend it was delivered. If the PLC
update is nullified, abort the inactive import. The source may resume only
after validating the restored PLC state and receiving authenticated evidence
that the destination import has been invalidated; otherwise it stays fenced.

This policy trades up to 72 hours of DID-specific availability for a
non-overlapping ownership claim. It must be reviewed against the recovery
window, caching, body deadlines and mirror governance requirements in
`spec/did-profile.md#before-production` before it becomes normative.

## Current Implementation Boundary

Migrations 13–21 are **local, unapplied production work**. They fence source
writes and leased work, retain a signed immutable snapshot and permit an
authenticated, user-consented **inactive** target import. Portable snapshots
strip provider operational ciphertext and require a user-controlled identity
signature, a fresh user-signed destination Address Binding, and a separate
top-recovery-key-signed exact PLC cutover operation;
accounts that still have a provider-held `#hail-identity` key fail the
portable-custody precondition. The destination stores the exact signed
operation bytes without submitting them or activating the account. A cutover
assessment requires two agreeing validated PLC read paths, an independent
signed monitor attestation, and 72 hours from first agreeing observation.
The isolated integration test injects those observations and an externally
verified address, then transactionally materializes the imported state and
returns a signed receipt that permanently retires the source. It verifies
rollback on a target conflict, re-signing under the new messaging key, and
deadline failure for accepted work that expired during quarantine. There is
**no public activation or PLC submission CLI** and no real independent
monitor/mirror provisioning yet; this test is not a production-ready migrated
account.
The previously deployed POC DIDs are registered only in a private PLC
directory and were created custodially. They cannot be treated as production
portable identities by applying the new migration to their existing rows.

The separate sibling [PLC monitor](https://github.com/j4crev/hail-plc-monitor-ts)
checkout is the first
user-run-monitor prototype. It persists the PLC export cursor, validates full
operation logs and complete resulting state, records unexpected operations or
coverage gaps, signs out-of-band HTTPS webhook alerts, and can sign the
provider-compatible monitor coverage attestation only after a reviewed CID is
approved and its alert acknowledged. It still needs a verified public export
bootstrap checkpoint, chosen independent mirror operators, independently
hosted deployment, and second-device recovery testing. A copy run by Hail on
its own infrastructure is useful for bootstrapping but **does not satisfy**
the provider-independent monitor requirement.

Before a production-ready rollout, implement and test:

- a user-controlled vault/signing client, provider-independent recovery
  verification, and independent monitor with authenticated coverage evidence;
- new-DID and existing-DID onboarding using the user-signed exact PLC operation,
  plus user-signed Grants and Address Bindings with no provider identity key;
- exact submission and ambiguous-result reconciliation for the
  user-authorized PLC cutover operation at the canonical public registry;
  independently validated production mirror/checkpoint evidence;
- two independently operated read paths, finality observation and outage
  handling, historical accepted-object PLC evidence, and a fenced,
  transactional materialization/rollback test with competing workers;
- address-domain control at the destination: provider-issued addresses on an
  old provider's domain do not automatically move with the DID. The user must
  retain that domain's cooperation or publish a new signed Address Binding
  under a domain it controls.

The [desktop/Bun reference client](https://github.com/j4crev/hail-user-client-ts)
(`a271519`) generates and encrypts the user-held keys and signs exact PLC and
Hail objects; it does not yet prove second-device recovery, independently
managed backup or a reviewed onboarding UX. These remain requirements for
production portable custody, not requirements that every future mobile client
use the reference vault-file representation.

The public POC's private-directory DIDs, custodial identity keys and shared
host cannot by themselves demonstrate these production guarantees. Keep the
production mode fail-closed until its prerequisites and recovery policy are
specified, reviewed and verified end to end.

## Decisions Still Required Before Calling This Production-Ready

1. **Recovery-window policy.** Adopt, amend, or reject the proposed 72-hour
   no-acceptance quarantine in the authoritative DID/delivery specifications.
   Define the exact independent witness set, trusted elapsed-time source,
   recovery/fork response, and how accepted work expiring during quarantine
   obtains a signed terminal result.
2. **User-controlled client and recovery.** Build the reference desktop/Bun
   client and verify its backup recovery on a second device. The
   provider-local signature verifier is implemented; a user-owned signing and
   recovery product is not. The current Grant and onboarding authoring CLIs
   still rely on provider-held identity/recovery keys, so they must be
   replaced or supplemented before a portable account can use all operations.
3. **Monitor independence and mirrors.** The user chose a separate user-run
   host for independent monitoring. Select actual independent mirror
   operators, authenticate their read/attestation endpoints, handle
   disagreements and missed coverage, and retain CIDs, chain snapshots and
   nullification evidence for historical signed-object audits. Distinct URLs
   in a test fixture do not establish different administrative control.
4. **Account and address activation.** Wire the tested materialization to a
   real user-controlled address authority and verified public WebFinger and
   Address Binding resources. The user chose a user-controlled domain for
   portable activation. A provider-issued address on the departing provider's
   domain cannot move without its domain operator's cooperation. Verify the
   imported status/outbox and body responsibilities across actual provider
   processes and independent infrastructure, not only two test databases.
5. **Public PLC identity provenance.** The live demonstration DIDs exist only
   in a private PLC registry and were created with custodial top keys. They
   do not become public, portable identities through a database migration.
   Test production onboarding with a new user-generated DID on
   `https://plc.directory` using only non-disposable keys and an independently
   verifiable audit trail.
