# Hail Core Delivery

Status: Draft normative flow

This document defines one complete grant-authorized delivery of a Hail Message between independently operated sender and recipient servers.

The object-specific specifications define exact schemas and signatures, and [http-binding.md](http-binding.md) defines the core HTTPS operations. This document connects those decisions into one normative protocol flow while retaining explicit production questions that remain unresolved.

## Scope

This core flow covers one sender delivering one message to one recipient under an existing Hail Grant. Connections and shared conversations reuse the delivery machinery with separately specified authorization rules.

It includes:

- identity and server discovery prerequisites
- grant lookup and authorization
- Hail Envelope submission
- sender authentication and signature verification
- detached Hail Body retrieval and verification
- completed delivery
- rejection and transient failure behavior
- retries, idempotency, and replay protection
- grant revocation races

The flow supports all three mandatory Safe Portable Text profiles (`spt-1`,
`spt-2`, and `spt-3`) defined in [bodies.md](bodies.md). Plain text is a valid
choice, not the provider conformance baseline by itself.

## Actors

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
- Current address-to-DID and DID-to-service mappings are public. Unknown or unrelated senders must not be able to use delivery behavior to probe grants, reply capabilities, replay records, message state, local-account state, recipient policy, cache state, or user activity.

## Core Delivery Requirements

### 1. Delivery Identity

Decisions:

- A DID is the stable identity of a sender.
- A DID is the stable identity of a recipient.
- Hail Grants bind a grantor DID to a grantee DID.
- Hail Envelopes identify `from` and `to` using DIDs.
- Human-readable Hail addresses are aliases that resolve to DIDs; they are not durable protocol identities.
- Hail addresses use the case-insensitive lowercase canonical syntax defined by the Address Binding profile.
- Address-to-DID association uses a signed version-2 Hail Address Binding discovered through the address domain. The binding has no expiration timestamp; current domain publication, current DID identity-key verification, and bounded discovery caches determine whether it can be used.
- Verification requires the address domain to publish the binding and a DID-authorized key to sign it.
- Hail addresses are not written to PLC `alsoKnownAs`; address verification uses Address Bindings.
- A DID remains stable when its owner changes hosting providers. Grants, message relationships, and other durable records continue to reference the same DID.
- The current hosting endpoint is delegated infrastructure discovered through the DID. It is not the sender's or recipient's identity.
- Provider-issued and custom-domain identities use `did:plc`.
- Prospective recipients retrieve one DID-scoped, `#hail-messaging`-signed Sender Profile containing the sender's category manifest.
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
  -> did:plc:aaaaaaaaaaaaaaaaaaaaaaaa
  -> https://current-provider.example/hail
```

If Alice migrates providers, a PLC operation changes the service endpoint and the `#hail-messaging` operational key. Her DID and existing grants do not change.

For domain-backed senders, domain control verifies that the human-readable sender address is an authorized alias for the sender DID. The provider operating the endpoint does not gain the sender's domain identity merely by hosting it.

Identity method:

```text
did:plc
```

This policy avoids mandatory domain costs for ordinary users. Managed personal domains may be offered as an optional paid provider service, but they are not required for a portable Hail identity because a provider-issued address resolves to a stable `did:plc` identity.

Address binding is specified in [address-binding.md](address-binding.md).

Required DID entries and key roles are specified in [did-profile.md](did-profile.md).

The current reference public resolver's reader selection, audit validation,
freshness, retained evidence and fail-closed fallback are specified in
[PLC read evidence](plc-read-evidence.md). It uses bounded fresh reads without a
cross-call cache. This is a named reference policy, not a requirement to reproduce
its database or deployment topology. General historical-object admission and
reconciliation after PLC recovery/nullification remain unresolved; current reader
validation is not itself proof of when an old Hail object was accepted.

### 2. Preconditions And Discovery

Before grant creation, the recipient verifies the sender's Address Binding and current signed Sender Profile, displays the verified address separately from profile metadata, and selects only offered categories or uncategorized delivery. Before initial delivery, a sender resolves a human-readable recipient address through its signed Address Binding when necessary, then resolves the recipient DID's current `#hail` service and keys. Routine federation between known DIDs resolves the DID directly and does not re-resolve a human-readable address on every operation.

The DID profile distinguishes the POC cache rules from the current strict-public
fresh-read policy. Canonical service-base URLs, endpoint refresh, redirect
prohibition and provider-migration behavior are defined in
[did-profile.md](did-profile.md) and [http-binding.md](http-binding.md). Address
Binding cache, refresh and safe-fetch behavior is defined in
[address-binding.md](address-binding.md). The reference policy also defines
owner-authorized cutover and recovery monitoring; a general historical-authority
policy still needs review. These are not unresolved core HTTPS operation bindings.

