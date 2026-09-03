# Hail Delivery State

Status: Draft

This document defines the Hail delivery state machine, the meaning of envelope acceptance and completed delivery, body-retrieval failure classes, retry ownership, per-recipient status, and signed delivery-status updates.

Envelope validation and idempotency are defined in [envelopes.md](envelopes.md). Detached body retrieval and integrity validation are defined in [bodies.md](bodies.md). Grant lifecycle rules are defined in [grants.md](grants.md).

## Core Rules

- Delivery state belongs to one recipient-specific Hail Envelope.
- `accepted` means the envelope is authenticated, authorized, policy-compliant, and durably queued by the recipient server.
- Acceptance fixes delivery authorization for that envelope.
- Grant restriction, expiration, or revocation after acceptance does not cancel the accepted envelope.
- `delivered` means the body and message record are verified and durably stored by the recipient server.
- Delivery does not mean that a recipient client synchronized, displayed, opened, or read the message.
- The recipient server owns body-retrieval scheduling and retry mechanics within protocol deadlines.
- Retryable operational details are represented separately from terminal delivery state.
- Every terminal state is immutable.
- Delivery updates are per recipient, signed, ordered, and idempotent.

## Sender-Visible States

V1 defines five states:

```text
accepted
on-hold
delivered
failed
cancelled
```

Internal implementation states such as `retrieving-body`, `verifying-body`, or `retry-scheduled` are not protocol states and need not be exposed to the sender.

### `accepted`

The recipient server has:

1. Validated the envelope schema and signature.
2. Authenticated the exact sender DID and `#hail-messaging` key.
3. Confirmed the exact recipient DID is local.
4. Confirmed a matching grant or reply authorization.
5. Checked category scope, envelope timestamps, body limits, and recipient policy.
6. Reserved the envelope idempotency key and any reply-capability claim.
7. Durably stored the envelope and responsibility for body processing.

Acceptance is a commitment to attempt body acquisition and completion under this specification. It is not a promise that body retrieval will succeed.

An implementation may retrieve and verify a locally cached body during the submission request. The logical `accepted` transition still occurs before `delivered`, even if the sender observes only the final state.

### `on-hold`

The envelope remains accepted, but delivery cannot currently progress because of a retryable condition. The recipient server retains responsibility and has not reached a terminal result.

An `on-hold` update includes a retryable reason and `retry_at` guidance. The timestamp reports current scheduling intent, not a promise to issue a request at an exact instant.

The recipient may resume retrieval without publishing another intermediate update. The next externally visible state may therefore be `delivered`, `failed`, or `cancelled`.

### `delivered`

The recipient server has:

1. Retrieved the detached body or selected an already verified local copy.
2. Verified uncompressed size, SHA-256 digest, media type, profile, canonical bytes, and SPT schema.
3. Durably stored the body or a durable reference to the verified content-addressed copy.
4. Durably stored the recipient-specific message record and its accepted envelope.

Client synchronization is not required. A cached body with matching recipient-and-sender provenance may complete a later delivery to that same recipient without another network fetch.

`delivered` is terminal.

### `failed`

The recipient server cannot complete delivery because of a permanent failure or because a retryable condition outlived the delivery deadline.

