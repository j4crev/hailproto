# Hail Core Delivery

Status: Draft normative flow

This document defines one complete grant-authorized delivery of a Hail Message between independently operated sender and recipient servers.

The object-specific specifications define exact schemas and signatures, and [http-binding.md](http-binding.md) defines the core HTTPS operations. This document connects those decisions into one normative protocol flow while retaining explicit production questions that remain unresolved.

## Scope

The first core flow should cover one sender delivering one message to one recipient under an existing Hail Grant.

It should include:

- identity and server discovery prerequisites
- grant lookup and authorization
- Hail Envelope submission
- sender authentication and signature verification
- detached Hail Body retrieval and verification
- completed delivery
- rejection and transient failure behavior
- retries, idempotency, and replay protection
- grant revocation races

The first flow should use a plain-text Safe Portable Text body. Rich SPT nodes are outside this specification.

## Proposed Actors

- **Recipient**: The person or organization receiving a Hail Message.
- **Recipient client**: Software the recipient uses to manage grants and read messages.
- **Recipient server**: The server that enforces the recipient's grants and stores accepted messages.
- **Sender**: The DID authorized by a Hail Grant. A sender's human-readable Hail address is a domain-verified alias for that DID.
- **Sender service**: Software that composes or schedules a message.
- **Sender server**: The server that signs envelopes, submits them, and serves detached bodies.

## Core Invariants

- Only the recipient or an authorized recipient client can create a grant.
- The recipient server is authoritative when deciding whether delivery is currently permitted.
- A sender must be authenticated even when a matching grant exists.
- The receiving server must reject unauthorized delivery before body transfer.
- A body must match the hash and size declared by its authenticated envelope.
- Replaying an accepted envelope must not create another message.
- Revocation must take effect without sender cooperation.
- Unknown senders must not be able to use delivery errors to probe recipient existence.

## Questions Required For The First Flow

### 1. Delivery Identity

Decisions:

- A DID is the stable identity of a sender.
- A DID is the stable identity of a recipient.
- Hail Grants bind a grantor DID to a grantee DID.
- Hail Envelopes identify `from` and `to` using DIDs.
- Human-readable Hail addresses are aliases that resolve to DIDs; they are not durable protocol identities.
- Hail addresses are case-insensitive and must be normalized before resolution or comparison.
- Address-to-DID association uses a signed, expiring Hail Address Binding discovered through the address domain.
- Verification requires the address domain to publish the binding and a DID-authorized key to sign it.
- Hail does not require DID `alsoKnownAs` entries for address verification.
- A DID remains stable when its owner changes hosting providers. Grants, message relationships, and other durable records continue to reference the same DID.
- The current hosting endpoint is delegated infrastructure discovered through the DID. It is not the sender's or recipient's identity.
- Bring-your-own-domain identities provisionally use `did:web`.
- Provider-issued identities provisionally use `did:plc`.
- Hail Grants and Hail Address Bindings are signed by the DID's `#hail-identity` key.
- Hail Envelopes and routine server objects are signed by the DID's `#hail-messaging` key.
- The DID's current server is the endpoint of its `#hail` service with type `HailMessaging`.

The intended relationship is:

```text
human address -> DID -> current Hail service endpoint and verification keys
```

Example:

```text
alice@example.net
  -> did:plc:examplealiceidentifier
  -> https://current-provider.example/hail
```

If Alice migrates providers, the DID document changes the final service endpoint and the `#hail-messaging` operational key. Her DID and existing grants do not change.

For domain-backed senders, domain control verifies that the human-readable sender address is an authorized alias for the sender DID. The provider operating the endpoint does not gain the sender's domain identity merely by hosting it.

Method policy:

```text
Bring your own domain: did:web
Provider-issued identity: did:plc
```

This policy avoids mandatory domain costs for ordinary users. Managed personal domains may be offered as an optional paid provider service, but they are not required for a portable Hail identity because a provider-issued address resolves to a stable `did:plc` identity.

Address binding is specified in [address-binding.md](address-binding.md).

Required DID entries and key roles are specified in [did-profile.md](did-profile.md).

Questions still to resolve:

- What exact lowercase and Unicode normalization algorithm applies to Hail addresses?
- Are internationalized local parts and domains allowed in v1?
- Does one domain support multiple addresses resolving to separate DIDs?
- Can one DID have multiple current Hail addresses?
- Which address, if any, is included as display metadata in grants and envelopes?
- What cache and historical-version rules apply to DID resolution?
- Will the public PLC directory accept non-AT Protocol production identities and Hail-specific entries?
- What resolver mirrors, audit verification, or fallback behavior does Hail require for `did:plc`?

