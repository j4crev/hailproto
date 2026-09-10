# Hail Account Onboarding

Status: Draft

This document defines the protocol-visible outcomes a Hail provider must establish before activating an account. It covers new `did:plc` creation, onboarding an existing `did:plc`, key custody, public PLC registration, address publication, and partial-failure handling.

Hail does not standardize the client-to-provider account API in v0. Providers may use any local authentication, enrollment, billing, and user-interface mechanisms that produce the state required here.

## Goals

- Give every account a durable `did:plc` identity before federation begins.
- Register publicly federated DIDs in one unambiguous PLC operation log.
- Make user-controlled identity and recovery authority portable between providers.
- Permit providers to operate routine messaging without holding the user's identity key.
- Support both newly created and existing `did:plc` identities.
- Publish a Hail address only after its DID, keys, service, and Address Binding verify end to end.
- Define safe retry behavior after partial onboarding failures.

## Non-Goals

- Standardizing account passwords, passkeys, sessions, billing, or client APIs.
- Defining the encrypted client-vault wire format or user-interface recovery ceremony.
- Making a Hail address part of PLC state.
- Defining provider migration after an account is active.
- Automatically repairing partial or unrecognized Hail state already present in an existing DID.
- Defining PLC recovery-window finality for routine federation operations.

Provider migration is defined by the DID, delivery-state, and address-binding profiles. Production finality and historical PLC evidence remain subject to the requirements in [did-profile.md](did-profile.md).

## Terminology

- **Local account**: Provider-private account state used to authenticate a user and administer service. It is not a Hail protocol identity.
- **Public Hail identity**: A registered `did:plc` satisfying the Hail DID profile.
- **Portable custody profile**: The production onboarding profile in which the user controls the top PLC recovery key and `#hail-identity`, while the provider controls a lower-priority PLC rotation key and `#hail-messaging`.
- **Write registry**: The PLC directory to which creation and update operations are submitted.
- **PLC monitor**: A service or user-controlled client that observes the PLC log and alerts the user to unexpected operations.
- **Activation**: The point at which the provider permits the account to participate in Hail federation under its published address and DID.

## Registration Is Three Separate Actions

Implementers must not treat local account creation, DID registration, and address publication as one implicit database operation:

```text
local account
  -> signed PLC operation registered in the public PLC log
  -> signed Address Binding selected by the address domain
  -> active Hail account
```

A local account can exist without a public Hail identity. A registered DID can exist without a Hail address. Neither state is sufficient for federation until address-to-DID and DID-to-service resolution both succeed.

## Public PLC Write Registry

The Hail v0 public-federation write registry is:

```text
https://plc.directory
```

A creation, update, recovery, or tombstone operation for a publicly federated Hail DID is submitted to that registry. In particular, a signed creation or update operation is submitted as JSON using:

```http
POST https://plc.directory/{did}
Content-Type: application/json
```

The request needs no account credential; the PLC operation signature supplies authorization. Implementations must use normal HTTPS certificate and hostname validation and must not send provider or user credentials to the registry.

PLC identifiers contain no registry or network component. Allowing independent public write registries would permit conflicting histories for the same identifier with no way for a protocol object to identify the intended history. A different public write registry therefore requires a future versioned Hail network profile, not local configuration.

Resolution remains behind the configurable resolver boundary in [did-profile.md](did-profile.md). Production implementations should validate the canonical operation log through independently operated mirrors or a local replica rather than depending on one rendered-document endpoint. This read flexibility does not change the canonical write registry.

An isolated development or test network may use a configured local PLC directory. DIDs registered only there are not public-federation Hail identities and must not be presented as resolving through the public Hail v0 network. Implementers should use local directories for test identities rather than adding disposable operations to the permanent public PLC log.

## Production Portable Custody Profile

A production-conforming provider must support the portable custody profile.

The initial authority order is:

```text
user PLC recovery key       highest-priority PLC rotation key
provider PLC rotation key   lower-priority PLC rotation key
user #hail-identity         grants and Address Bindings
provider #hail-messaging    routine server operations
```

The two Hail keys are Ed25519 keys under [did-profile.md](did-profile.md). PLC rotation keys use a PLC-supported P-256 or secp256k1 key type. Every private key is generated independently for one DID and one role; a key must not be reused across users, DIDs, or roles.

