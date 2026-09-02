# Hail HTTPS Binding

Status: Draft, partial

This document defines the HTTPS behavior shared by Hail server-to-server operations. The current draft settles envelope-submission outcomes, privacy, timing, retry, idempotency semantics, and the v1 use of RFC 9457 Problem Details for explicit unsuccessful responses. Exact endpoint paths, representations, and HTTP status mappings for the remaining operations remain to be specified.

Grant, envelope, body, and delivery-state semantics remain authoritative in their respective specifications. This binding must not change their authorization or state-transition rules.

## Hail Service Base URL

The `HailMessaging` service endpoint in a Hail DID document is the base URL for that DID's federation operations. A conforming publisher emits the base URL in canonical form. A consumer normalizes the limited equivalent forms below and then validates the result before constructing or sending a request.

The canonical base URL:

- uses the lowercase `https` scheme
- uses a lowercase ASCII DNS hostname in canonical IDNA A-label form
- has no terminal DNS root dot
- does not use an IP-address hostname
- omits username and password
- omits port `443`; another explicit port from 1 through 65535 is allowed in canonical decimal form without leading zeroes
- has either an empty path or an absolute path beginning with `/`
- does not end in `/`
- contains no query or fragment

A consumer normalizes an uppercase or mixed-case scheme and hostname to lowercase, removes an explicit port `443`, and removes exactly one trailing path slash. More than one trailing slash is invalid rather than collapsed. Thus `https://EXAMPLE.com:443/hail/` and `https://example.com/hail` have the same canonical form, while `https://example.com/hail//` is invalid. At the origin root, `https://example.com/` normalizes to `https://example.com` with an empty path.

Every non-empty base-path segment contains only ASCII letters, digits, `-`, `.`, `_`, or `~`. An entire segment equal to `.` or `..` is invalid. Empty interior segments, percent encoding, and backslashes are invalid. A dot within a larger segment, such as `tenant-v1.2`, is allowed. These restrictions prevent intermediaries and application servers from interpreting encoded separators, encoded dot segments, or repeated separators differently.

### Operation URL Construction

Each operation binding defines a relative operation path as one or more non-empty path segments without a leading or trailing slash. To construct an operation URL, append one literal `/` and the operation path to the canonical service base URL:

```text
base:           https://provider.example/tenants/alice/hail
operation path: envelopes
operation URL:  https://provider.example/tenants/alice/hail/envelopes
```

Implementations must not use generic URI relative-reference resolution for this step. Because the canonical base has no trailing slash, generic resolution could replace its final segment instead of appending the operation path. Standardized static operation segments follow the same character restrictions as base-path segments. Each operation separately defines the canonical encoding and validation of dynamic path-segment values, but no dynamic value may introduce a literal or percent-encoded slash, backslash, dot segment, or empty segment.

Canonical base URL comparison uses the complete normalized scheme, hostname, optional non-default port, and path. The path is case-sensitive. Operation URLs contain no query or fragment unless a future binding explicitly defines one; no v1 operation does so.

### Redirects And Endpoint Refresh

A Hail client must not follow an HTTP redirect for a federation operation and must not replay a request, bearer credential, or other authorization value to the redirect target. Provider migration is authenticated by a DID update, not delegated by an old endpoint's `Location` header. Providers use DNS, reverse proxies, or other infrastructure behind the authenticated service endpoint for load balancing.

For the POC, a client using cached DID service state re-resolves the DID once after:

- DNS, connection, or TLS establishment failure, including a timeout before an HTTP response
- any `3xx` response
- a `404 Not Found`, `410 Gone`, or `421 Misdirected Request` response
- an operation-specific unknown-key or signature failure for which fresh DID state could authorize a new key

If fresh authenticated DID state contains a different canonical `#hail` service base URL, the client may retry at the new endpoint according to that operation's retry and idempotency rules. It preserves the operation identity and byte-identical signed object whenever those rules require it. It never uses the redirect target merely because the old endpoint supplied it.

