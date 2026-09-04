# Hail DID Profile

Status: Draft

This document defines the verification methods and service entry a DID uses to participate in Hail Protocol.

The profile answers two questions:

- Which keys may authorize Hail operations for this DID?
- Where is this DID's current Hail server?

The v1 DID method is:

```text
did:plc
```

Every DID and DID URL in a Hail v1 protocol object uses `did:plc`. PLC resolution and validation remain behind a resolver interface so implementations can use a local validator, mirror, or configured directory without changing protocol objects.

## Identifier Syntax

A Hail DID is exactly 32 lowercase ASCII characters and matches:

```text
did:plc:[a-z2-7]{24}
```

Case folding is not performed. A producer emits, and a consumer requires, this canonical form. A `key_id` or JWS `kid` is the canonical DID followed by the exact fragment required for its role.

## Required Entries

A Hail-capable DID document contains:

- one `#hail-identity` verification method
- one `#hail-messaging` verification method
- exactly one `#hail` service with type `HailMessaging`

Conceptual normalized DID document after relative-ID expansion:

```json
{
  "id": "did:plc:aaaaaaaaaaaaaaaaaaaaaaaa",
  "verificationMethod": [
    {
      "id": "did:plc:aaaaaaaaaaaaaaaaaaaaaaaa#hail-identity",
      "type": "Multikey",
      "controller": "did:plc:aaaaaaaaaaaaaaaaaaaaaaaa",
      "publicKeyMultibase": "z..."
    },
    {
      "id": "did:plc:aaaaaaaaaaaaaaaaaaaaaaaa#hail-messaging",
      "type": "Multikey",
      "controller": "did:plc:aaaaaaaaaaaaaaaaaaaaaaaa",
      "publicKeyMultibase": "z..."
    }
  ],
  "service": [
    {
      "id": "did:plc:aaaaaaaaaaaaaaaaaaaaaaaa#hail",
      "type": "HailMessaging",
      "serviceEndpoint": "https://provider.example/hail"
    }
  ]
}
```

## V1 Key Algorithm And Encoding

Hail v1 uses Ed25519 as the only permitted signing algorithm for both Hail verification-method roles. The roles must still use distinct public keys. V1 performs no signature-algorithm negotiation or fallback.

An Ed25519 Hail verification method uses the W3C Multikey representation:

```json
{
  "type": "Multikey",
  "publicKeyMultibase": "z..."
}
```

`publicKeyMultibase` is the base58btc multibase encoding of the `ed25519-pub` multicodec prefix followed by exactly 32 public-key bytes. The multicodec value is `0xed`, whose unsigned-varint byte representation is `0xed 0x01`.

The PLC operation stores each Hail key as an Ed25519 `did:key` value. Its multibase identifier encodes the same `ed25519-pub` multicodec prefix and public-key bytes; DID resolution renders the corresponding Hail Multikey verification method.

Every Hail v1 JWS uses the fully specified RFC 9864 `Ed25519` algorithm identifier. The deprecated polymorphic `EdDSA` identifier is not accepted. Signature wrappers remain object-specific even though they use the same key algorithm. Supporting another algorithm requires a future versioned Hail security profile that defines its key representation, object applicability, negotiation, downgrade prevention, and migration behavior; adding an arbitrary optional algorithm to v1 is prohibited.

## Hail Identity Key

The verification method with fragment `#hail-identity` authorizes identity-level consent statements.

It signs:

- Hail Grants
- Hail Address Bindings
- future Hail identity-level authorization objects

It does not sign routine Hail Envelopes or delivery receipts.

The identity key represents the DID controller's consent. It should be controlled by the user or organization when practical. A provider may offer custodial key management, but custodial operation is a product choice and weaker trust model, not a protocol requirement.

## Hail Messaging Key

The verification method with fragment `#hail-messaging` authorizes routine Hail protocol operations.

It signs:

- Hail Envelopes
- replies
- delivery receipts
- sender profiles
- category manifests
- other server-to-server operational metadata

A hosting provider may hold the messaging private key. Publishing its public key in the DID document delegates operational Hail messaging authority to that provider.

The messaging key does not authorize:

- creation of Hail Grants
- creation of Hail Address Bindings
- PLC state updates
- PLC recovery

