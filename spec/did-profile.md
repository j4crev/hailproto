# Hail DID Profile

Status: Draft

This document defines the verification methods and service entry a DID uses to participate in Hail Protocol.

The profile answers two questions:

- Which keys may authorize Hail operations for this DID?
- Where is this DID's current Hail server?

The provisional v1 DID methods are:

```text
Bring your own domain: did:web
Provider-issued identity: did:plc
```

Hail Grants and Hail Envelopes contain generic DID strings. Method-specific resolution and validation remain behind a DID resolver interface.

## Required Entries

A Hail-capable DID document contains:

- one `#hail-identity` verification method
- one `#hail-messaging` verification method
- exactly one `#hail` service with type `HailMessaging`

Conceptual DID document:

```json
{
  "id": "did:plc:examplealiceidentifier",
  "verificationMethod": [
    {
      "id": "did:plc:examplealiceidentifier#hail-identity",
      "type": "Multikey",
      "controller": "did:plc:examplealiceidentifier",
      "publicKeyMultibase": "z..."
    },
    {
      "id": "did:plc:examplealiceidentifier#hail-messaging",
      "type": "Multikey",
      "controller": "did:plc:examplealiceidentifier",
      "publicKeyMultibase": "z..."
    }
  ],
  "service": [
    {
      "id": "did:plc:examplealiceidentifier#hail",
      "type": "HailMessaging",
      "serviceEndpoint": "https://provider.example/hail"
    }
  ]
}
```

## POC Key Algorithm And Encoding

The POC uses Ed25519 for both Hail verification-method roles. The roles must still use distinct public keys.

An Ed25519 Hail verification method uses the W3C Multikey representation:

```json
{
  "type": "Multikey",
  "publicKeyMultibase": "z..."
}
```

`publicKeyMultibase` is the base58btc multibase encoding of the `ed25519-pub` multicodec prefix followed by exactly 32 public-key bytes. The multicodec value is `0xed`, whose unsigned-varint byte representation is `0xed 0x01`.

For `did:web`, the DID document publishes that Multikey directly and references it from `assertionMethod`.

For `did:plc`, the PLC operation stores the equivalent Ed25519 `did:key` value. Its multibase identifier encodes the same `ed25519-pub` multicodec prefix and public-key bytes; DID resolution renders the corresponding Hail verification method.

The Hail Envelope JWS uses the fully specified RFC 9864 `Ed25519` algorithm identifier. The deprecated polymorphic `EdDSA` identifier is not accepted. Signature wrappers for grants, address bindings, and other Hail objects remain object-specific even when they use the same key algorithm.

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
- DID document updates
- DID recovery

The identity and messaging roles must use distinct public keys in v1. Reusing one key for both roles defeats the intended separation between consent and routine provider operations.

## DID Control And Recovery Keys

DID method update and recovery keys are separate from Hail verification methods.

The authority hierarchy is:

```text
DID update/recovery authority
  -> authorizes the DID document
  -> DID document authorizes Hail keys
  -> Hail keys authorize protocol objects
```

For `did:plc`, PLC rotation keys control the DID state and are not rendered as ordinary DID document verification methods. A Hail identity or messaging key must not also be used as a PLC rotation key.

For `did:web`, control of the domain and published DID document controls which Hail verification methods are active.

## Verification Method Validation

When validating a Hail signature, an implementation:

1. Takes the signer DID and `key_id` from the signed object or its signature wrapper.
2. Resolves the exact DID using the appropriate method resolver.
3. Requires the resolved DID document `id` to equal the signer DID according to that method's comparison rules.
4. Requires `key_id` to be an absolute DID URL under the signer DID.
5. Locates exactly one verification method with that ID.
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

## DID Method Profiles

### `did:web`

A `did:web` document must contain both Hail verification methods in `verificationMethod` and must reference them from `assertionMethod`.

Conceptual example:

