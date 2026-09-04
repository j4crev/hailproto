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
  -> detached Hail Body
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

- A sender cannot deliver without a recipient-created grant or a single-use reply authorization.
- A recipient server is the authority on whether its user granted delivery.
- Grant revocation immediately prevents new envelope acceptance and is unilateral.
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

V1 identity method:

```text
did:plc
```

All Hail implementations should isolate PLC directory access, log validation, and mirror selection behind a resolver interface. Grants and envelopes contain canonical `did:plc` identifiers.

Human-readable Hail addresses resolve through WebFinger to signed, expiring Hail Address Bindings. The address domain publishes the binding and a DID-authorized key signs it. Hail addresses are not written to PLC `alsoKnownAs`.

The Hail DID profile requires:

```text
#hail-identity   Consent and address-binding key
#hail-messaging  Routine server messaging key
#hail            HailMessaging service with an HTTPS base endpoint
```

The identity and messaging keys are distinct. PLC rotation keys are separate from both. See `spec/did-profile.md`.

PLC operations store the two Ed25519 Hail verification methods as named `did:key` values and the Hail endpoint as a named service. Resolvers expand PLC's relative DID document IDs before comparison. Development can use a local PLC server and fixture operation logs; production resolution should support validated mirrors or local audit-log verification rather than coupling protocol behavior to one HTTP origin.

The five PLC requirements that must be resolved before production are tracked in `spec/did-profile.md#before-production`.

## 4. Define Abstract Operations

Define operations before assigning HTTP methods and paths.

Initial operations:

```text
DiscoverIdentity
PublishGrantRevision
SubmitEnvelope
RetrieveBody
PushDeliveryStatus
```

`SubmitEnvelope` includes both grant- and reply-authorized envelopes. Idempotent acknowledgement is a required result of `PushDeliveryStatus`; no separate acknowledgement operation is currently defined. A future `QueryDeliveryStatus` recovery operation remains deferred until its authentication and anti-oracle behavior are defined.

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

The consolidated caller, receiver, authentication, request, result, idempotency, retry, privacy, and binding information for these operations is maintained in the federation operation inventory in `spec/http-binding.md`.

## 5. Define Hail Grant V1

The Hail Grant is the protocol's central authorization object. Its v1 target, scope, lookup, revision, replacement, revocation, and web-native publication semantics are defined in `spec/grants.md`.

Grant canonicalization, flattened JWS signatures, signed-state digests, ETags, conditional publication, HTTP statuses, timestamp tolerance, and disclosure-safe Problem Details behavior are defined. Remaining grant work includes the interoperable size limit, tombstone retention, and historical DID verification.

## 6. Define Detached Hail Body V1

The body must exist before envelope submission. Its POC publication, canonical encoding, hashing, recipient-specific bearer authorization, shared storage, retrieval, caching, integrity, resource limits, and 30-day retention semantics are defined in `spec/bodies.md`.

Remaining body work is limited to shared security, envelope, delivery-state, and HTTP binding decisions referenced by that specification.

## 7. Define Hail Envelope V1

The compact, single-recipient envelope payload, grant and reply authorization modes, body descriptor, signature representation, validation order, timestamp rules, and replay behavior are defined in `spec/envelopes.md`.

The POC uses RFC 8785 canonical JSON in an RFC 7515 flattened JWS, signed with the sender DID's `#hail-messaging` key using the RFC 9864 `Ed25519` algorithm identifier.

Remaining envelope work is limited to shared DID-history, delivery-state, and HTTP binding decisions referenced by that specification.

## 8. Define The Delivery State Machine

The delivery states, acceptance checkpoint, authorization races, retry ownership, failure reasons, multiple-recipient behavior, and signed status snapshots are defined in `spec/delivery-state.md`.

Sender-visible states:

```text
accepted
on-hold
delivered
failed
cancelled
```

Acceptance fixes authorization and durably transfers body-processing responsibility to the recipient server. Completed delivery requires a verified body and durable message storage. Terminal state is reported with a signed, recipient-specific status update; aggregate campaign state remains local to the sender.

The distinction between generic HTTP receipt and authenticated Hail status, plus the terminal-status push and acknowledgement binding, is defined in `spec/http-binding.md`. Authenticated status query is deferred from v1.

## 9. Bind Operations To HTTPS

After operation semantics and state transitions are defined, bind them to HTTP. `spec/http-binding.md` defines envelope submission, body retrieval, grant publication, and terminal delivery-status push, including disclosure, retry, idempotency, and exact core wire behavior.

Current Hail service endpoint decisions:

```http
PUT  /hail/grants/{grant_id}
POST /hail/envelopes
GET  /hail/bodies/{digest}
PUT  /hail/deliveries/{envelope_digest}
```

`/hail/envelopes` is more precise than `/hail/inbox` because the receiving server initially accepts an envelope, not necessarily a completed inbox message.

`SubmitEnvelope` uses `POST {hail-service-base}/envelopes`. Replies reuse that operation because they are ordinary Hail Messages with a different authorization path. `RetrieveBody` uses `GET {hail-service-base}/bodies/{digest}`, with the exact 43-character unpadded base64url SHA-256 value as `{digest}`. `PublishGrantRevision` uses conditional `PUT {hail-service-base}/grants/{grant_id}` with the canonical lowercase UUIDv7 as `{grant_id}`. `PushDeliveryStatus` uses `PUT {hail-service-base}/deliveries/{envelope_digest}` with the signed envelope-payload digest as `{envelope_digest}`.

Body URLs should not be arbitrary URLs supplied by each envelope. Recipient-controlled fetching of arbitrary URLs introduces server-side request forgery risk. Body locations should be derived from authenticated discovery metadata or constrained to authenticated sender infrastructure.

## 10. Define The Security And Encoding Profile

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

V1 profile:

```text
Encoding: JSON
Canonicalization: RFC 8785 JCS
Signature: RFC 7515 flattened JWS with RFC 9864 Ed25519
Body digest: SHA-256
Transport: HTTPS
Body transfer compression: gzip
Signed JWS HTTP content coding: none
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

## 11. Build A Thin End-To-End Slice

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

## 12. Add Reply Capabilities

After grant-authorized delivery works, add:

- `reply.allowed`
- `reply.until`
- `authorization.reply_to`
- single-use reply-capability claims
- replyable sent-message index
- expired reply rejection
- unsolicited reply rejection
- continuous mutual consent tests

Replies should reuse the normal Hail Envelope delivery operation unless implementation evidence shows a need for separate transport.

## 13. Expand Safe Portable Text

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

## Cross-Cutting Risks

Detached-body security and resource risks are defined in `spec/bodies.md`. The remaining cross-cutting delivery risks are:

### Acceptance Semantics

Generic HTTP `202` receipt, Hail envelope acceptance, and completed delivery are distinct. A generic receipt makes no acceptance promise; acceptance transfers body-processing responsibility, and delivery requires durable verified message storage.

### Replay Protection

The authenticated sender DID and message ID form the idempotency key. Replay records are retained through `max(expires_at, body.available_until) + 300 seconds`; after that deadline the signed envelope is already expired and cannot become a new delivery.

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

The grant, body, envelope, delivery-state, and HTTP-binding specifications now define these object and behavioral semantics, including failures, retries, revocation races, privacy-preserving responses, exact core HTTP operations, and terminal-status retry duration. Remaining work concerns deferred production limits and later protocol features.