A `failed` update includes one terminal reason from [Failure And Hold Reasons](#failure-and-hold-reasons).

`failed` is terminal. Retrying the same envelope returns the stored failure. A sender that is still authorized may construct a new envelope with a new message ID and new delivery deadline.

### `cancelled`

The recipient or recipient-server operator intentionally terminates an accepted but incomplete delivery independently of automatic grant revocation.

Cancellation is not the normal result of a later grant change. It is an explicit local action, such as a recipient cancelling queued work or an administrator terminating a delivery during incident response.

A `cancelled` update includes `recipient-cancelled` or `receiver-administrative-cancellation`.

`cancelled` is terminal.

## State Transitions

Allowed transitions:

```text
validated and authorized
  -> accepted

accepted
  -> on-hold
  -> delivered
  -> failed
  -> cancelled

on-hold
  -> on-hold
  -> delivered
  -> failed
  -> cancelled
```

Repeated `on-hold` snapshots may update the reason or retry schedule. Terminal states have no outgoing transitions.

The `received`, `duplicate`, `message-id-conflict`, `invalid-envelope`, `unauthorized`, `message-expired`, `rate-limited`, and `temporarily-unavailable` submission outcomes are not delivery states. Their disclosure and retry classifications are defined in [http-binding.md](http-binding.md).

An idempotent retry of an accepted envelope returns its current state without creating a transition. A conflicting payload under the same sender and message ID is permanently rejected.

### Terminal Transition Atomicity

Every transition to `delivered`, `failed`, or `cancelled` uses one serialized compare-and-set transaction over the recipient-specific delivery record.

For `delivered`, the recipient first places the verified body and message data in durable staging. The terminal transaction then:

1. Requires the current state to be `accepted` or `on-hold`.
2. Samples recipient time at the transaction's linearization point and requires it not to exceed the effective delivery deadline.
3. Requires that no cancellation or terminal failure committed first.
4. Atomically publishes the recipient-visible message record, sets `delivered`, assigns the next status revision, and consumes any reply-capability claim.

Deadline failure and cancellation use the same compare-and-set rule and atomically release any claimed reply capability. Whichever terminal transaction commits first wins; every competing transition observes the terminal state and performs no state change. Durable staged data from a losing completion attempt is not recipient-visible and may be garbage-collected.

This prevents a message from becoming visible with `failed` or `cancelled` status and prevents deadline workers from overwriting completed delivery.

## Acceptance And Authorization Races

The recipient server must make envelope acceptance and grant changes linearizable for one recipient.

Conceptually, the acceptance transaction:

1. Reads the locally authoritative grant or reply capability.
2. Confirms every authorization condition.
3. Reserves idempotency and reply-capability state.
4. Durably creates the `accepted` delivery record.

Grant expiration, reply expiration, and envelope expiration are time predicates rather than stored revisions. The recipient samples its authoritative time at the acceptance transaction's linearization point, or conservatively re-samples under the same serialization lock immediately before commit. Authorization and envelope validity must hold at that sample. A time value read only at transaction start is insufficient when a deadline can pass before commit.

The outcome is determined by commit order:

- If grant restriction, expiration, or revocation commits first, the envelope is rejected.
- If envelope acceptance commits first, that envelope remains accepted and body processing continues.

Later grant changes apply to envelopes not yet accepted. They do not change accepted, delivered, failed, or cancelled records and do not retroactively delete delivered messages.

This rule gives `accepted` stable meaning and prevents a sender from observing acceptance that later disappears solely because authorization changed during body retrieval.

Recipient policy still may explicitly cancel pending work. Such cancellation is represented as `cancelled`, not as retroactive failure of the original grant check.

## Delivery Deadline

The envelope's `expires_at`, including the 300-second clock tolerance defined by [envelopes.md](envelopes.md), is the deadline for completed delivery.

The recipient may retry only through the earlier of:

- 300 seconds after `expires_at`
- `body.available_until`
- `body.access.expires_at`

When the effective deadline passes before durable completion, the recipient records `failed` with reason `delivery-expired`.

A new submission is accepted only when recipient time at the acceptance linearization point is no later than this effective deadline. Clock tolerance on `expires_at` never permits acceptance after body availability or access authorization has ended.

Acceptance does not extend any signed sender commitment. The recipient should begin retrieval promptly rather than treating the full availability period as a normal queue delay.

## Retry Ownership

The recipient server determines:

- when to issue body requests
- exponential-backoff parameters
- jitter
- concurrency limits
- when to move a pending delivery into `on-hold`
- how often to publish non-terminal status updates

The protocol constrains that discretion:

- Retries must remain within the effective delivery deadline.
- Retry schedules must use bounded backoff and jitter.
- A valid `Retry-After` value should be respected when it does not exceed the delivery deadline.
- TLS, authorization, digest, size, canonicalization, or schema checks must never be weakened to make a retry succeed.
- Permanent failures must not be retried as though they were transient.
- Temporary sender or network failure must not immediately become a permanent content failure.
- Recipient resource exhaustion may pause retrieval but does not extend the sender's signed deadline.

Suggested POC behavior:

- A responding sender with temporary body failure uses relatively short backoff, beginning in seconds and capped near one hour.
- An unreachable sender uses slower backoff, beginning in minutes and capped at several hours.
- A sender-provided valid `Retry-After` takes precedence within local safety limits and the effective deadline.
- Every schedule includes jitter to avoid synchronized retries.

These intervals are implementation guidance, not sender-controlled protocol guarantees.

## Failure And Hold Reasons

State and reason are separate. A reason explains why the recipient is waiting or why delivery ended; it does not create another lifecycle state.

### Retryable Reasons

#### `sender-unreachable`

The sender's authenticated Hail service cannot be reached at a basic transport level, such as DNS failure, connection failure, TLS failure, or timeout before a usable response.

The recipient re-resolves stale DID service data when required by the DID profile, enters or remains `on-hold`, and retries with slower bounded backoff. It must not downgrade HTTPS or bypass certificate validation.

#### `body-temporarily-unavailable`

The sender service responds, but the body is not currently retrievable. Examples include a temporary `5xx` response or a missing body before the signed availability commitment ends.

Because a body must exist before envelope submission, a missing body is sender fault. It remains retryable until the delivery deadline so temporary storage inconsistency does not immediately lose the message.

#### `body-transfer-interrupted`

A body response began but did not complete because of timeout, disconnect, truncated transfer, or another transient stream failure.

The recipient discards unverified partial bytes unless it implements a future explicitly specified range-resumption profile.

#### `sender-rate-limited`

The body service rate-limited retrieval. The recipient respects valid `Retry-After` guidance within the delivery deadline and local safety limits.

#### `receiver-resource-constrained`

The recipient server temporarily lacks storage, workers, memory budget, or another local resource required to complete delivery.

The recipient may enter `on-hold`, but local constraints do not extend sender commitments or the delivery deadline.

### Permanent Reasons

#### `body-authorization-failed`

The body service rejects the signed bearer authorization while it should still be valid. Because the envelope and token are immutable, the same envelope cannot repair this failure. If retrieval instead remains pending until the access expiration becomes the effective deadline, the terminal reason is `delivery-expired`.

#### `body-integrity-failed`

The uncompressed size or SHA-256 digest does not equal the signed descriptor. The recipient must not retry alternate bytes under the same digest as though they were valid.

#### `body-invalid`

The body is malformed, non-canonical, fails the declared SPT schema, or violates mandatory structural resource limits.

#### `body-unsupported`

The body requires a media type, profile, or content coding that the recipient was not required to support and could not reject before acceptance.

The POC validates its fixed media type and profile before acceptance, so this reason is primarily reserved for future negotiated profiles.

#### `delivery-expired`

The effective delivery deadline passed before durable completion. A previously retryable condition ends with this reason.

#### `receiver-policy-rejected`

Body content violates a recipient policy that could only be evaluated after authenticated retrieval, such as a future attachment or content-policy rule.

Policy known from envelope metadata must be applied before acceptance rather than deferred to this reason.

### Cancellation Reasons

#### `recipient-cancelled`

The recipient explicitly cancelled accepted but incomplete delivery through local client or provider controls.

#### `receiver-administrative-cancellation`

The recipient-server operator explicitly cancelled accepted but incomplete delivery during administration or incident response.

## Retrieval Classification

The HTTP binding defines exact status-code handling. The POC uses these semantic classifications:

| Observation | Classification |
| --- | --- |
| DNS, connection, TLS, or pre-response timeout | `on-hold`: `sender-unreachable` |
| `503` or unexpected temporary `5xx` body response | `on-hold`: `body-temporarily-unavailable` |
| Valid authorization followed by `503` for a missing body before deadline | `on-hold`: `body-temporarily-unavailable` |
| Interrupted or truncated body response | `on-hold`: `body-transfer-interrupted` |
| `429` rate limit with or without `Retry-After` | `on-hold`: `sender-rate-limited` |
| Temporary local resource shortage | `on-hold`: `receiver-resource-constrained` |
| Uniform `404` authorization rejection before the signed expiration | `failed`: `body-authorization-failed` |
| Size or digest mismatch | `failed`: `body-integrity-failed` |
| Invalid canonical JSON or SPT document | `failed`: `body-invalid` |
| Unsupported required representation | `failed`: `body-unsupported` |
| Retryable condition reaches deadline | `failed`: `delivery-expired` |

Recipient implementations may retry an ambiguous transport failure conservatively, but they must not reinterpret authenticated invalid content as valid content.

## Multiple Recipients

V1 uses one Hail Envelope per recipient. A logical outbound message sent to many recipients therefore has:

- one distinct `message_id` per recipient envelope
- one independent acceptance decision per recipient
- one independent delivery state and signed status stream per recipient
- optionally one shared body digest and sender-side stored body

The sender maintains any campaign, mailing, or logical outbound-message grouping locally. It maps recipient-specific message IDs into that local record and may aggregate results such as delivered, pending, or failed counts.

V1 does not put a campaign or recipient-group identifier in the envelope or delivery status. Such an identifier is unnecessary for federation and would add cross-recipient correlation metadata.

Each recipient receives a separate durable message record and delivery result. Underlying storage may deduplicate identical bytes, but v1 delivery processing does not use one recipient's verified cache provenance to skip another recipient's retrieval.

### Cache Provenance And Isolation

A globally deduplicated storage blob must not make one recipient's prior content possession observable through another recipient's delivery result.

Cached bytes may satisfy delivery without a new body fetch only when the cache record has verified delivery provenance for the same tuple:

```text
(recipient DID, sender DID, body digest, media type, profile)
```

Underlying blob storage may deduplicate identical bytes globally, but a delivery cannot consult global or cross-recipient blob presence when choosing status, timing, or retrieval behavior. V1 performs recipient-specific retrieval when matching provenance is absent. A future profile may define privacy-preserving coordinated authorization and retrieval, but ordinary envelope signature validation is not enough to enable cross-recipient cache reuse.

This restriction prevents a malicious but granted sender from submitting an unusable body authorization for chosen content and learning from `delivered` status that another tenant previously caused those bytes to be cached.

## Delivery Status Payload

Every externally communicated delivery status is a complete signed snapshot.

Conceptual delivered payload:

```json
{
  "type": "hail.delivery-status",
  "version": 1,
  "message_id": "01a0443c-5600-7c43-969f-9fca31321a64",
  "envelope_digest": {
    "algorithm": "sha-256",
    "value": "base64url-sha256-envelope-payload-digest"
  },
  "from": "did:plc:recipient123",
  "to": "did:web:example-store.com:updates",
  "revision": 2,
  "state": "delivered",
  "occurred_at": 1787851260
}
```

Conceptual hold payload fragment:

```json
{
  "revision": 2,
  "state": "on-hold",
  "reason": "sender-unreachable",
  "retry_at": 1787851800,
  "occurred_at": 1787851320
}
```

The payload and all nested values are closed v1 objects.

### Status Fields

`type` is the exact string `hail.delivery-status`.

`version` is the integer `1`.

`message_id` exactly equals the accepted envelope's message ID.

`envelope_digest` contains `algorithm` with exact value `sha-256` and `value` with the unpadded base64url encoding of SHA-256 over the accepted envelope's exact RFC 8785 canonical payload bytes.

`from` is the recipient DID from the accepted envelope's `to` field and is the signer of the status.

`to` is the sender DID from the accepted envelope's `from` field.

`revision` is a positive integer beginning at `1` for `accepted` and increasing by exactly one for every status snapshot created by the recipient.

`state` is one of the five v1 states.

`reason` is required for `on-hold`, `failed`, and `cancelled`; it is prohibited for `accepted` and `delivered`. The reason must be valid for that state.

`retry_at` is required for `on-hold` and prohibited for every other state. It is a UTC Unix timestamp later than or equal to `occurred_at` and no later than the effective delivery deadline.

`occurred_at` is the recipient server's UTC Unix time in whole seconds when it durably recorded this state revision.

Unknown fields are rejected in v1.

## Status Signature Profile

Delivery status uses the same JCS and flattened JWS mechanics as Hail Envelopes, with object-specific domain separation.

The protected header is:

```json
{
  "alg": "Ed25519",
  "kid": "did:plc:recipient123#hail-messaging",
  "typ": "hail-delivery-status+jws"
}
```

Rules:

- The payload and protected header use exact RFC 8785 canonical bytes.
- The JWS uses RFC 7515 flattened JSON Serialization.
- `alg` is the RFC 9864 value `Ed25519`; `EdDSA` is rejected.
- `kid` is the status `from` DID's authorized `#hail-messaging` key.
- `typ` is the exact string `hail-delivery-status+jws`.
- Every semantic status field is signed.
- Unknown or unprotected header parameters are rejected.

The sender verifies the status signature against current DID state at receipt and retains the verification evidence needed for later audit under the shared DID-history rules.

If the recipient rotates `#hail-messaging` before a status is acknowledged, every later retry must wrap and sign the same canonical status payload using the new current key without incrementing `revision`. Signature-wrapper changes do not create a semantic status revision. A provider whose key was removed must stop retrying and must not backdate newly signed status.

A continuity-preserving provider migration uses a fenced ownership cutover rather than two active providers or an unfenced live snapshot:

1. The new provider prepares an authenticated import but does not process Hail operations for the DID.
2. The old provider acquires an exclusive migration fence and stops accepting envelopes, committing delivery transitions, changing grants or reply capabilities, and creating status revisions for the DID.
3. While fenced, the old provider exports the complete serialization domain: current grants and tombstones, reply-capability state, all retained envelope idempotency and rejection records, accepted and terminal delivery records, canonical current status payloads and revision history, body/cache provenance needed for continuation, and retained signature-verification evidence.
4. The new provider validates and durably imports that complete state and acknowledges the exact snapshot.
5. The DID controller updates `#hail-messaging` and `#hail` to the new provider.
6. Only after the DID method considers that update current does the new provider take ownership, resume pending work, and sign status wrappers with its current key.
7. The old provider remains fenced and rejects stale requests. It never commits state after export and never receives the new provider's private key.

Requests during the fenced interval may receive temporary generic failure and retry through normal discovery-refresh behavior. If cutover is abandoned before the DID update, the old provider may resume only after invalidating the unactivated import so one serialization owner still exists.

An emergency rotation after compromise or provider loss may make untransferred status unavailable. Hail does not accept signatures from a removed key merely to mask that availability failure. Recovery of missing provider state requires backup or a future authenticated migration-recovery mechanism.

## Status Ordering And Idempotency

The sender indexes status by:

```text
(original sender DID, message_id, recipient DID)
```

Before accepting a status, the sender verifies that it previously created the referenced envelope and that the message ID, parties, and envelope digest all match its sent-envelope record.

That durable sent-envelope record establishes the sender's delivery-tracking resource before any pushed status arrives. A status push updates an existing resource and cannot create one for an unknown envelope.

The sender retains the sent-envelope and delivery-tracking record through at least `envelope replay deadline + 2592000 seconds`. It does not use an unauthenticated status timestamp to extend retention.

Status handling:

- Exact duplicate revision and payload: idempotent success.
- Higher revision: accept when its transition is valid and replace current state.
- Lower revision: acknowledge as stale without changing current state.
- Same revision with different payload: permanent conflict.
- Invalid state transition: permanent conflict.
- A higher revision after a terminal state, or the same revision with different payload, is a permanent conflict. A lower revision remains a stale success and does not change terminal state.

If the sender has no previously received status snapshot, it must accept a first-observed terminal snapshot whose revision is at least `2` when that terminal state is reachable from the mandatory revision-1 `accepted` state and all sent-envelope correlations are valid. Omitted revisions are recorded as an audit gap. A terminal snapshot at revision `1` is invalid because revision `1` is always `accepted`.

Snapshots are complete, so a sender may accept a higher revision even if an intermediate `on-hold` update was never received. Revision gaps are recorded for audit but do not prevent convergence on a valid terminal snapshot.

## Status Reporting

The current signed status snapshot is the authenticated Hail processing result for an accepted envelope. A generic HTTP `202` receipt is not a status snapshot and proves neither Hail acceptance nor delivery. The HTTPS binding may return the current snapshot synchronously to an authenticated sender with a current or previous relationship when privacy permits. If body processing completes before the first authenticated result is communicated, the recipient may communicate the later `delivered` snapshot instead.

V1 does not asynchronously push `accepted` or `on-hold`. Those nonterminal states remain available as the current signed result through authenticated envelope submission or duplicate retry. A recipient need not create a new `on-hold` revision for every failed request or retry schedule adjustment.

The recipient must push every terminal `delivered`, `failed`, or `cancelled` snapshot to the sender's current authenticated Hail service. The destination is derived from the original sender DID's `#hail` service; neither the envelope nor status contains a callback URL.

Status reporting is an at-least-once operation:

- The recipient retries an unacknowledged terminal status under the fixed schedule and 30-day minimum defined by the HTTP binding.
- The sender returns `204 No Content` after handling a valid new, duplicate, or stale snapshot. Only `204` acknowledges the status revision and ends its retries.
- Status-report failure does not change the recipient's delivery state.
- The recipient retains the latest signed terminal status, verification evidence, and retry state through at least `max(envelope replay deadline, terminal status occurred_at + 2592000 seconds)`, even if acknowledgement ends transmission earlier.
- During the envelope retry window, the original sender may recover current status by resubmitting the byte-identical signed envelope under the authenticated duplicate-submission rules.

The recipient pushes one terminal snapshot per request using `PUT {sender-hail-service-base}/deliveries/{envelope_digest}` with `application/jose+json`, no content coding, and a 16384-byte maximum complete representation. The HTTP binding defines authentication, acknowledgement, errors, and privacy behavior. `QueryDeliveryStatus` is deferred from v1; any future query must independently authenticate the original sender relationship. A generic receipt never includes a status-query handle.

## Privacy

Delivery status confirms server processing only. It contains no client synchronization, display, open, read, click, or user-activity signal.

A status is sent only to the authenticated sender of the corresponding envelope. The sender already knows the recipient DID and message ID, but providers still protect status objects from unrelated parties.

Multi-recipient aggregate results remain sender-local. Recipient servers do not explicitly report other recipients, campaign membership, fetch counts, or cache-reuse metadata, and cross-recipient cache state never affects delivery behavior. A sender may still observe whether its service receives a request for a later envelope to the same recipient; v1 does not attempt to conceal same-relationship cache reuse or eviction from that sender.

## POC Requirements

The proof of concept implements:

- `accepted`, `on-hold`, `delivered`, `failed`, and `cancelled`
- immutable terminal states
- serialized compare-and-set terminal transitions
- authorization fixed by atomic envelope acceptance
- no automatic cancellation from later grant changes
- durable verified body and message storage before `delivered`
- recipient-controlled bounded retry scheduling
- retryable and permanent reason classifications
- deadline failure using `delivery-expired`
- one independent state stream per recipient envelope
- no protocol campaign identifier
- signed full-state delivery-status snapshots
- ordered idempotent status revisions
- terminal status push to the sender's DID-discovered Hail service
- one flattened JWS status per `PUT {sender-hail-service-base}/deliveries/{envelope_digest}` request
- 16384-byte status representation limit and no HTTP content coding
- `204` acknowledgement for valid new, duplicate, and stale snapshots
- privacy-preserving generic `202` for protected unknown or unauthenticated push outcomes
- immediate terminal push followed by fixed jittered retries capped at a 24-hour nominal interval
- recipient terminal-status retry and retention through at least 30 days after `occurred_at` and no earlier than the envelope replay deadline
- sender correlation-record retention through at least 30 days after the envelope replay deadline
- pending status handoff during continuity-preserving provider migration
- no read or open receipts

Deferred:

- batching status updates for many recipients
- campaign-level federation objects
- client synchronization and optional read receipts
- authenticated delivery-status query
- emergency status recovery when provider state and backups are unavailable

## Open Questions

- Should status snapshots include standardized provider trace identifiers for support without exposing internal topology?