If the refreshed endpoint is unchanged or DID resolution fails, the client applies the operation's ordinary retry or failure behavior without repeatedly resolving during the same failed attempt. A `429` response or an ordinary `5xx` response is not by itself evidence of migration and does not force early DID refresh. Normal cache expiration still applies.

## Federation Operation Inventory

This inventory consolidates operations already defined across the Hail specifications. It does not replace the object-specific specifications, which remain authoritative. An entry marked `Open` records a gap rather than supplying new behavior.

### Interfaces And Results

| Operation | Status | Caller -> receiver | Authentication or authorization | Request | Successful result | Current binding |
| --- | --- | --- | --- | --- | --- | --- |
| `DiscoverIdentity` | Required composite prerequisite with context-dependent stages | A participant resolving an alias -> address domain and domain-selected binding host; a participant routing to or verifying a known DID -> DID resolver | HTTPS authenticates the address domain's WebFinger response and protects retrieval from its selected binding URL; address authority comes from that domain selection plus the binding's `#hail-identity` signature; the DID method authenticates Hail keys and service | A Hail address and canonical `acct:` URI when resolving an alias; otherwise a known DID. Address resolution yields a signed binding before DID resolution | Alias resolution yields a verified address-to-DID binding with an expiration; DID resolution yields current Hail keys and canonical service base URL | WebFinger, binding retrieval, and method-specific DID resolution; this is not one Hail service-base endpoint. Their redirect, cache, and retry profiles remain partly open. See [address-binding.md](address-binding.md) and [did-profile.md](did-profile.md). |
| `PublishGrantRevision` | Required for the POC | Recipient server acting for the grantor DID -> grantee DID's current Hail service | Complete grant revision signed by the grantor DID's `#hail-identity` key; exact signature wrapper open; additional HTTP Message Signatures deferred | Complete signed grant state with stable `grant_id`, ordered `revision`, predecessor, parties, scope, status, and timestamps | Sender verifies and stores a new revision as consent/list state; exact duplicate converges idempotently; conceptual creation returns `201`, `Location`, and strong `ETag`; conceptual update returns `204` and a new strong `ETag` | Conceptual conditional `PUT` to `grants/{grant_id}` using `If-None-Match` or `If-Match`; exact path, media type, ETag digest, statuses, and duplicate-create handling under `If-None-Match: *` are open. See [grants.md](grants.md#web-native-publication). |
| `SubmitEnvelope` | Required; includes grant- and reply-authorized variants | Sender server -> recipient DID's current Hail service | Envelope JWS signed by the authenticated `from` DID's `#hail-messaging` key; additional transport authentication open | One closed signed `hail.envelope` for one recipient, containing grant or reply authorization and a detached-body descriptor | Generic `received` discloses only HTTP receipt; `accepted` fixes authorization and transfers body-processing responsibility; an identical `duplicate` reuses stored/current state. An eligible caller may receive the current signed status, including a later state | `POST` to relative operation path `envelopes` with `Content-Type: application/jose+json`; generic receipt is `202 application/json`; authenticated signed success is `200 application/jose+json`. See [envelopes.md](envelopes.md) and the submission sections below. |
| `RetrieveBody` | Required for the POC | Recipient server -> authenticated sender DID's current Hail service | An opaque bearer token authorizes retrieval and is bound by the signed envelope to the recipient, body, and message; v1 does not prove that the requester possesses the recipient DID's key; proof of possession is deferred | Body digest in the operation path and bearer token in `Authorization`; optional supported content negotiation | Conceptual `200` carrying immutable canonical body bytes, optionally gzip-coded; the recipient verifies size, digest, media type, profile, canonical encoding, and schema | Conceptual `GET` from `bodies/{digest}`; redirects prohibited; exact digest path encoding and failure statuses open. See [bodies.md](bodies.md#retrieval-endpoint). |
| `PushDeliveryStatus` | Terminal push required; exact HTTP binding open | Recipient server -> original sender DID's current Hail service | Complete status snapshot signed by the recipient DID's current `#hail-messaging` key; the sender also matches it to its original sent-envelope record | Closed signed `hail.delivery-status` snapshot with parties, message ID, envelope digest, revision, state, occurrence time, and state-dependent fields | A higher valid revision is stored as current and acknowledged; an exact duplicate succeeds; a lower valid revision is acknowledged as stale without changing sender state | Method, path, acknowledgement representation, status codes, and any additional acknowledgement authentication are open. No separate acknowledgement request is defined. See [delivery-state.md](delivery-state.md#status-reporting). |
| `QueryDeliveryStatus` | Deferred recovery operation with incomplete abstract semantics | Expected caller: original sender server; expected receiver: service authoritative for the recipient/status signer | Must independently authenticate the original sender relationship; exact mechanism open | Open; must identify the delivery without turning message IDs into an oracle | Expected to return the current complete signed delivery-status snapshot; availability, concealment, and response semantics open | Method, path, request schema, failures, and retry behavior open. A generic receipt supplies no query handle. See [delivery-state.md](delivery-state.md#status-reporting). |

### Behavior And Privacy

| Operation | Rejection or failure semantics | Idempotency | Retry behavior | Privacy constraints |
| --- | --- | --- | --- | --- |
| `DiscoverIdentity` | Address, WebFinger, binding, signature, expiration, DID-resolution, or safe-fetch failure prevents verified resolution; exact external error taxonomy open | Component retrievals are read-only, but discovery results may change or expire; no abstract idempotency contract is defined | Address discovery and DID-method retry, redirect, and caching rules remain partly open. Endpoint refresh rules above apply only after a `#hail` service has been discovered | WebFinger may enable address enumeration; implementations rate-limit and minimize metadata. Address bindings intentionally avoid permanent address history. Routine federation from known DIDs does not re-resolve human-readable addresses. |
| `PublishGrantRevision` | Same revision with different content, stale revision, revision gap, predecessor fork, immutable-field change, invalid signature/schema, throttling, and service failure follow the classifications in the grant specification; exact HTTP mapping remains open | Conditional `PUT`, full-state revisions, predecessor digests, and strong ETags make exact retransmission idempotent; revocation is a terminal revision, not `DELETE`; the initial-create retry interaction remains open | Queue and retry transient publication failure with bounded exponential backoff and jitter; honor `Retry-After`; retransmit missing revisions; local consent changes never wait for publication | Grants are private relationship state, use `Cache-Control: no-store`, and receive generic failures before caller authentication. They contain no message body or contact-request content. |
| `SubmitEnvelope` | Uses the closed outcome set below. Conflict, invalid representation, unauthorized submission, and expiration are permanent; rate limiting and temporary unavailability are retryable. Reply authorization additionally rejects missing, expired, disallowed, or competing claims | `(authenticated sender DID, message_id)` is the key; an identical canonical payload returns stored/current state, while different content is a permanent conflict. Reply acceptance atomically claims the single-use capability; delivery consumes it; terminal failure or cancellation releases it | Ambiguous transport or generic `received` permits byte-identical retry with the same ID; honor `Retry-After`; after `accepted`, the recipient owns body retries | Protected outcomes remain generic until the sender is authenticated with current or previous relationship state. Generic responses reveal no recipient, relationship, replay, or acceptance state and follow the bounded schedule below. |
| `RetrieveBody` | Missing body and invalid, mismatched, or expired authorization must not be distinguishable; retryable transport or availability failures and permanent integrity or authorization failures feed the delivery state machine | Immutable body bytes and the same token may be retrieved repeatedly for the same envelope; matching recipient-and-sender cache provenance may avoid another fetch | Recipient retries with bounded backoff and jitter until the effective deadline, preserving digest and token; endpoint migration follows fresh DID resolution rather than redirects | Token appears only in `Authorization`, is excluded from logs, and is stored hashed by the sender. Fetches are delivery operations, not open/read signals. Cross-recipient cache state must not leak. |
| `PushDeliveryStatus` | Same-revision divergent payload, invalid transition, and nonduplicate post-terminal update are permanent conflicts. Other signature, sent-envelope, party, and digest validation failures are rejected, but their HTTP, disclosure, and retry classifications remain open | At-least-once push; exact duplicates succeed, higher valid revisions advance state, and lower revisions are acknowledged without rollback | Recipient retries unacknowledged terminal snapshots with bounded backoff and jitter; exact intervals and minimum duration open | Status is disclosed only to the authenticated original sender and reports server processing, never client synchronization, display, open, read, click, other recipients, or campaign state. |
| `QueryDeliveryStatus` | Open; required design must avoid recipient, relationship, replay, and message-ID oracles | Expected to be read-only and return the current snapshot, but exact semantics remain open | Open | Must authenticate the original sender independently; possession of a message ID or generic receipt is insufficient. |

`SubmitReply` is not a separate transport operation. A reply is an ordinary `SubmitEnvelope` request with reply authorization and the role reversal defined in [envelopes.md](envelopes.md#reply-authorization).

Status acknowledgement is required as part of `PushDeliveryStatus`. No separate acknowledgement request object, destination, lifecycle, method, or path is currently defined; its representation, authentication, and HTTP response codes remain open.

Body creation and publication are sender-local prerequisites, not federation requests. Missing grant revisions are retransmitted with `PublishGrantRevision`; grant acknowledgement is its synchronous HTTP result. Read/open receipts, bulk submission, campaign status, unsolicited contact requests, and provider state-transfer transport are outside this inventory or deferred.

## Envelope Submission Method And Path

`SubmitEnvelope` uses:

```http
POST {hail-service-base}/envelopes
```

The relative operation path is the single segment `envelopes`, appended to the canonical Hail service base URL under the construction rules above. Each request submits exactly one signed envelope. Grant-authorized messages and reply-authorized messages use the same method and path.

The request uses the registered RFC 7515 media type for JWS JSON Serialization:

```http
Content-Type: application/jose+json
```

The request body is exactly one Hail Envelope in RFC 7515 flattened JWS JSON Serialization. The protected `typ` value `hail-envelope+jws` identifies the Hail object profile as defined in [envelopes.md](envelopes.md#signature-profile). The `Content-Type` carries no parameters. A missing or different request media type is an unsupported-media-type safe transport error and is rejected before protected envelope processing.

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

## Problem Details For Unsuccessful Responses

Every explicit unsuccessful HTTP response in the Hail HTTPS binding uses RFC 9457 Problem Details with the `application/problem+json` media type. This includes safe transport errors and eligible authenticated semantic rejections such as `message-id-conflict`, `invalid-envelope`, `unauthorized`, `message-expired`, `rate-limited`, and `temporarily-unavailable`.

Every v1 Problem Details object contains the RFC 9457 members `type`, `title`, and `status`. It may also contain `detail` and `instance`. These five members are the only Problem Details members for which Hail v1 defines interoperable support. The `status` member exactly equals the HTTP response status and determines protocol behavior under the mappings and retry rules in this specification. When `type` is `about:blank`, `title` is the standard reason phrase for that status. An implementation may instead use an absolute URI for the applicable HTTP status definition in an RFC; receivers must not require or assign additional protocol semantics to that alternative URI.

V1 defines no Hail-specific problem type URI and no problem `reason` extension. A future version may define types below `https://hailproto.com/problems`. When the caller is eligible to learn it, `detail` provides a human-readable occurrence-specific explanation, for example `The grant has been revoked.` or `The envelope category was not granted.` Software may display, log, or otherwise carry this string, but clients must not parse or compare its text for interoperable control flow.

`instance` is a URI reference identifying this specific occurrence. It may identify a disclosure-safe provider log or support resource, but its presence does not grant access to that resource and clients are not required to dereference it.

Problem Details is the common error representation, not permission to disclose protected state. Every included member must comply with the disclosure tier determined below. A server omits `detail` and `instance` whenever either would reveal protected information. Problem responses must not expose recipient existence, relationship state, grant state, reply-capability state, replay state, key-resolution internals, provider topology, or policy decisions beyond what the authenticated caller is eligible to learn.

The generic `202`/`received` response is not an unsuccessful response and does not use Problem Details. Protected outcomes for callers that are not eligible for detail remain concealed by that generic receipt rather than converted into even a vague `4xx` or `5xx` response. `accepted` and `duplicate` are also not Problem Details errors; they return the applicable successful result or current signed delivery-status snapshot.

All explicit unsuccessful responses use `application/problem+json`. Implementations may include extension members for private or server-internal purposes, but Hail peers are not required to recognize them and they carry no v1 server-to-server semantics. Any additional interoperable member or behavior requires future Hail standardization. Receivers handle unrecognized extensions as required by RFC 9457.

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
Content-Type: application/json
Cache-Control: no-store

{"outcome":"received"}
```

The response body is a JSON object with exactly one member, `outcome`, whose value is the exact string `received`. The media type carries no parameters. Every generic response must use this same status, representation shape, privacy-relevant headers, and bounded timing behavior.

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

An eligible successful result returns the current signed delivery-status snapshot:

```http
HTTP/1.1 200 OK
Content-Type: application/jose+json
Cache-Control: no-store
```

The response body is exactly one Hail delivery-status snapshot in RFC 7515 flattened JWS JSON Serialization, using the profile defined in [delivery-state.md](delivery-state.md#status-signature-profile). The media type carries no parameters. The snapshot may report `accepted` or a later current state if processing advanced before the response. An identical duplicate of an accepted envelope returns the stored/current signed snapshot with the same `200` response. A duplicate whose stored result is an unsuccessful submission returns the applicable Problem Details response instead.

### Detailed Error Statuses

Safe transport errors use these mappings when the server can produce an HTTP response:

| Condition | HTTP status |
| --- | --- |
| Method other than `POST` | `405 Method Not Allowed` |
| Media type other than `application/jose+json` | `415 Unsupported Media Type` |
| Unsupported HTTP content encoding | `415 Unsupported Media Type` |
| Invalid HTTP framing | `400 Bad Request` |
| Request exceeds the envelope transport limit | `413 Content Too Large` |
| Relationship-independent source-wide or service-wide rate limit | `429 Too Many Requests` |

A `405` response includes `Allow: POST`. A `429` response includes `Retry-After` when the server supplies retry timing. These responses use only information determined independently of protected envelope and relationship state.

When the authenticated relationship disclosure rules permit an explicit protected rejection, these mappings are fixed:

| Submission outcome | HTTP status |
| --- | --- |
| `message-id-conflict` | `409 Conflict` |
| `invalid-envelope` | `400 Bad Request` |
| `unauthorized` | `403 Forbidden` |
| `message-expired` | `410 Gone` |
| `rate-limited` | `429 Too Many Requests` |
| `temporarily-unavailable` | `503 Service Unavailable` |

Every response in both tables uses `application/problem+json` under the Problem Details rules above. A `rate-limited` response includes `Retry-After` when the recipient supplies retry timing. The generic receipt continues to conceal protected outcomes from callers that are not eligible for detail.

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

- transport authentication, if any, in addition to the envelope JWS
- body-retrieval HTTP status mapping
- grant-publication HTTP details
- delivery-status push, acknowledgement, and authenticated query methods and paths
- standardized retry intervals and terminal-status retry duration

An authenticated status query, if included, must prove the original sender relationship and must not rely on a handle returned by the generic receipt.
