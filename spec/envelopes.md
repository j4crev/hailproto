# Hail Envelopes

Status: Draft

This document defines the Hail Envelope v1 payload, authorization modes, signature representation, validation rules, and replay behavior.

A Hail Envelope is a compact, single-recipient, signed object. It authenticates the metadata needed to authorize delivery and retrieve an immutable detached Hail Body. It does not contain the body or an arbitrary body URL.

Detached body publication and retrieval are defined in [bodies.md](bodies.md). Grant authorization is defined in [grants.md](grants.md). DID key roles and service discovery are defined in [did-profile.md](did-profile.md). HTTPS submission outcomes, disclosure, and retry behavior are defined in [http-binding.md](http-binding.md).

## Core Rules

- One envelope identifies exactly one sender DID and one recipient DID.
- One envelope authorizes exactly one message delivery.
- Every semantic envelope field is covered by the sender's signature.
- The sender signs with its currently authorized `#hail-messaging` key.
- An envelope uses exactly one authorization mode: an active Hail Grant or a reply capability established by an earlier envelope.
- The body exists before envelope submission and is identified by its signed digest and metadata.
- The body endpoint is derived from the authenticated sender DID service, never supplied by the envelope.
- The tuple `(from, message_id)` is the delivery and idempotency key.
- Repeating the same signed envelope is idempotent; reusing its key with different content is a permanent conflict.
- Envelope acceptance is not completed delivery. Delivery completes only after the recipient verifies and durably accepts the envelope and body.
- Unknown top-level fields and unknown fields in closed v1 objects are rejected.

## Signed Payload

Diagnostic JSON for the conceptual grant-authorized v1 payload. Byte-string values use their base64url diagnostic rendering:

```json
{
  "type": "hail.envelope",
  "version": 1,
  "message_id": "01a0443c-5600-7c43-969f-9fca31321a64",
  "from": "did:plc:bbbbbbbbbbbbbbbbbbbbbbbb",
  "to": "did:plc:aaaaaaaaaaaaaaaaaaaaaaaa",
  "authorization": {
    "type": "grant",
    "grant_id": "01954144-8097-7a9d-a7a8-ef29a823eaf1"
  },
  "category": "receipts",
  "message_type": "receipt",
  "created_at": 1787851200,
  "expires_at": 1788456000,
  "body": {
    "digest": {
      "algorithm": "sha-256",
      "value": "base64url-sha256-digest"
    },
    "size": 8421,
    "media_type": "application/hail-body+cbor",
    "profile": "spt-1",
    "available_until": 1790443200,
    "access": {
      "type": "bearer",
      "token": "base64url-random-token",
      "expires_at": 1790443200
    }
  },
  "reply": {
    "allowed": true,
    "until": 1798219200
  }
}
```

Diagnostic JSON for a conceptual reply-authorized payload fragment:

```json
{
  "authorization": {
    "type": "reply",
    "reply_to": "01a0443c-5600-7c43-969f-9fca31321a64"
  },
  "reply": {
    "allowed": false
  }
}
```