The user-controlled client generates the top PLC recovery key and `#hail-identity`. Their plaintext private-key material must not be disclosed to the provider. The provider generates and protects its lower-priority PLC rotation key and `#hail-messaging`. The provider must not claim that its key separation prevents identity impersonation if it also obtains either user private key.

The provider's PLC key remains powerful: an accepted operation that removes higher-priority keys becomes current immediately. A previously authorized higher-priority key can nullify that operation only during PLC's 72-hour recovery window. The provider can therefore impersonate the DID during the interval before detection and recovery even though the operation is later nullified. The provider must disclose this authority during onboarding. Portable custody depends on both user key control and the independent monitoring required below.

### User Key Storage And Recovery

Before activation, the client must establish a recoverable, provider-independent copy of the user-controlled keys. The storage design must satisfy these outcomes:

- Private keys are generated in a user-controlled client.
- Private keys are encrypted at rest using authenticated encryption.
- The provider cannot derive the decryption key for a provider-hosted encrypted backup.
- A user-chosen password is not the sole protection for ciphertext available to the provider or an attacker of the provider.
- Recovery uses a uniformly generated secret with at least 128 bits of entropy, or a security-equivalent hardware or delegated recovery mechanism outside the provider's control.
- The user completes a recovery-material verification step before activation.
- The user can export the encrypted backup and retain it independently of the provider.
- Clearing one client installation or losing one device does not silently destroy the only user-controlled copy.

The PLC recovery key is offline recovery authority and must not be loaded for routine grant signing. The `#hail-identity` key is the day-to-day user key and may be held in an encrypted client vault unlocked through an operating-system keystore. A passkey may authenticate the user or unlock vault material, but implementations must not assume a WebAuthn credential can directly produce the arbitrary raw signatures required by PLC or Hail.

New devices obtain the user keys through authenticated device-to-device transfer or recovery import. The exact vault representation, wrapping algorithms, mnemonic format, and transfer API are local implementation concerns, provided the outcomes above hold.

### Independent PLC Monitoring

Before activation, the user must have at least one continuously operating PLC monitor outside the Hail provider's administrative control. It may be a user-operated client or an independently operated monitoring service.

The monitor must detect a new operation for the DID within 24 hours of its acceptance into the canonical PLC log. It maintains a durable cursor or otherwise detects missed events after restart, validates the operation and preceding chain, compares the complete resulting PLC state, including `alsoKnownAs`, against expected state, and sends an out-of-band alert for every unexpected change. It also reports loss of monitoring coverage before 24 hours can elapse without observation. Monitoring only through infrastructure controlled by the Hail provider is insufficient for the portable profile.

The onboarding flow must test the monitor's alert and health-reporting paths. Detection does not itself recover the DID. To recover, the user or an authorized recovery agent validates the complete audit log, identifies the last valid operation before the unwanted lower-priority fork, and uses that validated pre-fork state as the baseline for the intended full state with its CID as `prev`. Every non-Hail `alsoKnownAs` value from the pre-fork state is preserved in order unless the DID controller explicitly authorizes an alias change in the exact recovery operation; alias changes introduced only by the unwanted fork are not preserved. The user or recovery agent signs using a higher-priority key authorized by the fork-point state. The recovery operation must reach the canonical write registry within 72 hours of the first operation it nullifies. The implementation verifies the resulting nullification and current state before treating recovery as complete.

The monitor retains the expected current operation CID and complete expected PLC state needed to diagnose a fork. Implementations must communicate the recovery deadline and must not describe an unmonitored higher-priority key as effective provider-compromise protection.

## New DID Registration

The provider performs the following sequence for a user who does not bring an existing DID.

### 1. Reserve Local Resources

The provider creates a non-active local account, allocates an opaque tenant identifier, and reserves the requested provider-issued Hail address if applicable. Reservation does not publish WebFinger and conveys no federation authority.

The provider prepares its tenant endpoint before constructing PLC state. The public `#hail` service path uses the opaque tenant identifier rather than the Hail address or other personal information.

### 2. Generate Keys And Recovery Material

The client and provider generate their respective keys under the portable custody profile. The client completes backup verification and configures the independent PLC monitor before the account can become active.

