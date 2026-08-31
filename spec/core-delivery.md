# Hail Core Delivery

Status: Draft decision checklist

This document will define one complete grant-authorized delivery of a Hail Message between independently operated sender and recipient servers.

Its first purpose is to identify and resolve the behavioral questions that must be answered before specifying exact schemas, signatures, or HTTP endpoints. Once resolved, this document should become a normative protocol flow.

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

If Alice migrates providers, only the final service endpoint changes. Her DID and existing grants do not.

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

- What information must the sender know before attempting delivery?
- How does the sender discover the current recipient server?
- How does the recipient server discover and authenticate the sender's signing keys?
- Is discovery performed for every delivery, cached, or refreshed only after failure?
- What cache lifetime and refresh behavior apply?
- What happens when DNS and `/.well-known/hail` disagree?
- How does a DID delegate Hail hosting to a provider through its service endpoint?
- How is a cached Address Binding refreshed during delivery discovery?
- Can discovery endpoints redirect, and if so, under what restrictions?
- How does delivery behave during provider migration or stale discovery caches?

### 3. Grant Preconditions

Hail Grant semantics are defined in [grants.md](grants.md).

For core delivery:

- The recipient's local latest grant revision is authoritative.
- Every grant-authorized envelope includes a UUIDv7 `grant_id` as a lookup hint.
- The grant ID is not a bearer capability.
- The grantor and grantee are exact DIDs.
- V1 permits one active grant per grantor/grantee pair.
- Scope, status, expiration, recipient policy, and authenticated sender identity are checked before delivery.
- Sender acknowledgment is not required for local grant activation or revocation.

### 4. Body Publication

- Must the body exist before its envelope is submitted?
- Is the body shared among recipients or unique per recipient?
- How is its content hash computed: encoded bytes, canonical document bytes, compressed bytes, or uncompressed bytes?
- Does the envelope declare compressed size, uncompressed size, or both?
- How is body media type/profile declared?
- Must the sender retain the exact body bytes originally hashed?
- How long must the body remain retrievable after envelope submission?
- Can a sender proactively upload the body after envelope acceptance instead of waiting for a fetch?

Recommended starting direction: hash the exact uncompressed encoded body bytes, declare their uncompressed size and media type, and treat compression as a transport concern outside the content hash.

### 5. Hail Envelope Construction

- Which fields are required in the first envelope?
- Is one envelope always addressed to exactly one recipient?
- Is `message_id` globally unique, sender-scoped, or recipient-scoped?
- Is the ID random, time-sortable, or content-derived?
- Are both creation and expiration timestamps required?
- Does the envelope include a grant ID?
- Does it include category and protocol-defined message type?
- Which preview metadata belongs in the envelope rather than the body?
- Which fields are covered by the signature?
- Is the signature embedded or carried in an outer wrapper?
- Does signing happen before or after compression?

Recommended starting direction: one envelope per recipient, a sender-generated 128-bit or stronger random message ID, and a signature over every semantic envelope field.

### 6. Envelope Submission

- What abstract operation submits an envelope?
- Is submission synchronous or asynchronous?
- What maximum envelope size must every conforming recipient support?
- What transport authentication is required in addition to the envelope signature, if any?
- Can one request contain multiple envelopes for recipients on the same server?
- How does the sender identify the body retrieval location without supplying an arbitrary URL?
- What request identifier supports tracing without becoming part of message identity?

Recommended starting direction: submit one envelope per operation in the first profile and derive body retrieval from authenticated sender discovery rather than an envelope-provided URL.

### 7. Recipient Validation Order

What exact order should the recipient server use?

Candidate order:

1. Enforce transport and envelope byte limits.
2. Decode the minimal envelope structure.
3. Validate required fields and inexpensive syntax constraints.
4. Perform a preliminary local grant lookup using claimed sender, recipient, and category.
5. Return a privacy-preserving rejection if no candidate grant exists.
6. Resolve or load the authenticated sender key.
7. Verify the envelope signature.
8. Confirm the authenticated identity exactly matches the candidate grant.
9. Re-check grant status, scope, and expiration.
10. Check message ID for duplicate or replay delivery.
11. Check timestamps, body size, body type, and server policy.
12. Reserve an idempotent pending-delivery record.
13. Accept the envelope for body retrieval.

Questions:

- Can untrusted claimed fields safely be used for preliminary grant lookup?
- Which checks must occur before cryptographic verification?
- Should replay detection occur before or after signature verification?
- Should the grant be re-checked after potentially slow key discovery?
- Which failures are permanent, and which are retryable?
- At what step is a pending delivery record created?