### 3. Grant Preconditions

Hail Grant semantics are defined in [grants.md](grants.md).

For core delivery:

- The recipient's local latest grant revision is authoritative.
- Every grant-authorized envelope includes a UUIDv7 `authorization.grant_id` as a lookup hint.
- The grant ID is not a bearer capability.
- The grantor and grantee are exact DIDs.
- v0 permits one active grant per grantor/grantee pair.
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

Hail Envelope construction, grant and reply authorization, the exact body descriptor, deterministic Hail CBOR, tagged COSE_Sign1, RFC 9864 Ed25519 signatures, timestamps, and replay behavior are defined in [envelopes.md](envelopes.md).

For core delivery:

- Each envelope has exactly one sender DID and one recipient DID.
- The sender-scoped UUIDv7 `message_id` forms the idempotency key with the authenticated sender DID.
- `created_at` and `expires_at` are required.
- Every semantic payload field and the signing key ID are protected by COSE.
- Grant-authorized delivery carries `authorization.grant_id`; reply delivery uses a prior message's signed reply permission.
- Current envelopes are not HTTP-compressed and never include arbitrary body or reply URLs.

### 6. Envelope Submission

- `SubmitEnvelope` submits one envelope per synchronous HTTPS exchange.
- HTTP receipt, Hail acceptance, and completed delivery are distinct.
- An unknown or unauthenticated sender receives a generic HTTP `202` response that reports only the `received` submission outcome.
- An authenticated sender with a current or previous relationship may receive a detailed current result when privacy permits.
- Terminal delivery status is reported asynchronously with a signed status snapshot.
- The current alpha requires support for complete envelope representations through 16384 bytes, as defined in [envelopes.md](envelopes.md).
- v0 requires no transport authentication in addition to HTTPS and the envelope COSE signature. Private deployment controls carry no RACR protocol semantics and never replace COSE verification.
- The body retrieval location is derived from authenticated sender discovery rather than supplied by the envelope.
- Signed delivery-status correlation uses the parties, message ID, envelope digest
  and status revision. Provider-local tracing is implementation policy; no Hail
  trace identifier or unauthenticated status-query handle is defined.

Bulk submission remains deferred. Submission outcomes, disclosure, timing, retries, and idempotency are defined in [http-binding.md](http-binding.md).

### 7. Recipient Validation Order

The normative validation order is defined in [envelopes.md](envelopes.md). It permits a cheap preliminary authorization lookup using claimed fields, requires externally uniform unauthenticated rejection, verifies the signature before state mutation or body retrieval, then atomically reserves idempotency and reply-capability state.

In this Grant-authorized flow, authorization is fixed by atomic acceptance. Envelope expiration is re-checked before completed delivery. Permanent and retryable body failures and delivery states are defined in [delivery-state.md](delivery-state.md).

### 8. Detached Body Retrieval

The recipient pulls from the authenticated sender Hail service using bearer authorization carried in the signed envelope, as defined in [bodies.md](bodies.md). Recipient-scoped caching and underlying digest-based storage deduplication are allowed. v0 accepts no envelope-supplied URLs or redirects.

Body fetches are server delivery operations, not user open or read signals.

### 9. Delivery Completion

Acceptance, completed delivery, terminal failure, cancellation, and signed status reporting are defined in [delivery-state.md](delivery-state.md).

Acceptance durably fixes authorization and queues body processing. Delivery completes only when the recipient server has verified and durably stored the body and recipient-specific message record. It does not imply client synchronization, display, open, or read.

### 10. Idempotency And Replay Protection

Idempotency and replay protection are defined in [envelopes.md](envelopes.md). The authenticated sender DID plus `message_id` is the key. Identical deterministic payloads reuse existing state, conflicting payloads are rejected, concurrent submissions are serialized, IDs are never reused, and body digest has no role in message identity.

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

The generic receipt uses `202` with `application/json`; an authenticated successful result uses `200` with an `application/cose; cose-type="cose-sign1"` signed delivery-status snapshot. Detailed envelope error status codes and the v0 RFC 9457 profile are fixed by the HTTP binding. The error media type is `application/problem+json`.

### 14. Resource And Abuse Limits

- The current envelope support floor is 16384 transmitted octets.
- The current body ceiling is 1048576 uncompressed octets, supported by every provider.
- Body receivers support identity and gzip; gzip emission is optional.
- Compressed bodies are bounded by 2097152 transmitted octets and the signed
  uncompressed size, rather than a compression-ratio heuristic.
