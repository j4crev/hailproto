# Hail HTTPS Binding

Status: Draft, partial

This document defines the HTTPS behavior shared by Hail server-to-server operations. The current draft settles envelope-submission outcomes, privacy, timing, retry, and idempotency semantics. Exact endpoint paths, media types, response schemas, and RFC 9457 problem type URIs remain to be specified.

Grant, envelope, body, and delivery-state semantics remain authoritative in their respective specifications. This binding must not change their authorization or state-transition rules.

## Receipt, Acceptance, And Delivery

These events are distinct:

```text
HTTP receipt       -> the recipient endpoint received a submission
Hail accepted      -> authorization is fixed and body-processing responsibility transferred
Hail delivered     -> the verified body and message record are durably stored
```

The generic submission outcome `received` reports only HTTP receipt. It does not promise that processing began, authenticate either party, create protocol state, or mean that the envelope reached the Hail `accepted` delivery state.

In particular, HTTP `202 Accepted` is the generic receipt response defined below. The HTTP status name must not be interpreted as Hail envelope acceptance or completed delivery.

## Envelope-Submission Outcomes

Envelope submission uses this closed semantic outcome set:

- `received`: The request was received, but no protocol-acceptance information is disclosed.
- `accepted`: The envelope was authenticated, authorized, atomically reserved, and entered the Hail `accepted` delivery state.
- `duplicate`: The same authenticated sender DID and `message_id` already reserved an identical canonical payload. No new delivery was created; the stored result or current state applies.
- `message-id-conflict`: The same authenticated sender DID and `message_id` reserved a different canonical payload.
- `invalid-envelope`: The envelope representation, schema, signature, timestamps, or other envelope-level validation is invalid.
- `unauthorized`: No usable grant or reply authorization permits this envelope.
- `message-expired`: The envelope expired before acceptance.
- `rate-limited`: Processing is temporarily refused by a rate limit.
- `temporarily-unavailable`: The recipient service cannot currently complete submission processing.

These are submission outcomes, not delivery states. `accepted` names the existing initial delivery state; `received`, `duplicate`, and all rejection outcomes do not add states to the delivery state machine.

`grant-revoked` and `category-not-granted` may be retained as internal or eligible detailed reasons under `unauthorized`. Invalid keys and invalid signatures are internal reasons under `invalid-envelope`. These details must not bypass the disclosure rules below.

## Disclosure Tiers

### Safe Transport Errors

A server may explicitly reject failures determined solely from bounded HTTP request properties before protected envelope processing, including:

- unsupported HTTP method
- unsupported media type
- unsupported HTTP content encoding
- invalid HTTP framing
- a request exceeding the envelope transport limit

These responses must not depend on the claimed or actual recipient, sender, grant, reply capability, signature, message ID, or other relationship state. An explicit source-wide or service-wide rate-limit response is also safe only when it is selected independently of protected relationship state.

Invalid JSON, an invalid JWS, absent recipients, absent grants, absent reply records, unknown keys, invalid signatures, replay records, and recipient policy are part of protected envelope processing rather than this transport allowlist.

### Generic Receipt

A caller that cannot be authenticated as a sender with a current or previous local relationship receives the same generic response for protected outcomes:

```http
HTTP/1.1 202 Accepted
Cache-Control: no-store
```

The final response media type and body schema remain to be assigned. Every generic response must use the same status, representation shape, privacy-relevant headers, and bounded timing behavior.

The response semantically reports only `received`. It includes no `Location`, status-query token, opaque query handle, detailed reason, replay state, or acceptance promise. A generic receipt creates no replay record or query authorization by itself.

### Authenticated Relationship Detail

After signature verification, a sender with a current or previous grant or reply relationship may receive a detailed submission outcome when recipient privacy policy permits. Eligibility comes from authenticated local relationship state, never from a claimed DID, grant ID, reply reference, message ID, or signing key alone.

An eligible sender may receive:

- the current signed delivery-status snapshot for an accepted envelope
- the stored result or current signed status for an identical duplicate
- `message-id-conflict`
- `invalid-envelope` when enough of the envelope was authenticated to disclose it safely
- `unauthorized`, optionally with an already-known relationship reason such as `grant-revoked` or `category-not-granted`
- `message-expired`
- `rate-limited`
- `temporarily-unavailable`

Invalid signatures cannot receive relationship detail because the claimed sender was not authenticated.

## Bounded Response Schedule