### 3. Construct The Genesis Operation

The proposed operation uses the regular PLC `plc_operation` format, never the deprecated legacy `create` format. It contains:

- `type` equal to `plc_operation`.
- `prev` present with the value `null`.
- The user recovery key first in `rotationKeys`.
- The provider rotation key after every user-controlled recovery key.
- `hail-identity` and `hail-messaging` verification methods encoded as `did:key` values.
- One `hail` service of type `HailMessaging` with the prepared HTTPS endpoint.
- `alsoKnownAs` present as an empty array. The PLC operation schema requires the field even when it has no entries.
- No Hail address, account email address, display name, tenant name, or other unnecessary personal information.

The complete operation must satisfy the PLC size, key-count, encoding, and state rules incorporated by [did-profile.md](did-profile.md).

### 4. Obtain User Authorization

The client displays or otherwise makes available the proposed rotation-key order, Hail verification keys, service endpoint, and permanent-publication warning. It must validate that its exact recovery and identity public keys are present, that the provider key has lower priority, and that no unexpected state is included.

The client signs the genesis operation with the top-priority user recovery key according to the PLC operation profile. Signing authorizes the exact full state; a signature over a challenge, account identifier, or partial state is not sufficient.

### 5. Derive And Submit The DID

The DID is derived from the exact signed genesis operation according to the PLC method specification. Before submission, both client and provider recompute the DID from the signed DAG-CBOR bytes and require an exact match.

The provider retains the exact signed operation and queries the derived DID before submission. If the DID is absent, it submits the operation's JSON representation to the public PLC write registry. If the DID already resolves to the same exact genesis operation, the provider reconciles it as an earlier successful submission. It must not generate a replacement genesis operation merely because submission times out or returns an ambiguous result; it queries the derived DID and retries the same operation only when appropriate.

If the preflight query, submission response, or later reconciliation shows that the derived DID exists with a different genesis operation, registration terminates as a hash-prefix collision. The provider must not submit or retry against the occupied DID. This confirmed collision is the sole exception permitting replacement of a genesis operation after a submission attempt: after explicit user confirmation, the parties generate and authorize a distinct genesis operation, derive its DID, and restart registration while retaining evidence of the collision.

### 6. Verify Registration

An HTTP success response alone does not activate the identity. The provider, and the client when capable, retrieves the DID state and audit log and verifies:

1. The returned DID equals the locally derived DID.
2. The genesis operation is byte-equivalent under the required PLC DAG-CBOR encoding to the submitted signed operation.
3. The genesis-derived identifier, operation CID, and signature are valid.
4. The current full state contains the expected rotation-key order, Hail keys, and service.
5. The DID is active and not tombstoned.

The provider should confirm through an independently operated read path when one is available. Registry timestamps and sequence numbers may be retained as directory annotations but are not cryptographic proof of creation time.

## Existing DID Onboarding

A user may bring an existing `did:plc` identity. The provider must not require creating a replacement DID merely because it did not create the existing one.

Before proposing an update, the provider and user-controlled client validate the existing operation log and current state. Onboarding fails if the DID is absent, tombstoned, does not have a user-controlled key at rotation-key index zero, or cannot accommodate the required Hail state within PLC limits.

The update is a complete PLC state snapshot. It must:

- Preserve every unrelated rotation key, verification method, and service not explicitly changed with the user's approval.
- Preserve every existing non-Hail `alsoKnownAs` value in its existing order unless the user explicitly authorizes its removal, replacement, or reordering in this exact update.
- Retain a user-controlled key at rotation-key index zero and place the provider rotation key below every user-controlled recovery key.
- Add or replace the exact `hail-identity`, `hail-messaging`, and `hail` entries required by the Hail DID profile.
- Use the current valid operation CID as `prev`.
- Avoid adding the Hail address to `alsoKnownAs`.

The update includes the required `alsoKnownAs` field even when the preserved result is an empty array. Removing any unrelated state requires explicit user approval; omission must not occur as an implementation side effect. If the rotation-key or verification-method limits leave no acceptable capacity, onboarding stops until the user intentionally changes existing state.

