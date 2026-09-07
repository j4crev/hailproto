# Hail Data Encoding And Signature Profile

Status: Draft

This document defines the sole Hail-owned payload, body, and signed-object representation for v1. It is influenced by the constrained data-model approach used by DRISL and AT Protocol, but Hail does not claim representation or protocol interoperability with either system.

## Protocol Boundary

Deterministic Hail CBOR is used whenever a Hail-owned value is signed, hashed as protocol content, transferred as a Hail Body, or retained as exact protocol evidence. JSON is not an alternate v1 federation representation.

Externally defined formats retain their own encodings. In particular, WebFinger JRD and rendered DID documents remain JSON. RFC 9457 Problem Details and the fixed generic HTTP receipt also remain JSON. Client-to-provider APIs are outside the Hail federation boundary and may expose JSON or native application types.

## Hail Data Model

A Hail value is exactly one of:

- null
- boolean
- integer from `-(2^53 - 1)` through `2^53 - 1`, further restricted by its schema
- Unicode text string encoded as valid UTF-8
- byte string
- finite array of Hail values
- finite map from unique text-string keys to Hail values

Floating-point values, CBOR undefined, non-text map keys, and CBOR tags inside Hail payloads and bodies are prohibited. A schema may prohibit null, negative integers, empty values, or other values admitted by the general model. Null and an absent map member are distinct.

Application map keys remain descriptive text strings. Integer application labels are not part of v1. Every v1 protocol payload and nested application map is closed unless its object specification explicitly says otherwise; an unknown member is rejected.

## Deterministic Encoding

Hail uses CBOR as defined by RFC 8949 with its core deterministic encoding requirements and these additional rules:

- Integers and length arguments use their shortest permitted encoding.
- Maps use deterministic encoded-key ordering.
- Maps, arrays, text strings, and byte strings use definite lengths.
- Duplicate map keys are rejected before conversion into an implementation-native map.
- Text must be well-formed UTF-8. A byte string is never accepted where a schema requires text, or vice versa.
- No application payload or body contains a CBOR tag.
- Exactly one complete item is present and no trailing bytes are accepted.
- A receiver performs bounded decoding, deterministically re-encodes the value, and requires byte-for-byte equality with the received bytes before accepting it as a Hail payload or body.

Unicode normalization is a schema property rather than a CBOR property. Fields that require NFC continue to require NFC; other text is not silently normalized during encoding or verification.

The terms **deterministic payload bytes** and **deterministic body bytes** in Hail specifications mean the exact bytes produced by this section.

## Diagnostic JSON

Specifications and tools may display Hail values as diagnostic JSON. Diagnostic JSON is never signed, hashed, accepted by a federation endpoint, or treated as a canonical representation.

Text, integers within the Hail range, booleans, null, arrays, and text-keyed maps use their corresponding JSON forms. In a schema-known byte-string field, diagnostic JSON uses the field's specified unpadded base64url text rendering. Tools must use the schema and must not automatically interpret arbitrary strings as binary values.

Examples in object specifications are diagnostic JSON unless explicitly identified as CBOR diagnostic notation or hexadecimal wire bytes. Values named with placeholders such as `base64url-*` illustrate field purpose and are not valid length-conforming test vectors.

## COSE_Sign1 Profile

Every signed Hail v1 object is one tagged COSE_Sign1 structure under RFC 9052:

```cbor-diag
18([
  << { 1: -19, 3: "application/hail-envelope+cbor", 4: h'...' } >>,
  {},
  h'...',
  h'...'
])
```

The example content type is object-specific. The four array elements are the protected-header byte string, empty unprotected-header map, embedded payload byte string, and signature byte string.

Rules:

- CBOR tag 18 is required. An untagged COSE_Sign1 is rejected.
- The COSE structure and protected-header map use RFC 8949 deterministic encoding.
- The embedded payload is the exact deterministic encoding of one closed Hail payload map.
- The protected map contains exactly labels `1` (`alg`), `3` (`content type`), and `4` (`kid`).
- `alg` is integer `-19`, the fully specified COSE `Ed25519` algorithm registered by RFC 9864. Deprecated polymorphic `EdDSA` value `-8`, other algorithms, negotiation, and fallback are rejected.
- `content type` is the exact object-specific parameterless Hail `+cbor` media-type text string named by that object's specification.
- `kid` is the byte string containing the UTF-8 encoding of the canonical absolute DID URL for the required key role. When the payload has a `key_id` field, it exactly matches that field after UTF-8 decoding; otherwise it is derived from the signed party DID and the object-specific role.
- The unprotected map is empty. Unknown protected or any unprotected parameters are rejected in v1.
- The payload is embedded; detached payloads and a null payload element are rejected.
- External AAD is the empty byte string.
- The signature is exactly 64 bytes and is created and verified using the RFC 9052 `Sig_structure` and the key identified by `kid`.
- The complete tagged COSE_Sign1 item has one deterministic encoding and contains no trailing bytes.

The object-specific protected content type, signed payload `type`, fixed algorithm, exact key role, and closed schema jointly provide domain separation. A verifier validates every one of those properties rather than only the cryptographic signature.