### 2. Preconditions And Discovery

Before initial delivery, a sender resolves a human-readable address through its signed Address Binding when necessary, then resolves the recipient DID's current `#hail` service and keys. Routine federation between known DIDs resolves the DID directly and does not re-resolve a human-readable address on every operation.

The POC DID cache lifetime, forced key and endpoint refresh, canonical service-base URLs, redirect prohibition for federation operations, and provider-migration behavior are defined in [did-profile.md](did-profile.md) and [http-binding.md](http-binding.md). Address Binding cache, refresh, and discovery-redirect behavior and production DID finality remain open in their respective identity specifications; they are not unresolved HTTPS operation-binding questions.

### 3. Grant Preconditions

Hail Grant semantics are defined in [grants.md](grants.md).

For core delivery:

- The recipient's local latest grant revision is authoritative.
- Every grant-authorized envelope includes a UUIDv7 `authorization.grant_id` as a lookup hint.
- The grant ID is not a bearer capability.
- The grantor and grantee are exact DIDs.
- V1 permits one active grant per grantor/grantee pair.
- Scope, status, expiration, recipient policy, and authenticated sender identity are checked before delivery.
- Sender acknowledgment is not required for local grant activation or revocation.

### 4. Body Publication

Detached Hail Body semantics are defined in [bodies.md](bodies.md).

For core delivery:

- The immutable body exists before envelope submission.
- The envelope signs its digest, uncompressed size, media type, profile, availability commitment, and recipient-specific access authorization.
- The recipient server pulls or reuses the body only after envelope authorization.
- Byte-identical bodies may share sender-side and underlying recipient-side storage, but retrieval-cache reuse follows recipient-and-sender provenance rules.
- Every envelope commits to at least 30 days of body availability.

### 5. Hail Envelope Construction

Hail Envelope construction, grant and reply authorization, the exact body descriptor, RFC 8785 canonicalization, RFC 7515 JWS representation, RFC 9864 Ed25519 signatures, timestamps, and replay behavior are defined in [envelopes.md](envelopes.md).

For core delivery:

- Each envelope has exactly one sender DID and one recipient DID.
- The sender-scoped UUIDv7 `message_id` forms the idempotency key with the authenticated sender DID.
- `created_at` and `expires_at` are required.
- Every semantic payload field and the signing key ID are protected by the JWS.
- Grant-authorized delivery carries `authorization.grant_id`; reply delivery uses a prior message's signed reply permission.
- The POC envelope is not HTTP-compressed and never includes arbitrary body or reply URLs.

### 6. Envelope Submission

- `SubmitEnvelope` submits one envelope per synchronous HTTPS exchange.
- HTTP receipt, Hail acceptance, and completed delivery are distinct.
- An unknown or unauthenticated sender receives a generic HTTP `202` response that reports only the `received` submission outcome.
- An authenticated sender with a current or previous relationship may receive a detailed current result when privacy permits.
- Terminal delivery status is reported asynchronously with a signed status snapshot.
- The POC requires support for complete envelope representations through 16384 bytes, as defined in [envelopes.md](envelopes.md).
- V1 requires no transport authentication in addition to HTTPS and the envelope JWS. Private deployment controls carry no Hail protocol semantics and never replace JWS verification.
- The body retrieval location is derived from authenticated sender discovery rather than supplied by the envelope.
- What request identifier supports tracing without becoming part of message identity?

Bulk submission remains deferred. Submission outcomes, disclosure, timing, retries, and idempotency are defined in [http-binding.md](http-binding.md).

### 7. Recipient Validation Order

The normative validation order is defined in [envelopes.md](envelopes.md). It permits a cheap preliminary authorization lookup using claimed fields, requires externally uniform unauthenticated rejection, verifies the signature before state mutation or body retrieval, then atomically reserves idempotency and reply-capability state.

Authorization is fixed by atomic acceptance. Envelope expiration is re-checked before completed delivery. Permanent and retryable body failures and delivery states are defined in [delivery-state.md](delivery-state.md).

### 8. Detached Body Retrieval

The recipient pulls from the authenticated sender Hail service using bearer authorization carried in the signed envelope, as defined in [bodies.md](bodies.md). Recipient-scoped caching and underlying digest-based storage deduplication are allowed. V1 accepts no envelope-supplied URLs or redirects.