The current user-controlled index-zero rotation key signs the exact full update. The provider never requests or imports that private key. If another party controls the current index-zero key, that party must first authorize a separate transfer to user control; ordinary Hail onboarding cannot safely promote a lower-priority user key because the former higher-priority key could nullify that change during the recovery window.

The update is submitted to the public PLC write registry. Read-back verification requires the exact submitted operation CID and signature to appear in the valid audit chain and requires the current full state to equal the user-approved state.

If state changes after preparation, the provider first classifies every intervening operation. When all intervening operations are recognized and user-approved, the client may review and sign a newly constructed full-state operation using the new current predecessor. An unexpected lower-priority operation requires the recovery-fork procedure above, using the last valid pre-fork CID rather than making the unwanted operation an ancestor. If the user no longer has a key authorized either by current state or with sufficient priority at the required fork point, onboarding fails closed.

If the existing DID already contains any `hail-identity`, `hail-messaging`, or `hail` entry, the operation is not ordinary onboarding. When the entries came from an incomplete attempt by the same provider, the provider resumes that attempt from its retained operation evidence and durable onboarding state. An identity with another Hail provider follows the fenced state-transfer procedure in [delivery-state.md](delivery-state.md), including its reduced-guarantee emergency path when state is unavailable.

Partial, stale, or unrecognized Hail entries for which the provider has no matching retained lifecycle evidence require an explicit identity-recovery procedure. That procedure is not defined in v0; the provider fails closed and must not overwrite the entries or activate the account. This restriction prevents apparent onboarding from silently discarding grants, replay state, delivery state, or other continuity-bearing data.

## Address Publication And Activation

PLC registration precedes public address publication. Once the expected Hail DID state resolves:

1. The client creates an Address Binding naming the canonical reserved address and registered DID.
2. The user-controlled `#hail-identity` signs the binding.
3. The provider or custom-domain operator validates the complete binding and hosts its immutable COSE representation.
4. The representation is made retrievable at its final HTTPS URL before WebFinger references it.
5. The address authority publishes or replaces the WebFinger response selecting that representation.
6. The provider performs the complete verification algorithm in [address-binding.md](address-binding.md) as an external client would.
7. The provider separately resolves the DID and confirms its own exact `#hail` endpoint and `#hail-messaging` key.
8. Only then does the provider mark the account active for Hail federation.

For a provider-issued address, the provider controls reservation, binding hosting, and WebFinger publication. For a custom-domain address, the user or domain operator performs or delegates the publication steps. Hosting the Hail service does not authorize the provider to publish under a domain it does not control.

A sender additionally publishes a valid Sender Profile before presenting itself for sender discovery. A receiver-only account need not publish a Sender Profile, but it still requires both Hail keys and the Hail service because grants and routine receiving operations use separate roles.

## Onboarding State And Failure Handling

Providers should persist at least these logical states or equivalent durable state:

```text
reserved        local account and optional address reservation exist
prepared        keys, recovery, monitor, tenant, and proposed PLC state exist
submission-unknown
                a PLC request may have succeeded and must be reconciled
did-registered  exact expected PLC state has been registered and verified
address-staged  signed binding is retrievable but is not yet verified as selected
active          address, DID, keys, and service verify end to end
```

Every transition is monotonic except explicit cancellation before any PLC submission attempt. Restarting a process must resume from retained evidence rather than generate new keys or a new genesis operation.

Failure rules:

- Before any PLC submission attempt, an expired reservation may be released after deleting provider-private provisional state according to local policy.
- A timeout, connection loss, or ambiguous registry response enters `submission-unknown`; it does not return to `prepared`.
- In `submission-unknown`, the provider retains the exact signed operation, public-key and custody metadata, and its own private keys, never the user private keys. It resolves the already-derived DID or inspects the existing DID's audit log and reconciles the expected operation CID before retrying.
- A new-DID retry uses the same exact signed genesis operation unless a different occupying genesis confirms a hash-prefix collision. An existing-DID retry is allowed only while its `prev` remains current. If it is stale, the provider classifies intervening operations and follows either the approved-update or recovery-fork procedure above; it never makes an unexpected operation an ancestor merely to advance onboarding.
- Cancellation after a submission attempt does not delete the operation evidence. The address reservation may eventually be released if no binding was published, but the provider retains enough state to identify a later-observed registration and must not represent the attempt as never submitted.
- After a new DID reaches `did-registered`, its genesis operation is permanently public and cannot be rolled back or erased.
- A registered but inactive DID is not repaired by creating another DID without explicit user approval and a new recovery ceremony.
- WebFinger must not select the binding before the binding resource and expected DID state are retrievable.
- If end-to-end activation fails after WebFinger publication, the account remains inactive and the address authority removes the selection or repairs it before retrying verification. Before assigning the address to another account, it waits until the earlier of 300 seconds after the prior binding's `expires_at` and 3600 seconds after WebFinger withdrawal, so no conforming cached discovery result can verify the prior binding.
- A PLC tombstone is an explicit account-closure operation whose exact bytes are reviewed and signed by the user-controlled index-zero recovery key. It is never automatic cleanup for failed onboarding.