The identity and messaging roles must use distinct public keys in v1. Reusing one key for both roles defeats the intended separation between consent and routine provider operations.

## PLC Rotation And Recovery

PLC update and recovery authority is separate from Hail verification methods.

The authority hierarchy is:

```text
PLC rotation authority
  -> authorizes the DID document
  -> DID document authorizes Hail keys
  -> Hail keys authorize protocol objects
```

PLC rotation keys control the DID state and are not rendered as ordinary DID document verification methods. PLC rotation keys use P-256 or secp256k1; Hail verification methods use Ed25519. A Hail identity or messaging key therefore cannot also be used as a PLC rotation key.

Each PLC rotation key acts unilaterally; the ordered list is a priority and recovery mechanism, not a threshold signature. A lower-priority key can publish state that removes a higher-priority key. The removed higher-priority key can reverse that operation only during PLC's 72-hour recovery window. A user-held recovery key therefore protects a provider-custodied rotation key only when the user or a delegated monitor detects and recovers from an unauthorized update before that window closes.

## Verification Method Validation

When validating a Hail signature, an implementation:

1. Takes the signer DID and `key_id` from the signed object or its signature wrapper and validates their canonical `did:plc` syntax.
2. Resolves the exact DID through a PLC resolver.
3. Requires the resolved DID document `id` to exactly equal the canonical signer DID.
4. Requires `key_id` to be an absolute DID URL under the signer DID.
5. Expands relative verification-method IDs against the resolved document DID and locates exactly one top-level verification method with the resulting absolute ID.
6. Requires the verification method controller to equal the signer DID.
7. Requires the key type and algorithm to be allowed by this DID profile and the signed object's security profile.
8. Requires the key fragment to authorize the operation type.
9. Verifies the signature over the canonical signed payload.

Role rules:

```text
Hail Grant            -> #hail-identity
Hail Address Binding  -> #hail-identity
Hail Envelope         -> #hail-messaging
Reply Envelope        -> #hail-messaging
Delivery Receipt      -> #hail-messaging
Sender Profile        -> #hail-messaging
Category Manifest     -> #hail-messaging
```

A cryptographically valid signature from the wrong Hail key role must be rejected.

## PLC State Profile

A PLC operation stores verification methods as named `did:key` values. The Hail profile requires entries named:

```text
hail-identity
hail-messaging
```

and a service named:

```text
hail
```

Conceptual PLC state:

```json
{
  "verificationMethods": {
    "hail-identity": "did:key:z...",
    "hail-messaging": "did:key:z..."
  },
  "services": {
    "hail": {
      "type": "HailMessaging",
      "endpoint": "https://provider.example/hail"
    }
  }
}
```

PLC renders those entries as DID document verification methods and a service. Because PLC's rendered document does not necessarily express Hail's roles through standard verification relationships, the exact fragments defined by this profile provide the role authorization for `did:plc`.

The PLC operation is a full state snapshot. Creation and every update retain all intended rotation keys, verification methods, aliases, and services; omitting an existing entry removes it from current state. The encoded operation must remain within PLC's 7500-byte DAG-CBOR limit, and the state must remain within PLC's limit of ten verification methods. Hail requires two of those methods.

A newly created Hail identity uses the regular `plc_operation` format, not the deprecated legacy `create` format. An existing PLC identity can enable Hail by publishing an update that adds the two Hail verification methods and Hail service while preserving every unrelated state entry. An identity with fewer than two free verification-method slots cannot enable Hail without first removing other methods.

PLC-rendered DID documents may express verification-method and service IDs as relative fragment references such as `#hail-identity` and `#hail`. A Hail resolver expands each relative DID URL against the document's exact `did:plc` ID before uniqueness, role, controller, or service validation. Protocol objects always carry the resulting absolute DID URLs.

Every expanded verification-method ID and every expanded service ID must be unique. The two Hail methods must be top-level `verificationMethod` definitions with exact expanded IDs and controllers. Other PLC verification methods and services are allowed, but they authorize no Hail operation. Hail does not require `assertionMethod`; the two reserved PLC map names and their exact fragments define Hail role authorization.

## PLC Resolution And Validation

The source of authority is the valid PLC operation log, not an unverified rendered DID document. A production Hail PLC resolver validates:

1. The genesis operation's DAG-CBOR encoding and hash-derived DID.
2. Every operation CID, predecessor link, canonical signature encoding, and signature against a rotation key authorized by the preceding state.
3. PLC rotation-key priority and the 72-hour recovery rules, including nullified forks.
4. Tombstones and the current valid operation selected by those rules.
5. The complete current state before rendering or returning normalized Hail verification methods and services.

A resolver may maintain this validation incrementally from the PLC export stream and serve state from a local mirror. A POC may use a configured PLC directory's HTTPS resolution endpoint, but it treats that directory as trusted for current ordering and availability. Hail implementations do not construct a network destination from the PLC identifier; they contact only explicitly configured directory or mirror origins.

A rendered DID document, PLC state response, or resolver result is unusable if the DID is absent or tombstoned, its identifier does not exactly match the request, its underlying operation chain is invalid, or it does not satisfy the Hail state profile. Such a result supplies no Hail keys or service endpoint.

PLC-generated timestamps and global sequence numbers are directory annotations rather than self-authenticating operation fields. A verifier must not treat either as cryptographic proof of when an operation was created. Their use in recovery-window and ordering decisions inherits the PLC directory's documented trust model.

## Hail Service

The service with fragment `#hail` identifies the DID's current Hail server.

Required values:

```text
id fragment:      #hail
type:             HailMessaging
service endpoint: HTTPS base URL
```

The service endpoint is infrastructure, not identity. Changing it moves the DID to another Hail provider without changing grants or message relationships.

The endpoint is a base URL. The Hail HTTP binding derives standardized operation paths from that base rather than placing every endpoint in the DID document.

Conceptual derivation:

```text
base:      https://provider.example/hail
grants:    https://provider.example/hail/grants/{grant_id}
envelopes: https://provider.example/hail/envelopes
bodies:    https://provider.example/hail/bodies/{digest}
deliveries: https://provider.example/hail/deliveries/{envelope_digest}
```

The `envelopes`, `bodies/{digest}`, `grants/{grant_id}`, and `deliveries/{envelope_digest}` relative paths are fixed by the HTTP binding.

## Service Validation

The v1 Hail DID profile requires exactly one service whose `type` is the exact, case-sensitive JSON string `HailMessaging`; after relative-ID expansion, that service's `id` must be the absolute DID URL formed by appending `#hail` to the document's DID. An array-valued `type`, another spelling, and any additional `HailMessaging` service are invalid. Unrelated service entries are allowed.

`active` is not a per-service state in this profile. Every service in the successfully resolved current DID document is current; a removed service is absent. A resolution marked deactivated or otherwise unsuccessful has no active Hail service.

The Hail service's `serviceEndpoint` must be exactly one JSON string containing the base URL. DID Core's map and set forms are not supported, and an array, object, empty string, or multiple endpoint value is invalid.

Its endpoint must:

- use HTTPS
- use a valid public ASCII DNS hostname in canonical IDNA A-label form
- contain no username or password
- contain no query string
- contain no fragment
- not use an IP-address hostname
- not resolve to loopback, link-local, or private network addresses for public federation
- satisfy the URL canonicalization rules defined by the Hail HTTP binding

Publishers emit the canonical form without a trailing slash. Consumers perform the limited normalization and strict path validation defined by the HTTP binding before using or comparing the endpoint.

Protocol clients must not follow service redirects. They re-resolve the DID under the endpoint-refresh rules in the HTTP binding instead of trusting a redirect target.

## Provider Migration

A provider migration updates two pieces of DID state together:

- `#hail-messaging` to the new provider's operational key
- `#hail` to the new provider's base endpoint

The `#hail-identity` key should remain unchanged unless the DID controller is separately rotating it.

After the PLC update satisfies Hail's recovery-window acceptance policy:

- the old provider endpoint is no longer authoritative
- the old messaging key can no longer sign newly accepted Hail objects
- grants remain unchanged because they reference the DID
- address bindings remain valid until they expire, unless their identity key also changed