- The closed SPT schemas define allowed blocks, list levels, marks, and asset
  dimensions. Common normative CBOR depth, item, collection and string budgets,
  including their counting rules, are defined in [encoding](encoding.md#current-cbor-budgets).
- Retrieval concurrency and rate-limit values are recipient/provider policy.
  Rate-limit disclosure and `Retry-After` behavior obey the HTTP binding; a Grant
  is not a promise of unlimited capacity.
- Grant-enforced frequency/size selectors are not part of the current Grant schema.
- After acceptance, temporary local resource exhaustion uses `on-hold` with
  `receiver-resource-constrained`, within the existing delivery deadline. Before
  acceptance, temporary failures follow the HTTP binding's disclosure rules.

Limits should be defined in terms of both required interoperability floors and recipient-configurable ceilings.

### 15. Auditability And Receipts

Retain the exact signed Grant/revision and envelope representations, authorization
decision evidence, accepted-state/replay history and signed delivery-status
correlations required by the object specifications. The strict-public reference
provider retains linked PLC resolution and action evidence; the current account
history formats carry those records through transfer. See
[PLC evidence](plc-read-evidence.md), [account history](account-history.md), and
[delivery state](delivery-state.md). Retention of bytes is not a general historical
authority algorithm; acceptance across recovered/nullified histories remains open.

HTTP receipt is not evidence of Hail acceptance or delivery. Signed server delivery
status attests server processing, not client synchronization, display, opening or
reading. Body retrieval must not become a user-activity signal. Local unread state
and conversation activity/lease renewal are not federated read receipts.

## Questions That Can Be Deferred

This inventory distinguishes absent protocol features from functionality already
provided by extensions or local APIs. Being outside this Grant-authorized flow
does not mean a feature is unimplemented.

| Topic | Current status and boundary |
| --- | --- |
| Rich text and publisher layouts | `spt-1`, `spt-2`, and `spt-3` are mandatory now. Additional publisher layout nodes remain future work; see [bodies](bodies.md). |
| Person-to-person connections | Implemented through invitation review, identity-signed confirmation, admission and disconnect. Connection-authorized delivery and threaded replies are specified in [envelopes](envelopes.md); see [connection consent](connection-auth.md) and [federation](connection-federation.md). This is not an unsolicited inbox-request channel. |
| Group messages | Implemented as fixed-roster shared conversations, per-recipient v4 envelopes, Reply all, leave, expiry and creator revival; see [shared conversations](shared-conversations.md). Multiple recipients inside a single envelope are not supported. |
| Bulk submission | Local private/shared send batches fan out to individual envelopes. A bulk provider-to-provider envelope endpoint and campaign-level federation objects remain undefined. |
| Connection/conversation portability | Implemented through authenticated handover and current snapshot/checkpoint formats, with fencing and pending-work constraints; see [connection portability](connection-portability.md). Arbitrary export/import does not grant live authority. |
| Attachments | Bundled bounded PNG header assets exist. General file attachments, detached attachment retrieval, and their delivery/retention rules remain deferred; see [assets](assets.md). |
| End-to-end encryption | Not defined. HTTPS, COSE signatures and local key encryption do not provide end-to-end message confidentiality. |
| Read/open receipts | Not defined as federation operations. Local read state and server delivery receipts are distinct. |
| Aggregate analytics | No campaign/analytics federation protocol. Local reporting is provider/client policy and cannot bypass activity-disclosure rules. |
| Unsolicited communication | Unsolicited message delivery is not authorized. Public discovery, Grant publication and deliberate invitation review are distinct, bounded operations. A general unsolicited contact-request feature remains undefined. |
| Email bridges | No interoperable bridge profile. Onboarding/notification email is not a Hail message bridge. |
| Global directories | Address/DID resolution and signed Sender Profiles exist. Global search, recommendation and directory services are application concerns, not required core protocol services; see [sender profile](sender-profile.md). |
| Encoding negotiation | Not defined. The fixed CBOR/COSE profile and separately defined transfer representations are not negotiated alternatives; see [encoding](encoding.md). |
| Organization verification | Domain-backed address verification exists; organizational attestations beyond domain control remain undefined. |

These deferred extensions need explicit schemas, authority and privacy rules
before being advertised as supported. They do not block review of the current core.

## HTTPS Binding Status

Sender Profile retrieval, envelope submission, body retrieval, grant publication, terminal delivery-status push and acknowledgement, and terminal-status retry behavior are bound in [http-binding.md](http-binding.md). Authenticated status query is deferred from v0. No core v0 HTTPS binding decision remains open in this specification.