The term **complete signed representation bytes** means the exact complete tagged deterministic COSE_Sign1 bytes.

## Signed Object Types

| Payload type | Protected content type | Required key role |
| --- | --- | --- |
| `hail.address-binding` | `application/hail-address-binding+cbor` | `#hail-identity` |
| `hail.sender-profile` | `application/hail-sender-profile+cbor` | `#hail-messaging` |
| `hail.grant` | `application/hail-grant+cbor` | `#hail-identity` |
| `hail.envelope` | `application/hail-envelope+cbor` | `#hail-messaging` |
| `hail.delivery-status` | `application/hail-delivery-status+cbor` | `#hail-messaging` |

The HTTP representation of every signed object uses:

```text
application/cose; cose-type="cose-sign1"
```

Media types are parsed and compared under HTTP media-type rules, not as raw strings. For the outer signed-object type, the type and subtype must be `application/cose`, the `cose-type` parameter must have value `cose-sign1`, and no other parameter is permitted; insignificant whitespace, case-insensitive type or parameter names, and equivalent quoted or token parameter values do not cause rejection.

The protected content type identifies the embedded object. The five Hail `+cbor` values are provisional until registration or final allocation, but they are fixed domain-separation values within this draft and must not be changed by implementations. Finalizing their registration is required before stable v1 publication. V1 applies no HTTP content coding to a signed COSE representation.

## Binary Values At Text Boundaries

SHA-256 values are exactly 32-byte byte strings inside Hail payloads. Where a URL path segment, strong ETag opaque value, or diagnostic JSON field requires text, the bytes use unpadded base64url under RFC 4648 and produce exactly 43 ASCII characters. Padding, percent encoding, and noncanonical base64url are rejected where the relevant HTTP binding requires the literal form.

Bearer-token entropy is exactly 32 bytes in an envelope payload. The `Authorization` header renders those bytes as unpadded base64url after the `Bearer` scheme. The decoded header value must be exactly 32 bytes.

RFC 9530 `Content-Digest` uses that standard's structured-field byte-sequence syntax and standard base64. It covers the HTTP message content, including gzip content coding when present, and is not the signed digest of the uncompressed deterministic Hail Body. It is not the base64url representation used by Hail URL paths and ETags.

## Digest Domains

Hail uses SHA-256 but intentionally has more than one input domain:

- Address Binding and Sender Profile representation digests hash complete signed representation bytes.
- A Grant revision digest hashes complete signed representation bytes and supplies both the next revision's `previous` byte string and the current strong ETag's base64url opaque value.
- An Envelope payload digest hashes deterministic payload bytes, excluding the COSE wrapper. Replay handling and Delivery Status use this same digest.
- A Body content digest hashes exact uncompressed deterministic body bytes.

Specifications must name the domain and must not use an unqualified phrase such as “canonical object hash.”

## Resource Safety

An implementation applies transport-byte limits before decoding and uses a decoder with explicit nesting, collection, string, and total-allocation limits. It rejects oversized declarations before allocation where possible. Object specifications define transport and semantic limits; accepting valid small inputs does not require allocating according to attacker-controlled lengths.

The common signed-object validation sequence is:

1. Enforce HTTP method, media type, content coding, framing, and representation-size requirements.
2. Perform bounded structural CBOR and COSE decoding.
3. Require tag 18, the exact four-element COSE_Sign1 shape, deterministic protected headers, an empty unprotected map, bounded embedded payload, and a 64-byte signature.
4. Require the embedded payload's exact deterministic encoding and validate its closed schema and inexpensive field relationships.
5. Apply any object-specific privacy-safe preliminary lookup.
6. Resolve and validate the protected `kid`, its controller, algorithm, and required Hail key role.
7. Verify the COSE signature and require the authenticated signer to equal the applicable signed party.
8. Only then mutate authenticated protocol state or disclose protected detail.

Object specifications may add checks but do not weaken this sequence.

## Versioning

Hail v1 has one mandatory deterministic CBOR and COSE profile. The earlier JSON/JCS/JWS draft was not deployed and is not an alternate v1 representation. Supporting another encoding or security algorithm requires an explicit future profile with negotiation, downgrade prevention, digest-domain, retained-evidence, and migration rules.

## Structural Schemas

The draft CDDL structures are maintained in [hail.cddl](hail.cddl). They define representation-level shapes and sizes. The object specifications remain authoritative for identifier grammar, Unicode normalization, ordering, conditional presence, cross-field relationships, authorization, and state transitions until those constraints are also available in executable validators.

## Implementation Deliverables

Before Hail claims cross-implementation interoperability, the project must publish:

- CDDL or equally precise machine-readable schemas
- a reference deterministic encoder and strict decoder
- complete payload and COSE hexadecimal vectors for every signed object type
- digest and HTTP-boundary conversion vectors
- negative vectors for every prohibited CBOR and COSE form
- cross-language conformance results
- realistic size, allocation, encode/decode, sign/verify, and end-to-end benchmarks