The payload is a closed Hail map. Its fields are serialized and signed using the profile in [Signature Profile](#signature-profile).

## Payload Fields

### `type`

Required. The exact string `hail.envelope`.

This identifies the signed object and provides protocol-level domain separation.

### `version`

Required. The integer `1`.

The version selects the payload schema, field semantics, deterministic encoding, and validation rules. It is not a message revision number; envelopes are immutable.

### `message_id`

Required. A sender-generated UUIDv7 conforming to RFC 9562 in canonical lowercase string form.

The ID is unique within the sender DID. The UUID timestamp improves index locality and does not add material timestamp disclosure because `created_at` is signed in the same envelope. Senders must use a cryptographically secure UUIDv7 generator and must never reuse an ID, including after expiration or failed delivery.

The ID is not content-derived, does not identify the body, and is not an authorization capability.

### `from`

Required. The exact DID whose `#hail-messaging` key signed the envelope.

The protected COSE `kid` must be the UTF-8 bytes of the absolute DID URL under this DID identifying its `#hail-messaging` verification method.

### `to`

Required. The exact recipient DID.

The server receiving the envelope must be authoritative for this DID through its current authenticated `#hail` service. Provider hostnames and human-readable Hail addresses do not replace this field.

### `authorization`

Required. A closed object with exactly one of the shapes defined in [Authorization](#authorization).

### `category`

Conditionally required. A case-sensitive sender-defined category ID.

V1 category IDs contain 1 to 64 ASCII characters. The first character is a lowercase letter or digit. Remaining characters are lowercase letters, digits, `.`, `_`, or `-`.

For grant-authorized delivery:

- `category` is required when the referenced grant uses `categories` scope.
- `category` must exactly equal one value in that scope.
- `category` must be omitted when the grant uses `uncategorized` scope.

For reply-authorized delivery, `category` must be omitted. A reply capability authorizes continuation of a specific conversation, not delivery under a sender category.

### `message_type`

Optional. Protocol-defined presentation and organization metadata. It does not grant delivery permission and cannot broaden grant scope.

V1 values are:

```text
personal
newsletter
promotion
receipt
invoice
ticket
boarding-pass
account-alert
security-alert
package-update
calendar-event
```

Unknown values are rejected in v1 rather than silently treated as an existing type. A reply envelope should normally use `personal` or omit the field.

### `created_at`

Required. UTC Unix time in whole seconds when the sender created the immutable envelope.

It is distinct from the timestamp encoded in `message_id`; the explicit field is authoritative for protocol behavior.

### `expires_at`

Required. UTC Unix time in whole seconds by which the recipient must complete delivery.

It must be greater than `created_at` and no later than `body.available_until`. A recipient does not accept a new submission or continue a pending delivery after the timestamp tolerance following `expires_at`. Expiration does not delete a message that completed delivery before the deadline.

The POC sender uses an expiration no more than 7 days after `created_at`. A conforming POC recipient must support that window and may reject longer windows by policy.

### `body`

Required. The closed descriptor defined in [Body Descriptor](#body-descriptor).

### `reply`

Required. The closed reply-permission object defined in [Reply Permission](#reply-permission).

## Authorization

### Grant Authorization

Shape:

```json
{
  "type": "grant",
  "grant_id": "01954144-8097-7a9d-a7a8-ef29a823eaf1"
}
```

`type` is the exact string `grant`. `grant_id` is the UUIDv7 of the Hail Grant used as the local lookup hint.

The recipient authorizes the envelope only when its locally authoritative latest grant revision satisfies all of these conditions:

1. The grant exists under `(to, grant_id)`.
2. Its `grantor` exactly equals `to`.
3. Its `grantee` exactly equals the authenticated `from` DID.
4. Its status is active.
5. It is not expired.
6. The envelope category satisfies its complete scope.
7. Recipient policy permits delivery.

The grant ID is not a bearer capability. Knowledge of it does not bypass signature verification or any grant check.

### Reply Authorization

Shape:

```json
{
  "type": "reply",
  "reply_to": "01a0443c-5600-7c43-969f-9fca31321a64"
}
```

`type` is the exact string `reply`. `reply_to` is the `message_id` of an earlier envelope sent by the current recipient DID to the current sender DID.

The recipient authorizes the reply only when its local sent-message record proves all of these conditions:

1. The referenced envelope's `from` exactly equals the reply envelope's `to`.
2. The referenced envelope's `to` exactly equals the reply envelope's authenticated `from`.
3. The referenced envelope permitted replies.
4. The current time is not after the referenced envelope's `reply.until` value, allowing only the timestamp tolerance defined below.
5. The reply has not been rejected by local conversation or abuse policy.
6. No different authenticated envelope has already claimed or consumed this reply capability.

The referenced message ID is a lookup hint into the original sender's authenticated sent-message state. It is not independently transferable and is not a bearer capability.

A reply capability authorizes one next message, not an unlimited set of sibling messages. On authenticated envelope acceptance, the original sender atomically claims the capability for `(from, message_id)`. An idempotent retry by that same key retains the claim; a different envelope referencing the claimed capability is rejected. Completed delivery permanently consumes the capability. `failed` and `cancelled` atomically release the claim, allowing one replacement envelope before `reply.until`; the claim can never be released while the original delivery remains non-terminal.

A reply envelope may itself permit one further reply. This forms a linear chain of explicitly solicited messages without creating a standing grant in the reverse direction. Sending an envelope with `reply.allowed` set to `false` ends the chain after that message.

V1 has no reply routing hint or handler URL. Replies resolve the current recipient DID's authenticated `#hail` service and use the normal envelope submission operation.

## Body Descriptor

The `body` value is a closed object with this exact v1 shape:

```json
{
  "digest": {
    "algorithm": "sha-256",
    "value": "base64url-sha256-digest"
  },
  "size": 8421,
  "media_type": "application/hail-body+cbor",
  "profile": "spt-1",
  "available_until": 1790443200,
  "access": {
    "type": "bearer",
    "token": "base64url-random-token",
    "expires_at": 1790443200
  }
}
```

V1 rules:

- `digest` is a closed object containing only `algorithm` and `value`.
- `digest.algorithm` is the exact string `sha-256`.
- `digest.value` is exactly 32 digest bytes. Diagnostic JSON and the retrieval path use its unpadded base64url rendering.
- `size` is the exact uncompressed deterministic body size in octets, from 1 through 262144 inclusive.
- `media_type` is the exact provisional string `application/hail-body+cbor`.
- `profile` is the exact string `spt-1`.
- `available_until` is a UTC Unix timestamp at least 2592000 seconds after `created_at` and at least 300 seconds after `expires_at`.
- `access` is a closed object containing only `type`, `token`, and `expires_at`.
- `access.type` is the exact string `bearer`.
- `access.token` is exactly 32 cryptographically random bytes generated for this recipient envelope. The HTTP Bearer credential uses its unpadded base64url rendering.
- `access.expires_at` is no earlier than `available_until` and therefore covers the complete envelope clock-tolerance window.

The sender must retain both the immutable body and its retrieval authorization through `available_until`. The recipient derives the retrieval endpoint from the authenticated `from` DID service as defined in [bodies.md](bodies.md).

## Reply Permission

Replies prohibited:

```json
{
  "allowed": false
}
```

Replies permitted:

```json
{
  "allowed": true,
  "until": 1798219200
}
```

The object is closed.

When `allowed` is `false`, `until` must be omitted. When `allowed` is `true`, `until` is required and is a UTC Unix timestamp greater than `created_at`.

`until` controls authorization to submit a reply. It may be later than the original envelope's `expires_at` and `body.available_until` because the original sender retains a compact sent-message capability record rather than depending on continued body availability.

The suggested product default is 120 days, but the signed timestamp is authoritative. There is no implicit protocol default.

## Signature Profile

The POC represents an envelope using the deterministic CBOR and tagged COSE_Sign1 profile in [encoding.md](encoding.md). The protected content type is `application/hail-envelope+cbor`, and the required role is `#hail-messaging`. Protected `kid` is the UTF-8 encoding of the sender's absolute `#hail-messaging` DID URL. The embedded payload is the exact deterministic encoding of the closed envelope map, and the unprotected map and external AAD are empty.

A receiver rejects every non-deterministic or prohibited CBOR/COSE form defined by the shared profile, even when its signature is cryptographically valid.

The `kid` key must resolve under `from`, have controller `from`, use an Ed25519 verification method representation allowed by the Hail DID profile, and be authorized for the `#hail-messaging` role. A valid signature from another key or role is invalid.

RFC 9864 supplies the fully specified COSE `Ed25519` algorithm value `-19`; deprecated polymorphic `EdDSA` value `-8` is rejected.

This signature profile is authoritative for Hail Envelope v1. Other signed Hail objects use their own protected content type, key role, and payload rules under the shared profile so they remain domain-separated.

## Timestamp Validation

POC recipients allow at most 300 seconds of clock tolerance.

For a new submission, the recipient rejects an envelope when:

- `created_at` is more than 300 seconds in the future
- current time is more than 300 seconds after `expires_at`
- a reply is submitted more than 300 seconds after the referenced `reply.until`
- any required ordering relationship among timestamps is invalid

Timestamp tolerance accommodates clock error; it does not extend `body.available_until` or bearer-token retention commitments. Implementations should use synchronized clocks and record the receiver's acceptance time separately from sender timestamps.

The recipient re-checks envelope expiration immediately before committing completed delivery. Authorization is fixed by atomic envelope acceptance as defined in [delivery-state.md](delivery-state.md); later grant changes do not cancel accepted delivery.

## Envelope Size

A POC recipient must accept a valid tagged COSE_Sign1 envelope whose complete transmitted representation is no larger than 16384 octets. It may reject a larger envelope before parsing or cryptographic verification.

The limit applies to the transmitted COSE representation. The POC does not apply HTTP content coding to individual envelopes. Batch submission is not part of v1.

## Validation Order

A recipient should process an envelope in this order:

1. Enforce transport requirements and the 16384-byte envelope limit.
2. Perform bounded structural CBOR and COSE decoding sufficient to enforce the exact tagged COSE_Sign1 shape.
3. Decode the protected header and payload; reject malformed, non-deterministic, unknown, or unsupported fields.
4. Validate inexpensive payload syntax, types, timestamp relationships, and body limits.
5. Require `to` to identify a local recipient DID served by this endpoint.
6. Use the claimed authorization fields for a preliminary local grant or sent-message lookup.
7. If no candidate authorization exists, follow the uniform unauthenticated rejection path without body retrieval or durable protocol-state mutation.
8. Resolve or load the current `from` DID and exact protected `kid`, refreshing once if cached state lacks the key.
9. Validate the key controller, Ed25519 algorithm, and `#hail-messaging` role, then verify the COSE signature.
10. Require the authenticated signer DID to exactly equal `from`.
11. Atomically check `(from, message_id)`. Return stored state for an identical authenticated retry, reject conflicting content, or reserve a new authenticated pending-validation record.
12. Apply recipient policy, rate limits, and current timestamp checks. Store any rejection as the terminal result for the reserved message ID.
13. Atomically re-check every authorization condition, claim any single-use reply capability, and durably create the `accepted` delivery record. If a grant change or competing reply claim committed first, store rejection instead.
14. Retrieve or reuse the detached body.
15. Perform all body verification and place the body and message data in durable staging.
16. Using the serialized terminal transaction defined in [delivery-state.md](delivery-state.md), atomically re-check the effective deadline, publish the message, mark it delivered, and consume any claimed reply capability. A competing failure or cancellation may win instead.

Claimed unauthenticated fields may be used only to make rejection cheaper. No successful authorization, detailed sender-facing error, replay-cache mutation, body fetch, or durable message state may rely on them before signature verification.

The externally visible response for a preliminary lookup miss must not be distinguishable from other unauthenticated processing by status, body, headers, or timing. The HTTPS binding uses a synchronous generic `202` receipt under a common bounded response schedule; it exposes authenticated detailed state separately only after verification. The schedule is selected from measured validation behavior rather than a guessed delay, bounds network-dependent DID resolution, and is tested through repeated timing observations as defined in [http-binding.md](http-binding.md).

## Idempotency And Replay Protection

The idempotency key is:

```text
(authenticated from DID, message_id)
```

On first successful signature verification for a candidate authorization, the recipient stores at least:

- the idempotency key
- a SHA-256 digest of the exact deterministic payload bytes
- the current delivery state or terminal result
- timestamps needed for retention

Behavior:

- The same key and same deterministic payload digest is an idempotent retry and returns the existing state or result.
- The same key and different deterministic payload digest is a permanent message-ID conflict.
- Concurrent submissions for one key are serialized by the same atomic reservation.
- Body digest equality has no effect on envelope identity; many messages may intentionally share one body.
- A sender must not reuse a message ID after any result, including rejection or expiration.

This authenticated record is created before final authorization and policy checks, so an authenticated rejection under an existing candidate authorization also reserves the message ID. An identical retry returns its stored state without requiring the old authorization to remain active. A preliminary lookup miss deliberately does not trigger DID resolution or create a tombstone; the sender's no-reuse rule still applies, but the recipient cannot enforce it until an envelope under that ID is authenticated.

The recipient retains the replay record until at least `max(expires_at, body.available_until) + 300 seconds`. A replay after that minimum retention is already expired and cannot become a new delivery. Implementations may retain compact tombstones longer.

Signature verification occurs before a caller receives duplicate state or causes replay-record mutation. This prevents an unauthenticated party that guesses a message ID from probing or occupying another sender's idempotency key.

## Acceptance And Delivery

HTTP receipt, Hail acceptance, and delivery are distinct:

```text
HTTP received      -> request received; no Hail acceptance promise
Hail accepted      -> authenticated, authorized, and reserved for body processing
Hail delivered     -> body verified and message durably stored
```

The generic `received` submission outcome is not a delivery state and may lead to no protocol-state change. Acceptance fixes authorization for the envelope. A later grant restriction, expiration, or revocation applies to future envelope acceptance and does not cancel this accepted message. An accepted envelope may still fail because its body is unavailable, invalid, or not completed before the delivery deadline.

The complete state machine, retry classifications, multi-recipient behavior, and signed status representation are defined in [delivery-state.md](delivery-state.md). Envelope acceptance must not be represented to the sender as completed delivery.

## Privacy And Error Disclosure

Preliminary authorization lookup must not turn the delivery endpoint into a recipient, grant, sent-message, or message-ID oracle.

Before authenticating a sender with a current or previous relationship, implementations return the mandatory generic `202`/`received` response for absent recipients, absent grants, absent reply records, invalid keys, invalid signatures, and other protected outcomes. Detailed revocation, category, duplicate, or delivery-state information is disclosed only to an authenticated sender for whom that information is already relationship state.

Protected generic responses follow the common measured bounded schedule in [http-binding.md](http-binding.md). Implementations must also rate-limit by network source, claimed DID, authenticated DID, and provider as appropriate without making protected relationship state observable.

## Security Considerations

### Signed Retrieval Tokens

The bearer token is secret but appears inside the signed envelope payload. Envelope transport must use HTTPS, and both parties must exclude complete envelopes and tokens from ordinary logs. Signature authenticity does not encrypt the token.

### Key Rotation

A newly submitted envelope must verify against authoritative PLC state under the Hail recovery-window and cache-refresh rules. A key removed during provider migration cannot authorize new submissions merely because a receiver cached it indefinitely.

Recipients retain the accepted COSE representation, resolved key material, DID version evidence where available, and acceptance time needed to audit a message after key rotation. Complete historical verification rules remain a shared DID and security-profile concern.

### Cross-Protocol Use

The protected content type, payload `type`, fixed `alg`, exact key role, and closed schema prevent a valid signature over another Hail object from being reinterpreted as an envelope. Implementations must validate all of these values rather than only checking the cryptographic signature.

### UUID Predictability

UUIDv7 message IDs expose approximate creation order and are not secrets. Authorization depends on grants, reply records, and signatures, never on inability to guess an ID.

### Canonicalization

Receivers reject non-deterministic payload, protected-header, or COSE bytes even when their signatures are cryptographically valid. This gives every accepted semantic envelope one signed byte representation and avoids ambiguity in stored digests and idempotent retries.

## POC Requirements

The proof of concept implements:

- one sender DID and one recipient DID per envelope
- closed `hail.envelope` version 1 payloads
- UUIDv7 message IDs scoped by sender DID
- grant and reply authorization modes
- exact category-to-grant checks
- optional closed-list message types
- required creation and expiration timestamps
- the exact detached body descriptor in this specification
- explicit reply permission and deadline
- deterministic Hail CBOR and tagged COSE_Sign1
- protected content type `application/hail-envelope+cbor`
- RFC 9864 COSE `Ed25519` (`-19`) signatures using `#hail-messaging`
- 300-second timestamp tolerance
- 16384-byte maximum envelope representation
- idempotent duplicate handling and conflicting-payload rejection
- the closed submission-outcome set in the HTTPS binding
- generic `202` receipt before authenticated relationship disclosure
- a measured common bounded response schedule
- no arbitrary body or reply URLs

Deferred:

- multiple recipients
- bulk envelope submission
- alternate signature algorithms
- end-to-end envelope encryption
- arbitrary extension fields
- unsigned objects or nonempty COSE unprotected headers
- non-grant authorization other than direct replies

## Open Questions

- What PLC operation and chain evidence must recipients retain for long-term audit verification?
- What production cache lifetime and PLC finality rules replace the POC behavior?
- Should production retain the POC message-type list or introduce a separately versioned registry?
- What production envelope size must every conforming implementation accept?