Providers define reservation duration and local-account deletion policy, but must prevent an expired or reassigned reservation from activating a binding created for its prior holder.

## Retained Registration Evidence

From the first PLC submission attempt, including while its outcome is unknown and after local cancellation, the provider retains:

- The exact signed genesis operation or existing-DID onboarding update.
- The exact DAG-CBOR bytes used to derive its operation CID and, for genesis, its DID.
- The DID, operation CID, predecessor CID when applicable, and submitting registry origin.
- The verified resulting PLC state and the operation-log evidence used for read-back verification.
- The expected public keys and their custody classification, never user private keys.
- Evidence that recovery material and the independent monitor were confirmed, without retaining the recovery secret.
- The exact active Address Binding representation and its publication metadata.
- The account activation time and successful end-to-end verification result.

Activation-specific fields are retained when activation occurs. This evidence supports retry, migration, recovery, and audit. It does not replace the historical-evidence requirements still to be finalized in [did-profile.md](did-profile.md).

## Custodial POC Profile

An isolated proof of concept may let the provider generate and hold all private keys. It may also register DIDs in a configured local PLC directory. Such an account is explicitly custodial and does not conform to the production portable custody profile.

A custodial implementation must label that limitation in its user-facing and implementation documentation. It must not claim that key-role separation prevents provider impersonation, that the identity survives a hostile provider, or that a DID registered only in its local directory participates in public Hail federation.

The POC should still implement the same registration state machine, regular `plc_operation` creation, exact-operation retry behavior, read-back verification, staged Address Binding publication, and end-to-end activation check. Doing so tests the protocol lifecycle without treating prototype custody as the production design.

## Security And Privacy Considerations

### Provider Takeover Window

The provider rotation key can attempt to remove user keys. Independent detection within 24 hours leaves time for the user to recover before PLC's 72-hour window closes, but notification latency and user availability remain material risks. Providers and clients must not describe this as threshold control or as an update requiring both parties.

### Recovery Secret Loss

If the user loses every usable device, independent backup, and recovery secret, portable recovery may be impossible. A provider-controlled reset that replaces the user's keys is an exercise of the provider rotation key and remains recoverable by an older higher-priority key during the PLC recovery window.

### Permanent Public State

Genesis and later PLC operations are permanently public, including nullified operations and tombstones. Service endpoints and public keys reveal provider and migration history. Hail addresses and local account metadata remain outside PLC state, and service paths use opaque identifiers to reduce correlation. Outside PLC state does not mean confidential: an active Address Binding and its current address-to-DID mapping are publicly retrievable through WebFinger. The privacy benefit is avoiding mandatory permanent PLC history and PLC-based reverse correlation.

### Address Squatting And Reassignment

Address allocation is a provider policy, but activation always requires a binding signed by the registered DID's identity key. Providers must prevent stale reservations, bindings, or local account records from authorizing a later holder of the same address. DID-bound grants and history never transfer with an address.

### Existing-State Destruction

PLC updates replace the complete current state. Existing-DID onboarding tools must show all removals before signing and fail closed when they cannot preserve or correctly interpret an existing entry.

### Registry Dependency

Public Hail v0 registration depends on the availability and governance of `plc.directory`. The self-authenticating operation log limits undetectable mutation but does not prevent censorship, outage, or recovery-window fork selection. A future change of write registry requires an explicit network-profile transition.