```json
{
  "id": "did:web:example.com:users:alice",
  "verificationMethod": [
    {
      "id": "did:web:example.com:users:alice#hail-identity",
      "type": "Multikey",
      "controller": "did:web:example.com:users:alice",
      "publicKeyMultibase": "z..."
    },
    {
      "id": "did:web:example.com:users:alice#hail-messaging",
      "type": "Multikey",
      "controller": "did:web:example.com:users:alice",
      "publicKeyMultibase": "z..."
    }
  ],
  "assertionMethod": [
    "did:web:example.com:users:alice#hail-identity",
    "did:web:example.com:users:alice#hail-messaging"
  ],
  "service": [
    {
      "id": "did:web:example.com:users:alice#hail",
      "type": "HailMessaging",
      "serviceEndpoint": "https://messaging-host.example/hail"
    }
  ]
}
```

### `did:plc`

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

Use of the public PLC directory for these non-AT Protocol entries remains provisional pending confirmation from its maintainers.

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

The v1 Hail DID profile requires exactly one active `HailMessaging` service with fragment `#hail`.

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

After the DID method considers the update current:

- the old provider endpoint is no longer authoritative
- the old messaging key can no longer sign newly accepted Hail objects
- grants remain unchanged because they reference the DID
- address bindings remain valid until they expire, unless their identity key also changed

A provider migration that preserves protocol continuity must use the fenced state-transfer procedure in [delivery-state.md](delivery-state.md). The old provider freezes the DID's complete grant, reply, replay, delivery, and status serialization domain before export and never commits state after that snapshot. The new provider starts only after durable import and DID cutover. The old provider never receives the new messaging private key and stops signing Hail operations after removal. Emergency rotation without recoverable provider state may sacrifice pending delivery or status availability rather than continuing to trust a removed key.

Implementations may temporarily cache prior DID state. The HTTP binding defines which endpoint failures force early DID re-resolution, how canonical endpoints are compared, and when an operation may be retried at a newly authenticated endpoint.

## Key Rotation

Rotating either Hail key does not change the DID.

At ingest, servers verify signatures using DID state valid under the resolution and historical-verification rules of the applicable DID method and Hail security profile.

For the POC, a cached DID document used for new envelope intake must be no more than 300 seconds old. The recipient re-resolves immediately when the protected `kid` is absent or the cached key fails verification. Clients using the discovered service follow the endpoint-refresh triggers in the HTTP binding. A successful refresh replaces cached state; removed keys and endpoints do not remain valid for new operations. Method-specific finality and recovery windows remain production concerns.

Recipient servers should retain the verification evidence needed to audit an accepted message after a key rotates. They should not require an old stored message to verify against only the current DID document.

Historical key resolution and proof retention require further specification before production use.

## Security Considerations

### Provider Impersonation

A provider holding `#hail-messaging` can sign routine messages as the DID while that key remains authorized. This is inherent in delegated server-side messaging and should be visible in the provider trust model.

It cannot create valid grants or address bindings unless it also controls `#hail-identity`.

### Custodial Identity Keys

If a provider holds both Hail private keys or controls the DID update/recovery authority, the key separation provides limited protection against that provider. Clients should disclose whether identity and recovery keys are user-controlled, provider-custodied, or shared.

### Stale Resolution

Cached DID documents can leave a removed provider key temporarily trusted. The POC bounds cache lifetime and defines forced refresh conditions; production still requires method-specific finality and recovery-window behavior.

### Key Confusion

Implementations must validate the signer DID, full `key_id`, controller, expected Hail role, key type, and algorithm. Looking up a key only by fragment or accepting any key in the DID document is unsafe.

### Service Endpoint Fetching

Resolving a DID must not grant unrestricted server-side network access. Hail clients need DNS rebinding, private-network, redirect, timeout, and response-size protections when contacting service endpoints.

## Open Questions

- Will production retain Ed25519 as the only required signing algorithm or add another fully specified algorithm?
- What canonical signed-object and signature wrapper format applies to Hail Address Bindings?
- What production cache lifetime and method-specific finality rules replace the POC's 300-second maximum?
- How is historical DID state identified and retained for audit verification?
- How does the PLC recovery window affect acceptance of newly rotated keys and endpoints?
- What interoperable authenticated export format and fencing acknowledgement implement the required atomic provider cutover?
