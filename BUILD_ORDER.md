# Hail Protocol Build Order

This document recommends the order in which Hail Protocol should be specified and prototyped.

The central principle is to define protocol behavior and trust semantics before choosing endpoint paths, encodings, or a rich body vocabulary.

## Dependency Order

```text
protocol boundaries and invariants
  -> threat model
  -> identity and discovery
  -> abstract operations
  -> Hail Grant
  -> Hail Envelope
  -> delivery state machine
  -> HTTPS binding
  -> security and encoding profile
  -> end-to-end prototype
  -> replies
  -> rich Safe Portable Text
```

## 1. Establish Protocol Boundaries

Hail should initially standardize the interoperable federation behavior between independently operated servers.

Hail should standardize:

- domain and server discovery
- sender identity and key discovery
- Hail Grants
- Hail Envelopes
- delivery and rejection semantics
- detached Hail Body retrieval
- reply authorization
- wire encodings and signatures

Hail should not initially require a standard API between an end-user client and its own provider. Providers may expose REST, GraphQL, local APIs, email-client bridges, or other interfaces.

The required interoperable API is the server-to-server federation API.

## 2. Define Invariants And Threat Model

Protocol invariants:

- A sender cannot deliver without a recipient-created grant.
- A recipient server is the authority on whether its user granted delivery.
- Grant revocation is immediate and unilateral.
- New sender categories require explicit permission.
- Unauthorized traffic is rejected before body transfer.
- A valid grant does not remove the need for sender authentication.
- Messages cannot be replayed as new deliveries.
- Message bodies cannot trigger undeclared network requests.
- A hosting provider is infrastructure, not necessarily identity.
- Durable identity objects must not permanently embed a provider endpoint.
- Detailed errors must not allow unknown parties to probe whether an address exists.

Threat actors and failures to consider:

- unauthorized sender
- malicious but granted sender
- compromised sender server
- compromised recipient server
- malicious body or asset
- replaying intermediary
- abusive recipient sending fake grants or replies
- hostile, unavailable, or abandoned provider
- network attacker
- resource exhaustion and decompression attacks

## 3. Define The Minimum Identity Model

Grants and envelopes cannot be finalized until their parties are defined.

Decisions needed:

- exact Hail address syntax
- address normalization and comparison
- which sender and recipient DIDs grants target
- how human-readable Hail addresses resolve to and verify those DIDs
- how a domain delegates to a hosting provider
- how signing keys are discovered
- how signing keys rotate
- what remains stable during provider migration

Starting identity model:

```text
Sender identity: DID with a domain-verified Hail address
Recipient identity: DID with a human-readable Hail address
Grant parties: DIDs
Envelope parties: DIDs
Hosting endpoint: mutable infrastructure delegated by the DID
Verification keys: resolved from the DID document
```

DIDs are part of the first prototype because identity portability, grants, key discovery, and provider migration depend on them.

Provisional v1 DID methods:

```text
Bring your own domain: did:web
Provider-issued identity: did:plc
```

All Hail implementations should isolate method-specific behavior behind a DID resolver interface. Grants and envelopes contain generic DID strings and must not contain PLC- or Web-specific fields.

Human-readable Hail addresses resolve through WebFinger to signed, expiring Hail Address Bindings. The address domain publishes the binding and a DID-authorized key signs it. `alsoKnownAs` is not required for address verification.

The Hail DID profile requires:

```text
#hail-identity   Consent and address-binding key
#hail-messaging  Routine server messaging key
#hail            HailMessaging service with an HTTPS base endpoint
```

The identity and messaging keys are distinct. DID update and recovery keys are separate from both. See `spec/did-profile.md`.

Production dependence on the public PLC directory requires confirmation that non-AT Protocol identities and Hail-specific verification methods and services are supported. Development can use a local PLC server and fixture operation logs.

## 4. Define Abstract Operations

Define operations before assigning HTTP methods and paths.

Initial operations:

```text
DiscoverIdentity
PublishGrantRevision
SubmitEnvelope
RetrieveBody
SubmitReply
```

For each operation, specify:

- caller
- receiver
- authenticated identity
- request object
- success result
- rejection conditions
- idempotency behavior
- retry behavior
- privacy implications

`SubmitReply` may ultimately be the same operation as `SubmitEnvelope`. It is listed separately at this stage because it has a different authorization rule.

## 5. Define Hail Grant V1

The Hail Grant is the protocol's central authorization object. Its v1 target, scope, lookup, revision, replacement, revocation, and web-native publication semantics are defined in `spec/grants.md`.

Remaining grant work is limited to the shared security and HTTP binding decisions referenced by that specification, including canonical signatures, digest encoding, timestamp tolerance, size limits, and final RFC 9457 problem types.

## 6. Define Hail Envelope V1

After grants are understood, define the smallest object required to route and authorize delivery.

Candidate fields:

- protocol version
- message ID
- sender
- recipient
- grant ID or grant lookup information
- category
- protocol-defined message type
- creation timestamp
- expiration timestamp
- body hash algorithm
- body hash
- body uncompressed size
- body media type/profile
- reply permission
- reply deadline
- reply target
- reply routing hint
- signing key ID

Conceptual body descriptor:

```json
{
  "hash_algorithm": "sha-256",
  "hash": "...",
  "size": 8421,
  "media_type": "application/spt+json"
}
```

Declared uncompressed size allows a recipient to enforce limits before accepting or decompressing a body.

## 7. Define The Delivery State Machine

Endpoint responses cannot be finalized until delivery states are clear.

Candidate states:

```text
submitted
rejected
envelope-accepted
body-retrieval-pending
body-retrieved
body-verified
delivered
```