### 8. Detached Body Retrieval

- Does the recipient pull the body, does the sender push it after acceptance, or must both modes exist?
- How is the body request authenticated and authorized?
- Can a recipient fetch a shared campaign body without revealing which user received it?
- Does the body server learn when the recipient reads the message, or only when its server retrieves it?
- May recipient servers proxy, batch, or cache body retrieval?
- How are redirects handled?
- How are SSRF and DNS rebinding prevented?
- What compressed and uncompressed limits apply?
- How are decompression bombs detected?
- What happens when the retrieved hash, size, or media type differs from the envelope?
- May the recipient retry retrieval from another authorized sender endpoint?

Recommended starting direction: recipient server pull, with the body endpoint derived from authenticated sender discovery; no arbitrary body URLs or redirects in the first profile.

### 9. Delivery Completion

- What does envelope acceptance mean?
- At what point may the sender claim the message was delivered?
- Is delivery complete after the body is retrieved and hash-verified, or only after durable storage?
- Does client synchronization affect server-to-server delivery status?
- How does the recipient report final completion after asynchronous body retrieval?
- Is a delivery status resource required?
- Does the sender receive a callback, poll status, or rely on a synchronous transfer?
- How long must delivery status remain queryable?

Recommended starting definition: delivery is complete when the recipient server has verified and durably accepted the envelope and body. Delivery does not imply that the user opened or read the message.

### 10. Idempotency And Replay Protection

- What uniquely identifies the delivery attempt?
- What happens when the same signed envelope is submitted twice?
- Must the second request return the original result?
- Can a sender retry with the same message ID but different envelope bytes?
- How long must recipient servers retain deduplication records?
- Can an expired message ID be reused?
- How are concurrent duplicate submissions serialized?
- Does a shared body hash have any role in message identity?

Recommended starting direction: the sender identity plus `message_id` forms the idempotency key; identical retries return the existing state, while different signed content under the same key is a permanent conflict.

### 11. Retry Behavior

- Which failures should the sender retry?
- What backoff and jitter expectations apply?
- May a recipient provide `Retry-After` guidance?
- When should stale recipient discovery be refreshed?
- When should stale sender key discovery be refreshed?
- How long may a delivery remain pending?
- What happens if the envelope was accepted but the sender removes the body too early?
- When may the sender permanently abandon delivery?

The specification should distinguish protocol retry rules from implementation scheduling choices.

### 12. Revocation And Race Conditions

- What happens if a grant is revoked while an envelope is being validated?
- What happens if revocation occurs after envelope acceptance but before body retrieval?
- What happens if revocation occurs after complete delivery?
- Is a message already delivered retained, hidden, or deleted?
- Is the sender proactively notified of revocation?
- If not, what response does the sender receive on its next attempt?
- How does the recipient prove a sender previously had a relationship before returning a detailed rejection?

Recommended starting direction: re-check grant status immediately before committing completed delivery. Revocation prevents incomplete deliveries but does not retroactively delete already delivered messages.

### 13. Failure Responses And Privacy

- Which failure classes must be distinguishable to an authenticated, previously granted sender?
- What generic response is returned to unknown senders?
- Can responses reveal whether a recipient address exists?
- Can timing differences reveal grant existence before signature verification?
- Should invalid signatures and unknown keys be distinguishable?
- How are malformed, unauthorized, expired, oversized, duplicate, and rate-limited requests represented?
- Which errors are safe to record in sender-facing logs?

Candidate semantic result classes:

```text
accepted-pending-body
delivered
duplicate
unauthorized
grant-revoked
category-not-granted
invalid-signature
invalid-envelope
message-expired
body-too-large
temporarily-unavailable
rate-limited
delivery-failed
```

HTTP status codes should be assigned only after these semantic results are settled.

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
- Is the final delivery receipt signed?
- Is a transport response sufficient for the first version?
- How are delivery receipts distinguished from read receipts?
- Does the core flow expose any user activity beyond server acceptance?

Recommended starting direction: define server delivery confirmation but exclude read/open receipts from the core delivery flow.

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

## First Decisions To Make

The questions should be resolved in this order:

1. Body publication and hashing rules.
2. Minimum Hail Envelope fields.
3. Recipient validation order.
4. Body retrieval authorization and location.
5. Meaning of envelope acceptance and completed delivery.
6. Idempotency, replay, and retry behavior.
7. Revocation races.
8. Semantic failure results.
9. HTTP binding.
10. Encoding and signature profile.

The next topic to settle is detached Hail Body publication, hashing, retrieval, and retention semantics.
