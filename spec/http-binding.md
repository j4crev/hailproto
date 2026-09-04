# Hail HTTPS Binding

Status: Draft, partial

This document defines the HTTPS behavior shared by Hail server-to-server operations. The current draft settles common service URL and Problem Details rules plus the core envelope-submission, body-retrieval, grant-publication, and delivery-status-push bindings, including terminal-status retries.

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

A Hail client must not follow an HTTP redirect for a federation operation and must not replay a request, bearer credential, or other authorization value to the redirect target. Provider migration is authenticated by a PLC update, not delegated by an old endpoint's `Location` header. Providers use DNS, reverse proxies, or other infrastructure behind the authenticated service endpoint for load balancing.

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
| `DiscoverIdentity` | Required composite prerequisite with context-dependent stages | A participant resolving an alias -> address domain and domain-selected binding host; a participant routing to or verifying a known DID -> PLC resolver | HTTPS authenticates the address domain's WebFinger response and protects retrieval from its selected binding URL; address authority comes from that domain selection plus the binding's `#hail-identity` signature; the verified PLC state authenticates Hail keys and service | A Hail address and canonical `acct:` URI when resolving an alias; otherwise a known `did:plc` DID. Address resolution yields a signed binding before DID resolution | Alias resolution yields a verified address-to-DID binding with an expiration; PLC resolution yields current Hail keys and canonical service base URL | WebFinger with relation `https://hailproto.com/rel/address-binding`, binding retrieval, and PLC resolution; this is not one Hail service-base endpoint. See [address-binding.md](address-binding.md) and [did-profile.md](did-profile.md). |
| `PublishGrantRevision` | Required for the POC | Recipient server acting for the grantor DID -> grantee DID's current Hail service | Canonical flattened JWS signed by the grantor DID's `#hail-identity` key; HTTPS authenticates the destination; additional HTTP Message Signatures deferred | Complete signed grant state with stable `grant_id`, ordered `revision`, predecessor, parties, scope, status, and timestamps | Sender verifies and stores a new revision as consent/list state; creation returns `201`; update and exact update retry return `204`; exact creation retry converges through `412` with a matching ETag | Conditional `PUT` to `grants/{grant_id}` with `application/hail-grant+json`; `If-None-Match: *` creates revision 1 and `If-Match` orders later revisions. See [grants.md](grants.md#web-native-publication). |
| `SubmitEnvelope` | Required; includes grant- and reply-authorized variants | Sender server -> recipient DID's current Hail service | HTTPS authenticates the recipient endpoint; the envelope JWS authenticates the `from` DID and signed contents; v1 requires no additional transport authentication | One closed signed `hail.envelope` for one recipient, containing grant or reply authorization and a detached-body descriptor | Generic `received` discloses only HTTP receipt; `accepted` fixes authorization and transfers body-processing responsibility; an identical `duplicate` reuses stored/current state. An eligible caller may receive the current signed status, including a later state | `POST` to relative operation path `envelopes` with `Content-Type: application/jose+json`; generic receipt is `202 application/json`; authenticated signed success is `200 application/jose+json`. See [envelopes.md](envelopes.md) and the submission sections below. |
| `RetrieveBody` | Required for the POC | Recipient server -> authenticated sender DID's current Hail service | An opaque bearer token authorizes retrieval and is bound by the signed envelope to the recipient, body, and message; v1 does not prove that the requester possesses the recipient DID's key; proof of possession is deferred | Body digest in the operation path and bearer token in `Authorization`; optional supported content negotiation | `200` carrying immutable canonical body bytes, optionally gzip-coded; the recipient verifies size, digest, media type, profile, canonical encoding, and schema | `GET` from `bodies/{digest}`, where `{digest}` is the exact 43-character unpadded base64url SHA-256 value from the envelope; redirects prohibited. Failure statuses are defined below. See [bodies.md](bodies.md#retrieval-endpoint). |
| `PushDeliveryStatus` | Terminal push required | Recipient server -> original sender DID's current Hail service | HTTPS authenticates the sender endpoint; the status JWS authenticates the recipient DID and status contents; no additional v1 transport authentication | One closed signed `hail.delivery-status` snapshot with parties, message ID, envelope digest, revision, state, occurrence time, and state-dependent fields | `204` acknowledges a valid new, duplicate, or stale snapshot; a stale snapshot does not replace newer state | `PUT` to `deliveries/{envelope_digest}` with `application/jose+json`; one status per request; terminal snapshots are pushed at least once. See [delivery-state.md](delivery-state.md#status-reporting). |
| `QueryDeliveryStatus` | Deferred from v1 | Expected caller and receiver, authentication, request, result, and anti-oracle behavior remain future work | Open | Open | Open | No v1 method or path. An authenticated duplicate envelope submission provides current-status recovery during its retry window. See [delivery-state.md](delivery-state.md#status-reporting). |

### Behavior And Privacy

| Operation | Rejection or failure semantics | Idempotency | Retry behavior | Privacy constraints |
| --- | --- | --- | --- | --- |
| `DiscoverIdentity` | Address, WebFinger, binding, signature, expiration, PLC-resolution, or safe-fetch failure prevents verified resolution; exact external error taxonomy open | Component retrievals are read-only, but discovery results may change or expire; no abstract idempotency contract is defined | Address discovery permits up to three safe HTTPS WebFinger redirects, prohibits binding redirects, and caches a verified result for at most one hour. PLC mirror and recovery-window policy remains partly open. Endpoint refresh rules above apply only after a `#hail` service has been discovered | WebFinger may enable address enumeration; implementations rate-limit and minimize metadata. Address bindings intentionally avoid permanent address history. Routine federation from known DIDs does not re-resolve human-readable addresses. |
| `PublishGrantRevision` | Malformed or unauthenticated protected requests use uniform `400`; missing preconditions use `428`; failed preconditions use `412`; revision and lineage conflicts use `409`; throttling uses `429`; temporary failure uses `503` | Conditional `PUT`, full-state revisions, canonical signed-state digests, and strong ETags make exact retransmission convergent; revocation is a terminal revision, not `DELETE` | Queue and retry transient publication failure with bounded exponential backoff and jitter; honor `Retry-After`; retransmit missing revisions; local consent changes never wait for publication | Grants are private relationship state, use `Cache-Control: no-store`, and receive uniform failures before grantor authentication and local-target confirmation. They contain no message body or contact-request content. |
| `SubmitEnvelope` | Uses the closed outcome set below. Conflict, invalid representation, unauthorized submission, and expiration are permanent; rate limiting and temporary unavailability are retryable. Reply authorization additionally rejects missing, expired, disallowed, or competing claims | `(authenticated sender DID, message_id)` is the key; an identical canonical payload returns stored/current state, while different content is a permanent conflict. Reply acceptance atomically claims the single-use capability; delivery consumes it; terminal failure or cancellation releases it | Ambiguous transport or generic `received` permits byte-identical retry with the same ID; honor `Retry-After`; after `accepted`, the recipient owns body retries | Protected outcomes remain generic until the sender is authenticated with current or previous relationship state. Generic responses reveal no recipient, relationship, replay, or acceptance state and follow the bounded schedule below. |
| `RetrieveBody` | Missing body and invalid, mismatched, or expired authorization must not be distinguishable; retryable transport or availability failures and permanent integrity or authorization failures feed the delivery state machine | Immutable body bytes and the same token may be retrieved repeatedly for the same envelope; matching recipient-and-sender cache provenance may avoid another fetch | Recipient retries with bounded backoff and jitter until the effective deadline, preserving digest and token; endpoint migration follows fresh DID resolution rather than redirects | Token appears only in `Authorization`, is excluded from logs, and is stored hashed by the sender. Fetches are delivery operations, not open/read signals. Cross-recipient cache state must not leak. |
| `PushDeliveryStatus` | Validly handled status uses `204`; authenticated malformed semantics use `400`; authenticated stream conflicts use `409`; protected unknown or unauthenticated cases use generic `202`; throttling uses `429`; temporary failure uses `503` | At-least-once `PUT`; exact duplicates and stale snapshots are acknowledged without mutation, while higher valid revisions advance state | Recipient uses the fixed jittered schedule and retries through the later of the replay deadline or 30 days after the terminal transition unless acknowledged or permanently rejected | Generic `202` conceals sent-envelope and relationship state. Detailed errors require an authenticated signer and matching sent-envelope relationship. Status reports server processing only, never user activity. |
| `QueryDeliveryStatus` | Deferred; any future design must avoid recipient, relationship, replay, and message-ID oracles | Open | Open | A future query must independently authenticate the original sender; possession of a message ID or generic receipt is insufficient. |

`SubmitReply` is not a separate transport operation. A reply is an ordinary `SubmitEnvelope` request with reply authorization and the role reversal defined in [envelopes.md](envelopes.md#reply-authorization).

Status acknowledgement is the `204 No Content` response to `PushDeliveryStatus`. There is no separate acknowledgement request object, method, path, or signature.

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

V1 requires no transport authentication in addition to HTTPS and the envelope JWS. HTTPS authenticates the recipient service endpoint and protects the exchange in transit. The JWS authenticates the sender DID and signed envelope contents. Mutual TLS, bearer credentials, RFC 9421 HTTP Message Signatures, and private reverse-proxy authentication carry no Hail envelope-submission semantics and never replace JWS verification. Deployments may use additional private transport controls without requiring federation peers to support them.

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

## Body Retrieval Method And Path

`RetrieveBody` uses:

```http
GET {hail-service-base}/bodies/{digest}
```

The relative operation path begins with the literal segment `bodies`, followed by one dynamic digest segment. No trailing slash is allowed. `{digest}` is the exact `body.digest.value` from the signed envelope: the canonical unpadded base64url encoding of the 32-byte SHA-256 digest. It is exactly 43 ASCII characters from `A-Z`, `a-z`, `0-9`, `-`, and `_`, contains no `=` padding, and is inserted as a literal path segment without percent encoding. A noncanonical or invalid digest segment receives the uniform `404` response.

## Body Retrieval Status Mapping

`RetrieveBody` uses `GET`. Its success and explicit error responses are:

| Condition | HTTP status | Recipient behavior |
| --- | --- | --- |
| Successful body response | `200 OK` | Verify the complete response under the signed body descriptor before delivery |
| Missing, malformed, unknown, expired, or mismatched bearer authorization | `404 Not Found` | Treat as permanent authorization failure while the signed authorization should still be valid |
| No authorization record for the requested digest | `404 Not Found` | Do not infer whether body bytes exist |
| Valid token and matching digest, but committed body temporarily unavailable | `503 Service Unavailable` | Retry within the effective delivery deadline |
| Retrieval rate limited | `429 Too Many Requests` | Retry within the deadline and honor valid `Retry-After` guidance |
| Requested representation is not acceptable | `406 Not Acceptable` | Treat as unsupported representation |
| Method other than `GET` | `405 Method Not Allowed` | Do not retry with that method; response includes `Allow: GET` |

Every explicit error uses `application/problem+json` under the shared Problem Details profile. The uniform `404` response uses `type: about:blank`, `title: Not Found`, and `status: 404`; it omits `detail`, `instance`, and `WWW-Authenticate`. Its status, body shape, privacy-relevant headers, and bounded timing behavior are the same for all authorization failures and do not depend on whether body bytes exist.

A `503` response is permitted for a missing committed body only after the token and requested digest match an unexpired authorization record. That authorized caller already knows the body should exist. After authorization expiration, the server returns the uniform `404`; the recipient determines from its signed envelope deadline that retrieval has failed permanently.

A `429` or `503` response may include disclosure-safe `detail` and `instance` and includes `Retry-After` when the server supplies retry timing. Unexpected `5xx` responses and transport failures remain retryable under the body and delivery-state deadlines. A Hail body server uses `503`, rather than another `5xx`, when intentionally reporting temporary body unavailability.

Size, digest, media-type, canonicalization, schema, decompression, and other integrity failures detected after a `200` response are not remapped to HTTP statuses. The recipient discards the response and applies the permanent delivery failure defined by the delivery-state specification.

## Grant Publication Binding

`PublishGrantRevision` uses:

```http
PUT {hail-service-base}/grants/{grant_id}
Content-Type: application/hail-grant+json
Cache-Control: no-store
```

The request body is exactly one canonical flattened JWS using the grant signature profile in [grants.md](grants.md#signature-and-representation-profile). The media type carries no parameters, and v1 applies no HTTP content coding. The path ID is the exact canonical lowercase UUIDv7 from the signed payload and matches `[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}` without percent encoding.

Revision `1` requires `If-None-Match: *`. A later revision, including revocation, requires `If-Match` containing the strong ETag of the preceding revision. That ETag's opaque value is the 43-character unpadded base64url SHA-256 digest of the preceding revision's complete canonical JWS bytes and exactly equals the new payload's `previous` value when the ETag quotes are removed.

Revision `1` includes exactly `If-None-Match: *` and omits `If-Match`. A later revision includes exactly one `If-Match` field containing one strong entity-tag and omits `If-None-Match`. Its opaque value exactly equals the signed `previous` value. Weak entity-tags, lists, `If-Match: *`, both conditional fields, and the conditional field inappropriate for the signed revision are invalid.

Success and convergence use these mappings:

| Condition | HTTP result |
| --- | --- |
| Valid revision `1` and no existing grant with that ID | `201 Created` with `Location` and the new strong `ETag` |
| Valid later revision applied | `204 No Content` with the new strong `ETag` |
| Exact later revision already current | `204 No Content` with the matching current strong `ETag` |
| Exact revision `1` already current | `412 Precondition Failed` with the matching current strong `ETag` |

The `201` and `204` responses have no content and include `Cache-Control: no-store`. `Location` is the target grant URL and appears only on `201`.

The publishing client treats the `412` creation response as successful idempotent convergence only when the response ETag exactly equals its submitted canonical JWS digest. A missing or different ETag is not evidence of publication. A different signed representation under the same grant ID is a `409` conflict rather than a duplicate. For an exact later-revision retry, RFC 9110 permits `204` after the server verifies that the requested state change was already applied even though the original `If-Match` value no longer identifies the current revision.

Grant publication errors use:

| Condition | HTTP status |
| --- | --- |
| Method other than `PUT` | `405 Method Not Allowed` with `Allow: PUT` |
| Wrong media type or unsupported HTTP content coding | `415 Unsupported Media Type` |
| Request exceeds the supported grant transport limit | `413 Content Too Large` |
| Malformed path, JSON, JWS, protected header, or grant payload | `400 Bad Request` |
| Invalid or unverifiable signature before grantor authentication | Uniform `400 Bad Request` |
| Required `If-None-Match` or `If-Match` absent after grantor authentication | `428 Precondition Required` |
| Conditional field malformed, prohibited, or inappropriate for the signed revision | `400 Bad Request` |
| Nonduplicate precondition failure without a more specific Hail conflict | `412 Precondition Failed` |
| Same revision with different content, stale revision, revision gap, predecessor fork, immutable-field change, grant-ID reuse, or update after revocation | `409 Conflict` |
| Rate limited | `429 Too Many Requests` |
| Temporarily unavailable | `503 Service Unavailable` |

All explicit errors use `application/problem+json`. `429` and `503` include `Retry-After` when the server supplies retry timing. Conflict and precondition failures require reconciliation rather than unchanged automatic retry, except for the exact-convergence cases above.

Before a valid grantor `#hail-identity` signature is verified and the signed grantee is confirmed as locally authoritative, every protected failure uses the same `400` Problem Details response with `type: about:blank`, `title: Bad Request`, and `status: 400`. It omits `detail` and `instance` and uses a common representation shape, privacy-relevant headers, and bounded timing behavior. This includes missing or revision-inappropriate conditional fields before authentication; the detailed `428` mapping applies only after authentication and local-target confirmation. Safe transport errors selected independently of claimed or actual grant state may return explicit `405`, `413`, or `415` responses before that schedule. A source-wide or service-wide `429` may also be returned early only when selected independently of protected grant state. After authentication and local-target confirmation, disclosure-safe `detail` may explain the applicable conflict, throttling, or temporary failure; clients determine behavior from the HTTP status.

## Delivery Status Push Binding

`PushDeliveryStatus` uses:

```http
PUT {sender-hail-service-base}/deliveries/{envelope_digest}
Content-Type: application/jose+json
Cache-Control: no-store
```

The destination is the original sender DID's current authenticated Hail service. The relative path contains the literal `deliveries` segment followed by the status payload's exact `envelope_digest.value`: 43 ASCII characters containing the canonical unpadded base64url encoding of the 32-byte SHA-256 envelope-payload digest. It contains no padding or percent encoding and must match the sender's original sent-envelope record.

The original sender creates this target delivery-tracking resource when it durably records the outbound signed envelope, before submission. A status `PUT` updates that existing resource and never creates a delivery record from an unsolicited status. This is why the first valid status push returns `204 No Content` rather than `201 Created`.

The delivery resource is monotonic rather than an unconstrained replaceable representation. `PUT` asks the sender to incorporate the signed snapshot if it advances the stream or confirm that the sender already holds equal or later valid state. A stale snapshot therefore succeeds without replacing newer state.

Each request contains exactly one Hail delivery-status snapshot in RFC 7515 flattened JWS JSON Serialization with protected `typ: hail-delivery-status+jws`. The request uses `application/jose+json` with no parameters, applies no HTTP content coding, and has a maximum complete representation size of 16384 bytes. Batching is not part of v1.

V1 recipients asynchronously push `delivered`, `failed`, and `cancelled` terminal snapshots. They do not asynchronously push `accepted` or `on-hold`; a current nonterminal snapshot can be returned through authenticated envelope submission or duplicate retry. A conforming sender endpoint may safely acknowledge an already-known valid stale snapshot without changing state. Read and open receipts are not delivery states and are deferred to a future, separately consented protocol.

HTTPS authenticates the original sender's receiving endpoint and protects the exchange. The status JWS authenticates the recipient DID and signed status contents. V1 requires no mutual TLS, bearer credential, HTTP Message Signature, or other transport authentication. Before accepting a status, the sender verifies the JWS profile and signature against the status `from` DID's current `#hail-messaging` key, then matches `from`, `to`, `message_id`, and `envelope_digest` to its original sent-envelope record and validates revision ordering and the state transition.

### Acknowledgement And Errors

A validly handled status receives:

```http
HTTP/1.1 204 No Content
Cache-Control: no-store
```

`204` acknowledges a newly accepted higher revision, an exact duplicate, or a valid lower revision that is stale relative to the sender's current state. A duplicate or stale request does not mutate state. The response has no content and no ETag. Receipt of `204` ends retries for that status revision.

Explicit errors use these mappings:

| Condition | HTTP status |
| --- | --- |
| Method other than `PUT` | `405 Method Not Allowed` with `Allow: PUT` |
| Media type other than `application/jose+json`, or any HTTP content coding | `415 Unsupported Media Type` |
| Request exceeds 16384 bytes | `413 Content Too Large` |
| Malformed or noncanonical envelope-digest path segment | `400 Bad Request` |
| Authenticated malformed status semantics or authenticated path/payload mismatch | `400 Bad Request` |
| Same revision with different payload, invalid state transition, or higher revision after a terminal state | `409 Conflict` |
| Rate limited | `429 Too Many Requests` |
| Temporarily unavailable | `503 Service Unavailable` |

All explicit errors use `application/problem+json`. `429` and `503` include `Retry-After` when the server supplies retry timing. An authenticated `400` or `409` is permanent for that signed snapshot. Transport failure, generic `202`, `429`, and `503` remain retryable under the status retry rules.

### Disclosure

Safe errors selected entirely from bounded HTTP request properties may return `400` for a malformed digest segment, `405`, `413`, or `415` before protected status processing. A source-wide or service-wide `429` may also be returned early only when selected independently of protected delivery state. A syntactically valid but unknown digest remains protected and does not receive the explicit `400`.

Before the sender authenticates the status signer and matches the snapshot to an original sent-envelope record, every protected outcome uses:

```http
HTTP/1.1 202 Accepted
Content-Type: application/json
Cache-Control: no-store

{"outcome":"received"}
```

This response reports only HTTP receipt and is not a status acknowledgement. The recipient continues bounded retries because only `204` acknowledges the snapshot. The generic response has the same shape, privacy-relevant headers, and bounded timing behavior for invalid JSON or JWS, unknown or invalid keys, invalid signatures, a nonlocal `to` DID, an absent sent-envelope record, party or message-ID mismatch, envelope-digest mismatch, and protected processing that cannot finish within the schedule. It discloses no sent-message, relationship, revision, or terminal-state information.

After the signer and sent-envelope relationship are authenticated, the server returns the applicable `204`, `400`, `409`, `429`, or `503`. Disclosure-safe `detail` may explain malformed semantics, a revision conflict, an invalid transition, throttling, or temporary failure; clients determine behavior from the HTTP status.

### Status Query

`QueryDeliveryStatus` is not part of v1. During the envelope retry window, an original sender can resubmit the byte-identical signed envelope and receive the current signed status under the authenticated duplicate-submission rules. A future query operation must independently authenticate the original sender and define anti-oracle behavior before receiving a method or path. A generic submission or status-push receipt never supplies a query handle.

### Terminal Status Retry Schedule

The recipient attempts to push a newly committed terminal status immediately. After each unsuccessful attempt, it uses these nominal delays:

| Retry | Nominal delay after the preceding attempt |
| --- | --- |
| 1 | 30 seconds |
| 2 | 2 minutes |
| 3 | 10 minutes |
| 4 | 1 hour |
| 5 | 6 hours |
| Every later retry | 24 hours |

For a nominal delay of `D` whole seconds, the recipient independently selects a uniformly distributed integer number of seconds from `ceil(0.8 * D)` through `floor(1.2 * D)`, inclusive. It durably stores the resulting absolute `next_attempt_at` before completing processing of the failed attempt. Retry count and schedule do not reset after generic `202`, connection or transport failure, provider restart, DID endpoint migration, or another attempt carrying the same status revision.

Response handling is:

| Result | Retry behavior |
| --- | --- |
| `204` | Acknowledged; stop retrying this revision |
| Generic `202` | Not acknowledged; continue the schedule |
| `429` or `503` | Continue using the schedule and valid `Retry-After` guidance |
| Unexpected temporary `5xx` or ambiguous transport failure | Continue the schedule |
| `3xx` | Do not follow; refresh the destination DID under the endpoint-refresh rules and continue |
| Authenticated `400` or `409` | Permanent for this signed snapshot; stop automatic retry and flag local reconciliation |
| `405`, `413`, or `415` | Permanent interoperability or configuration failure; stop automatic retry and flag locally |

For `429` and `503`, the next delay is the later of the jittered local delay and a valid `Retry-After` delay after limiting the remote value to 24 hours. An invalid `Retry-After` is ignored. This prevents a remote server from suppressing status delivery for an arbitrary period while still honoring bounded retry guidance.

The minimum terminal-status retry deadline is:

```text
max(envelope replay deadline, terminal status occurred_at + 2592000 seconds)
```

The recipient continues scheduled attempts through this deadline unless it receives `204` or a permanent response identified above. It may retry longer by local policy. The recipient retains the canonical terminal status payload, signature-verification evidence, retry state, and destination DID through the deadline even if acknowledgement ends transmission earlier.

The sender cannot rely on an unauthenticated status `occurred_at` to decide retention. It retains the original sent-envelope and delivery-tracking record through at least `envelope replay deadline + 2592000 seconds`. This guarantees a full 30-day correlation window after any conforming terminal transition without allowing untrusted status input to extend retention.

A provider restart or continuity-preserving migration retains the retry count and next-attempt time. If the recipient's `#hail-messaging` key changes, the current provider signs a new wrapper around the same canonical status payload without changing its revision or `occurred_at`, as defined by the delivery-state signature profile.