Questions to settle:

- Does envelope acceptance mean the message is delivered?
- How does the sender learn that body retrieval succeeded or failed?
- How long may a receiver retry body retrieval?
- How long must a sender retain a detached body?
- Can a sender proactively transfer a body after envelope acceptance?
- How are permanent and transient failures distinguished?
- Is a delivery status resource needed?

Envelope acceptance and completed delivery should not be conflated. A receiver may accept an envelope and later fail to retrieve or verify its body.

## 8. Bind Operations To HTTPS

After operation semantics and state transitions are defined, bind them to HTTP.

Likely starting endpoints:

```http
GET  /.well-known/hail
PUT  /hail/grants/{grant_id}
POST /hail/envelopes
GET  /hail/bodies/{hash}
```

`/hail/envelopes` is more precise than `/hail/inbox` because the receiving server initially accepts an envelope, not necessarily a completed inbox message.

Replies should preferably reuse `/hail/envelopes`; they are ordinary Hail Messages with a different authorization path.

Body URLs should not be arbitrary URLs supplied by each envelope. Recipient-controlled fetching of arbitrary URLs introduces server-side request forgery risk. Body locations should be derived from authenticated discovery metadata or constrained to authenticated sender infrastructure.

## 9. Define The Security And Encoding Profile

Once signed object fields are stable, decide:

- JSON, CBOR, or both
- canonicalization rules
- signature wrapper
- required signing algorithms
- key ID rules
- timestamp tolerance
- message ID and nonce rules
- replay cache requirements
- body hash algorithms
- compression rules
- decompression limits

Possible prototype profile:

```text
Encoding: JSON
Canonicalization: RFC 8785 JCS
Signature: Ed25519 detached signature
Body digest: SHA-256
Transport: HTTPS
Compression: gzip
```

Alternative profile to evaluate later:

```text
Encoding: CBOR
Signature wrapper: COSE
Body digest: SHA-256
Transport: HTTPS
Compression: zstd
```

The first implementation should use one mandatory profile. Supporting multiple profiles before interoperability exists adds complexity without proving the central design.

## 10. Build A Thin End-To-End Slice

The first implementation should send one plain-text Hail Message between two toy servers.

Include:

- static domain discovery
- one signing key per server
- one sender
- one recipient
- one category
- one signed grant
- one signed envelope
- one detached body
- body hash verification
- unauthorized delivery rejection
- duplicate and replay rejection
- revocation rejection

Safe Portable Text body:

```json
{
  "version": 1,
  "profile": "spt-1",
  "blocks": [
    {
      "_type": "block",
      "style": "normal",
      "children": [
        {
          "_type": "span",
          "text": "Hello from Hail.",
          "marks": []
        }
      ],
      "markDefs": []
    }
  ]
}
```

Only Portable Text-compatible text blocks are needed for this slice. Custom SPT nodes can wait.

The most important prototype measurement is the cost of rejecting unauthorized envelopes before signature verification and body transfer.

## 11. Add Reply Capabilities

After grant-authorized delivery works, add:

- `reply`
- `reply_to`
- `reply_by`
- `reply_handler`
- replyable sent-message index
- expired reply rejection
- unsolicited reply rejection
- continuous mutual consent tests

Replies should reuse the normal Hail Envelope delivery operation unless implementation evidence shows a need for separate transport.

## 12. Expand Safe Portable Text

Rich body nodes should be added after transport and authorization work end to end.

Recommended expansion order:

1. Text blocks, headings, lists, decorators, and safe links.
2. Declared images.
3. Buttons.
4. Dividers and callouts.
5. Key-value summaries.
6. Theme tokens.
7. Semantic receipt, booking, and itinerary nodes.
8. More complex layout after renderer and phishing analysis.

This lets Safe Portable Text evolve from real message requirements rather than attempting to design a complete visual language before the protocol works.

## Early Detached-Body Risks

The detached-body design introduces issues that must be addressed before implementation:

### Server-Side Request Forgery

Recipient servers must not fetch arbitrary body URLs supplied in envelopes. Body retrieval must be constrained to authenticated sender infrastructure.

### Body Authorization

Sender body endpoints must not unintentionally expose private or recipient-specific content. Shared campaign bodies and recipient-specific bodies may require different access policies.

### Body Retention

The sender must keep an accepted body available for a defined retrieval and retry period.

### Acceptance Semantics

Envelope acceptance does not necessarily mean completed delivery. Protocol responses must make this distinction clear.

### Shared-Body Privacy

A shared content hash can reveal that recipients received identical content. The privacy implications of public or reusable body hashes need analysis.

### Resource Limits

Envelopes must declare body size. Receivers must enforce limits on:

- compressed bytes
- uncompressed bytes
- compression ratio
- document depth
- node count
- string lengths
- asset count
- aggregate asset size

### Replay Protection

Message IDs need uniqueness, idempotency, and retention rules. A previously accepted envelope must not become a new message when replayed.

### Preliminary Grant Lookup

A receiver may use the claimed sender identity for a cheap grant lookup before cryptographic verification. Successful delivery must still require signature verification against the authenticated sender identity.

### Key Rotation

Grants should identify sender identities rather than permanently pinning one operational key unless explicit key-rotation semantics are defined.

## First Specification Artifact

The first detailed specification should describe one complete grant-authorized delivery between two servers.

It should define:

- actors
- identities
- trust anchors
- discovery
- grant creation and publication
- envelope creation and signing
- authorization checks
- body retrieval and verification
- success semantics
- every expected failure path
- idempotency and retry behavior

That flow should then drive the exact Hail Grant V1 and Hail Envelope V1 schemas.