Protected generic responses must follow one common bounded response schedule. Random delay alone is insufficient because repeated requests can average it out.

The proof of concept must:

1. Measure complete local validation paths on representative supported hardware.
2. Select a minimum response bound above normal validation time instead of guessing a duration in the protocol specification.
3. Return no protected generic response before that bound.
4. Impose a processing deadline so network-dependent DID resolution cannot make preliminary misses distinguishable through unbounded latency.
5. Return the scheduled generic receipt when authenticated detailed processing cannot finish within the bound; processing may continue asynchronously.
6. Rate-limit abusive sources before expensive cryptographic or network work where this does not disclose protected state.
7. Test repeated timing observations across absent recipients, absent grants, absent reply records, unknown keys, invalid signatures, revoked grants, duplicates, and successful acceptance.

Safe transport errors may be rejected before this schedule because their selection is independent of protected state.

## Synchronous And Asynchronous Results

Envelope submission uses a synchronous HTTP exchange. The response is either the generic receipt or, for an eligible authenticated relationship, a detailed current submission result that completed within the response schedule.

A generic receipt is indeterminate. If subsequent authenticated status remains unavailable, the sender may retry the identical envelope under the idempotency rules below. It must not treat the HTTP `202` as Hail acceptance.

Every terminal `delivered`, `failed`, or `cancelled` status remains an asynchronously pushed, signed delivery-status snapshot with idempotent acknowledgement as defined in [delivery-state.md](delivery-state.md). A fast delivery may return a later current signed snapshot instead of first returning `accepted`, but HTTP receipt alone is never a delivery receipt.

## Retry Classification

| Outcome | Classification and sender behavior |
| --- | --- |
| `received` | Indeterminate. An identical retry is safe if authenticated status remains unavailable; retries remain bounded by the envelope deadline and sender policy. |
| `accepted` | No new submission is required. An identical retry is idempotent. Body-processing retries belong to the recipient. |
| `duplicate` | Success for idempotency purposes. Use the stored result or current state; do not create a new message. |
| `message-id-conflict` | Permanent. Do not retry or reuse the message ID. |
| `invalid-envelope` | Permanent for that representation. A corrected message uses a new message ID. |
| `unauthorized` | Permanent for that envelope and authorization attempt. Do not automatically retry; changed authorization requires a new envelope and message ID. |
| `message-expired` | Permanent for that envelope. |
| `rate-limited` | Retryable. Honor a valid `Retry-After` value and retry the identical envelope. |
| `temporarily-unavailable` | Retryable with bounded exponential backoff and jitter using the identical envelope. |

An ambiguous connection failure is handled like `received`: the sender retries the byte-identical signed envelope with the same `message_id`. A sender must not generate a new message ID merely because the transport outcome was ambiguous, because doing so could create a second delivery.

Once an envelope reaches Hail `accepted`, the recipient owns body retrieval, backoff, and hold scheduling through the effective delivery deadline. Sender resubmission does not reset timestamps, deadlines, retry schedules, reply claims, or delivery state.

## Idempotency And Replay Retention

The idempotency key is `(authenticated sender DID, message_id)`.

- The same key and canonical payload digest returns the stored result or current state without creating another delivery.
- The same key and a different canonical payload digest produces permanent `message-id-conflict`.
- Concurrent submissions for one key are serialized.
- A duplicate never causes an additional body retrieval or body/message publication solely because it was retried.
- A generic `received` response to an unknown or unauthenticated caller creates neither a replay record nor an acceptance record.
- The sender never reuses a message ID after any result.

The recipient retains an authenticated replay record until at least:

```text
max(envelope.expires_at, envelope.body.available_until) + 300 seconds
```

After that deadline the signed envelope is already expired and cannot become a new delivery. Providers may retain compact tombstones longer for auditing, support, or abuse prevention.

## Remaining Binding Work

The following decisions remain open:

- exact envelope-submission method and relative path
- final request and response media types and schemas
- mapping eligible detailed outcomes to HTTP status codes
- final RFC 9457 problem type URIs and fields
- transport authentication, if any, in addition to the envelope JWS
- body-retrieval HTTP status mapping
- grant-publication HTTP details
- delivery-status push, acknowledgement, and authenticated query methods and paths
- standardized retry intervals and terminal-status retry duration

An authenticated status query, if included, must prove the original sender relationship and must not rely on a handle returned by the generic receipt.