A provider migration that preserves protocol continuity must use the fenced state-transfer procedure in [delivery-state.md](delivery-state.md). The old provider freezes the DID's complete grant, reply, replay, delivery, and status serialization domain before export and never commits state after that snapshot. The new provider starts only after durable import and DID cutover. The old provider never receives the new messaging private key and stops signing Hail operations after removal. Emergency rotation without recoverable provider state may sacrifice pending delivery or status availability rather than continuing to trust a removed key.

Implementations may temporarily cache prior DID state. The HTTP binding defines which endpoint failures force early DID re-resolution, how canonical endpoints are compared, and when an operation may be retried at a newly authenticated endpoint.

## Key Rotation

Rotating either Hail key does not change the DID.

At ingest, servers verify signatures using PLC state valid under the Hail resolution, recovery-window, and historical-verification rules.

For the POC, cached PLC state used for new envelope intake must be no more than 300 seconds old. The recipient re-resolves immediately when the protected `kid` is absent or the cached key fails verification. Clients using the discovered service follow the endpoint-refresh triggers in the HTTP binding. A successful refresh replaces cached state; removed keys and endpoints do not remain valid for new operations. Production still needs an explicit policy for the PLC recovery window.

Recipient servers should retain the verification evidence needed to audit an accepted message after a key rotates. They should not require an old stored message to verify against only the current DID document.

Historical key resolution and proof retention require further specification before production use.

## Security Considerations

### Provider Impersonation

A provider holding `#hail-messaging` can sign routine messages as the DID while that key remains authorized. This is inherent in delegated server-side messaging and should be visible in the provider trust model.

It cannot create valid grants or address bindings unless it also controls `#hail-identity`.

### Custodial Identity Keys

If a provider holds both Hail private keys or controls PLC rotation authority, the key separation provides limited protection against that provider. Clients should disclose whether identity and rotation keys are user-controlled, provider-custodied, or shared.

### Stale Resolution

Cached PLC state can leave a removed provider key temporarily trusted. The POC bounds cache lifetime and defines forced refresh conditions; production still requires finality behavior for PLC's recovery window.

### Public PLC History

Every PLC operation, including nullified operations and tombstones, remains permanently public with directory timestamps. Hail tooling must not add Hail addresses or Hail-specific personal metadata to `alsoKnownAs` or other PLC state. The required Hail service necessarily publishes provider and migration history; service paths should use opaque tenant identifiers rather than human-readable account names. Rotation and verification keys should not be reused across DIDs because reuse makes those identities publicly correlatable.

### PLC Directory Trust

PLC's self-authenticating log lets mirrors detect invalid operations, but the directory can deny service or select the wrong valid fork during the recovery window. Production deployments should consume independently operated mirrors or maintain a locally validated export stream. Resolution failure must fail closed and must not fall back to stale state beyond the allowed cache policy.

The Hail PLC profile is based on version 0.3.0 (December 2025) of the published [`did:plc` method specification](https://web.plc.directory/spec/v0.1/did-plc). Changes to directory implementation behavior do not silently change Hail validation rules; adopting an incompatible PLC specification change requires an explicit Hail profile update.

### Key Confusion

Implementations must validate the signer DID, full `key_id`, controller, expected Hail role, key type, and algorithm. Looking up a key only by fragment or accepting any key in the DID document is unsafe.

### Service Endpoint Fetching

PLC resolution contacts only configured directory or mirror origins. Hail clients still need DNS rebinding, private-network, redirect, timeout, and response-size protections when contacting the resolved Hail service endpoint.

## Before Production

The POC may use the simplified trust and cache behavior defined above. A production Hail profile must resolve all five requirements below:

1. Define when PLC state becomes authoritative during the 72-hour recovery window, including the production cache lifetime and treatment of newly added or removed Hail keys and endpoints.
2. Define minimum PLC rotation-key custody, backup, monitoring, compromise detection, and recovery requirements for onboarding and ongoing operation.
3. Define required PLC mirrors or checkpoints, local operation-log validation, directory disagreement handling, and the maximum outage period during which cached state may be used.
4. Define the exact PLC operation, CID, chain, timestamp, and resolver evidence retained with accepted Hail objects for historical signature verification and audit.
5. Define provider migration while its PLC update remains recoverable, including old- and new-provider authority during the pending window, authenticated state export, fencing acknowledgement, rollback, and abandoned-cutover behavior.