Body fetches are server delivery operations, not user open or read signals.

### 9. Delivery Completion

Acceptance, completed delivery, terminal failure, cancellation, and signed status reporting are defined in [delivery-state.md](delivery-state.md).

Acceptance durably fixes authorization and queues body processing. Delivery completes only when the recipient server has verified and durably stored the body and recipient-specific message record. It does not imply client synchronization, display, open, or read.

### 10. Idempotency And Replay Protection

Idempotency and replay protection are defined in [envelopes.md](envelopes.md). The authenticated sender DID plus `message_id` is the key. Identical canonical payloads reuse existing state, conflicting payloads are rejected, concurrent submissions are serialized, IDs are never reused, and body digest has no role in message identity.

### 11. Retry Behavior

The recipient server owns body-retrieval backoff, jitter, concurrency, and hold scheduling within the signed deadline. Retryable and permanent reason codes, `Retry-After` handling, and sender-unreachable versus body-failure behavior are defined in [delivery-state.md](delivery-state.md).

### 12. Revocation And Race Conditions

Grant changes and envelope acceptance are linearized against local authoritative state. If revocation commits first, the envelope is rejected. If acceptance commits first, body processing continues and later revocation affects only future envelopes. Neither revocation nor delivery-state changes retroactively delete delivered messages.

Grant notification and disclosure behavior remain defined in [grants.md](grants.md). The acceptance race is defined in [delivery-state.md](delivery-state.md).

### 13. Failure Responses And Privacy

Pre-acceptance envelope results remain distinct from the delivery states in [delivery-state.md](delivery-state.md). The closed submission-outcome set is:

```text
received
accepted
duplicate
message-id-conflict
invalid-envelope
unauthorized
message-expired
rate-limited
temporarily-unavailable
```

Before a sender is authenticated with a current or previous relationship, protected failures return the same generic `202`/`received` response under a common measured bounded response schedule. The generic response contains no query handle or acceptance promise. Eligible authenticated senders may receive detailed current results; human-readable `detail` may mention already-known causes such as `grant-revoked` and `category-not-granted`, but clients do not parse it for protocol behavior. Every explicit unsuccessful HTTP response uses RFC 9457 Problem Details, but its fields disclose no more than the caller's tier permits. Protected failures concealed by the generic receipt are not exposed as Problem Details responses. Safe transport errors, detailed disclosure, and retry classifications are defined in [http-binding.md](http-binding.md).

The generic receipt uses `202` with `application/json`; an authenticated successful result uses `200` with an `application/jose+json` signed delivery-status snapshot. Detailed envelope error status codes and the v1 RFC 9457 profile are fixed by the HTTP binding. The error media type is `application/problem+json`.

### 14. Resource And Abuse Limits

- What envelope size must all servers accept?
- What body size must all servers accept?
- What compression algorithms are permitted?
- What maximum compression ratio is allowed?
- What Safe Portable Text nesting depth, node count, and string sizes are allowed?
- How many in-progress body retrievals may one sender cause?
- What rate limits may recipients impose on granted senders?
- Can grants contain frequency limits that are protocol-enforced?
- How should a recipient respond when locally out of storage?

Limits should be defined in terms of both required interoperability floors and recipient-configurable ceilings.

### 15. Auditability And Receipts

- What evidence does the sender retain that delivery was granted?
- What evidence does the recipient retain about sender authentication and delivery?
- How are delivery receipts distinguished from read receipts?
- Does the core flow expose any user activity beyond server acceptance?

HTTP receipt is not evidence of Hail acceptance or delivery. Signed server delivery status is defined in [delivery-state.md](delivery-state.md). Read and open receipts remain excluded from core delivery.

## Questions That Can Be Deferred

These issues should not block the first grant-authorized delivery:

- rich Safe Portable Text nodes
- end-to-end encryption
- attachments beyond declared body assets
- multiple recipients in one envelope
- bulk envelope submission
- read/open receipts
- aggregate analytics
- person-to-person contact requests
- unsolicited communication
- email bridges
- global directories
- additional DID methods beyond `did:web` and `did:plc`
- custom encoding negotiation
- organization verification beyond domain control

The initial schemas should avoid making these features impossible, but they do not need complete v1 behavior yet.

## HTTPS Binding Status

Envelope submission, body retrieval, grant publication, terminal delivery-status push and acknowledgement, and terminal-status retry behavior are bound in [http-binding.md](http-binding.md). Authenticated status query is deferred from v1. No core v1 HTTPS binding decision remains open in this specification.
