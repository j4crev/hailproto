# Hail Data Encoding And Signature Profile

Status: Draft

This document defines the sole Hail-owned payload, body, and signed-object representation for v0. It is influenced by the constrained data-model approach used by DRISL and AT Protocol, but Hail does not claim representation or protocol interoperability with either system.

## Protocol Boundary

Deterministic Hail CBOR is used for RACR protocol payloads, bodies and checkpoint hash inputs. The explicitly scoped reference snapshot profile in [transfer-formats.md](transfer-formats.md) instead signs a digest of exact retained JSON manifest bytes. JSON is not an alternate encoding of these signed or hashed values. Explicit HTTP bindings may wrap their exact bytes in base64url JSON fields.

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

Application map keys remain descriptive text strings. Integer application labels are not part of v0. Every v0 protocol payload and nested application map is closed unless its object specification explicitly says otherwise; an unknown member is rejected.

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

Specifications and tools may display Hail values as diagnostic JSON. Diagnostic JSON is never signed, hashed, or treated as a canonical payload representation. A transport JSON wrapper is a separate, explicitly specified structure; it does not authorize substituting diagnostic JSON for its embedded CBOR/COSE bytes.

Text, integers within the Hail range, booleans, null, arrays, and text-keyed maps use their corresponding JSON forms. In a schema-known byte-string field, diagnostic JSON uses the field's specified unpadded base64url text rendering. Tools must use the schema and must not automatically interpret arbitrary strings as binary values.

Examples in object specifications are diagnostic JSON unless explicitly identified as CBOR diagnostic notation or hexadecimal wire bytes. Values named with placeholders such as `base64url-*` illustrate field purpose and are not valid length-conforming test vectors.

## COSE_Sign1 Profile

Every object in the COSE registry below is one tagged COSE_Sign1 structure under RFC 9052. The separately domain-separated transfer records in [transfer-formats.md](transfer-formats.md) use their explicitly defined detached signatures instead:

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
- The unprotected map is empty. Unknown protected or any unprotected parameters are rejected in v0.
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
| `hail.connection-invitation` | `application/hail-connection-invitation+cbor` | `#hail-identity` |
| `hail.connection-confirmation` | `application/hail-connection-confirmation+cbor` | `#hail-identity` |
| `hail.connection-control` | `application/hail-connection-control+cbor` | `#hail-messaging` |
| `hail.conversation` | `application/hail-conversation+cbor` | creator's `#hail-messaging` |
| `hail.conversation-revival` | `application/hail-conversation-revival+cbor` | creator's `#hail-messaging` |

The historical `hail.connection-grant` shape in the codec/CDDL is not the current
coordinator-based connection admission mechanism. Its support is not required.
Connection HTTP exchanges embed COSE bytes in JSON as defined in
[connection-wire.md](connection-wire.md). Transfer wrappers and signature domains
are defined separately in [transfer-formats.md](transfer-formats.md).


When sent directly as an HTTP entity, a COSE object uses:

```text
application/cose; cose-type="cose-sign1"
```

Media types are parsed and compared under HTTP media-type rules, not as raw strings. For the outer signed-object type, the type and subtype must be `application/cose`, the `cose-type` parameter must have value `cose-sign1`, and no other parameter is permitted; insignificant whitespace, case-insensitive type or parameter names, and equivalent quoted or token parameter values do not cause rejection.

The protected content type identifies the embedded object. The Hail `+cbor` values are provisional until registration or final allocation, but they are fixed domain-separation values within this draft and must not be changed by implementations. Finalizing their registration is required before stable v0 publication. v0 applies no HTTP content coding to a signed COSE representation.

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
- A conversation descriptor hash and revival replay hash cover the complete COSE representation.
- A connection proof hash covers the exact deterministic CBOR proof bundle; an acknowledgement hashes the complete received control COSE bytes.
- Transfer handshake digests cover deterministic payload bytes, excluding detached signatures. Snapshot and checkpoint domains are defined in [transfer-formats.md](transfer-formats.md).

Specifications must name the domain and must not use an unqualified phrase such as “canonical object hash.”

## Resource Safety

An implementation applies transport-byte limits before decoding and uses a decoder with explicit nesting, collection, string, and total-allocation limits. It rejects oversized declarations before allocation where possible. Object specifications define transport and semantic limits; accepting valid small inputs does not require allocating according to attacker-controlled lengths.

### Current CBOR Budgets

The following inclusive limits apply to a decoded Hail body or signed-object
payload. Implementations MUST reject values exceeding them and MUST support
otherwise valid values within them, subject to the object's stricter schema and
representation-size rules. A larger provider-local decoder budget does not extend
the interoperable profile.

| Budget | Maximum |
| --- | ---: |
| Encoded bytes | 1048576, further bounded by the object's representation limit |
| Item depth | 32 |
| Total items | 16384 |
| Elements in one array | 4096 |
| Entries in one map | 256 |
| UTF-8 bytes in one text string, including a map key | 1048576 |
| Bytes in one byte string | 1048576 |

Counting is defined on the CBOR data, independently of host-language objects:

- The root item has depth zero and counts as one item. Every array or map counts
  as one item, including an empty container. Each array element, map key and map
  value is an item at its containing collection's depth plus one. Nested items
  count recursively. A map with two scalar keys and two scalar values has five
  items including the map itself.
- Text and byte strings each count as one item; their contents do not count as
  nested items. Text lengths are UTF-8 octets, not characters or UTF-16 units.
  Map entries count key/value pairs, not individual keys and values.
- Encoded size includes CBOR headers. For example, a 1048571-byte byte string
  occupies 1048576 encoded bytes; a 1048576-byte string exceeds that encoded budget.
- Budgets restart for each independently decoded CBOR domain. COSE's payload and
  protected-header byte strings count as single items in the outer representation;
  their embedded CBOR is checked separately, not charged twice to the outer budget.

For the COSE wrapper, the maximum depth is 8, total items 256, array length 8,
map entries 8, and text-string length 1024. Its encoded-byte and byte-string
ceilings equal the object's complete signed-representation limit. Tag 18 counts
as one item at depth zero and its enclosed array is at depth one; no other tags
are permitted. The protected-header domain uses those same wrapper budgets but
with a 1024-byte encoded/byte-string ceiling, depth zero at its map, and no tag.
The exact COSE shape, labels and signature rules remain mandatory even when an
otherwise different structure fits these budgets.

These budgets do not apply wholesale to transfer snapshots or history checkpoint
domains, whose larger bounds are specified in [account history](account-history.md)
and [transfer formats](transfer-formats.md). They do not authorize whole-snapshot
allocation from an untrusted declared size. Decoder working memory and concurrent
work MUST remain bounded in addition to the wire budgets.

[Resource vectors](vectors/cbor-resource-limits.json) define exact boundary bytes
using repeated hex segments, expected lengths/digests and accept/reject results.
Small test-only budget overrides isolate counting rules; they are not additional
negotiated wire profiles.

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

Hail defines one deterministic CBOR encoding and the COSE profile above, plus the explicitly specified transfer signature profiles. Current object versions are listed in [README.md](README.md); alpha interoperability does not require historical formats. The earlier JSON/JCS/JWS draft was not deployed and is not an alternate v0 representation. Supporting another encoding or security algorithm requires an explicit future profile with negotiation, downgrade prevention, digest-domain, retained-evidence, and migration rules.

## Structural Schemas

The draft CDDL structures for protocol objects are maintained in [hail.cddl](hail.cddl). The current transfer manifest and logical history record shapes are defined by [JSON Schema](schemas/account-history-v7-v8.json) and [account-history.md](account-history.md). They define representation-level shapes and sizes. The object specifications remain authoritative for identifier grammar, Unicode normalization, ordering, conditional presence, cross-field relationships, authorization, and state transitions until those constraints are also available in executable validators.

## Implementation Deliverables

Before Hail claims cross-implementation interoperability, the project must publish:

- CDDL or equally precise machine-readable schemas
- a reference deterministic encoder and strict decoder
- complete payload and COSE hexadecimal vectors for every signed object type
- digest and HTTP-boundary conversion vectors
- negative vectors for every prohibited CBOR and COSE form
- cross-language conformance results
- realistic size, allocation, encode/decode, sign/verify, and end-to-end benchmarks
