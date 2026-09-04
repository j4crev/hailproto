# Hail Grants

Status: Draft

This document defines the Hail Grant authorization object and its lifecycle.

A Hail Grant is a recipient-created, recipient-signed authorization permitting one sender DID to deliver a limited set of messages to one recipient DID.

## Core Rules

- The recipient creates the grant.
- The recipient server is authoritative for current grant state.
- A sender cannot create or expand a grant.
- A grant targets exact DIDs, not addresses, domains, keys, providers, or endpoints.
- A grant ID is a lookup key, not a bearer capability.
- Every grant is signed with the grantor DID's `#hail-identity` key.
- Grant updates are immutable, ordered revisions of a stable grant lineage.
- Revocation is immediate, unilateral, and terminal for that grant ID.
- Sender notification failure cannot delay local activation, restriction, or revocation.

## Grant Payload

Conceptual v1 payload:

```json
{
  "type": "hail.grant",
  "version": 1,
  "grant_id": "01954144-8097-7a9d-a7a8-ef29a823eaf1",
  "revision": 1,
  "previous": null,
  "grantor": "did:plc:recipient123",
  "grantee": "did:web:example-store.com:updates",
  "scope": [
    {
      "type": "categories",
      "values": ["receipts", "security-alerts"]
    }
  ],
  "status": "active",
  "issued_at": 1787851200,
  "updated_at": 1787851200,
  "expires_at": null,
  "consent_context": {
    "grantee_address": "updates@example-store.com",
    "address_binding_hash": {
      "algorithm": "sha-256",
      "value": "base64url-sha256-address-binding-jws"
    }
  },
  "key_id": "did:plc:recipient123#hail-identity"
}
```

The signature wrapper is separate from the payload and uses the flattened JWS profile defined below.

Unknown top-level fields are rejected in v1 unless a future specification explicitly defines an extension mechanism.

## Signature And Representation Profile

Hail Grant v1 uses RFC 8785 canonical JSON in RFC 7515 flattened JWS JSON Serialization. The complete wrapper is a closed JSON object containing exactly `protected`, `payload`, and `signature`; an unprotected `header` member is prohibited.

Conceptual wrapper:

```json
{
  "payload": "base64url-jcs-grant-payload",
  "protected": "base64url-protected-header",
  "signature": "base64url-ed25519-signature"
}
```

The decoded protected header is the closed object:

```json
{
  "alg": "Ed25519",
  "kid": "did:plc:recipient123#hail-identity",
  "typ": "hail-grant+jws"
}
```

Rules:

- The grant payload, protected header, and complete flattened JWS wrapper use their exact RFC 8785 canonical UTF-8 representations.
- `alg` is the RFC 9864 value `Ed25519`; `EdDSA` and algorithm fallback are rejected.
- `kid` is the absolute DID URL of the grantor's authorized `#hail-identity` verification method.
- `kid` exactly equals the payload's `key_id`, and its controller exactly equals the payload's `grantor`.
- `typ` is the exact string `hail-grant+jws`.
- All three protected parameters are required. Unknown protected parameters and all unprotected parameters are rejected.
- The payload and protected-header bytes are base64url encoded without padding and signed using the RFC 7515 JWS Signing Input.
- Duplicate member names, invalid UTF-8, non-I-JSON values, padded or noncanonical base64url, and decoded payload or header bytes that are not their exact JCS representations are rejected.

The complete canonical JWS bytes are the immutable signed representation of one grant revision. A receiver stores those exact bytes and does not parse and reserialize an accepted revision. The HTTP request uses `Content-Type: application/hail-grant+json`; this provisional v1 media type contains the flattened JWS wrapper and carries no parameters.

## Fields

### `type`

The exact value is `hail.grant`.

This provides object identification and signature domain separation.

### `version`

The grant schema version. V1 uses integer `1`.

`version` differs from `revision`:

- `version` selects schema, field semantics, canonicalization, and validation rules.
- `revision` orders state changes within one grant lineage.

All revisions in a v1 grant lineage use the same `version`. A future specification may define a secure cross-version transition; otherwise an incompatible schema requires a new grant lineage.

### `grant_id`

V1 uses a UUIDv7 conforming to RFC 9562 in canonical lowercase string form.

UUIDv7 provides standardized distributed generation, chronological ordering, and database index locality. Its embedded timestamp is not considered private because the signed grant already includes issuance time.

The grant ID is public relationship metadata and must not be treated as a secret or authorization token.

### `revision`

A positive integer beginning at `1` and increasing by exactly one for each state change.

### `previous`

Revision `1` uses `null`. Later revisions contain the digest of the preceding signed grant state.

For later revisions, `previous` is the exact 43-character unpadded base64url encoding of SHA-256 over the preceding revision's complete canonical flattened JWS bytes. It decodes to exactly 32 bytes. Padding, percent encoding, and noncanonical base64url are rejected.

### `grantor`

The exact recipient DID creating the grant.

### `grantee`

The exact sender DID receiving delivery permission.

### `scope`

A non-empty array of registered Hail scope selectors. See [Scope](#scope).

### `status`

One of:

```text
active
revoked
```

Revoked is terminal for the grant ID.

### `issued_at`

Unix time in seconds when revision `1` was created. It remains unchanged throughout the lineage.

### `updated_at`

Unix time in seconds when the current revision was created.

### `expires_at`

Unix time in seconds after which delivery is not authorized, or `null` for no protocol-level expiration.

Transactional grants should generally expire. Ongoing subscriptions may use `null`, subject to recipient policy.

POC validation permits at most 300 seconds of clock tolerance. A grant with an `expires_at` value is expired when recipient time is more than 300 seconds after that value. Clock tolerance does not alter the signed expiration or permit local policy to extend it further.

### `consent_context`

Optional non-authoritative metadata recording what the user verified during consent. When present in v1, it is a closed object containing exactly `grantee_address` and `address_binding_hash`; both fields are required.

Fields:

- `grantee_address`: Canonical sender address shown to the recipient.
- `address_binding_hash`: A closed object containing `algorithm` with exact value `sha-256` and `value` with the exact 43-character unpadded base64url SHA-256 digest of the verified Address Binding's complete canonical flattened JWS bytes.

The retained Address Binding's canonical `address` must exactly equal `grantee_address`, and its `did` must exactly equal the grant's `grantee`. The grantor retains the exact Address Binding JWS and its DID-resolution verification evidence for as long as it retains the corresponding grant revision or consent evidence. The digest therefore commits to the matching binding payload, protected signer key, and signature that were verified, as defined in [address-binding.md](address-binding.md#binding-representation-digest).

Authorization still targets `grantee`, not this address metadata.

### `key_id`

The absolute DID URL of the grantor's `#hail-identity` key, as defined by [did-profile.md](did-profile.md).

## Scope

`scope` is retained as a deliberate boundary for a small set of broad, protocol-defined authorization selectors.

It is not an open extension system.

V1 defines exactly two selector types:

```text
categories
uncategorized
```

Adding a future selector requires a Hail specification amendment, security review, interoperability tests, and capability advertisement. Vendor-defined, sender-defined, URI-namespaced, or silently ignored scope types are not permitted.

General scope rules:

- The array must contain at least one selector.
- Unknown or unsupported selector types cause grant rejection.
- Unsupported selectors must never be ignored.
- Duplicate selector types are invalid.
- Different selector types are combined with logical AND.
- Multiple values within one selector are combined with logical OR.
- Empty value arrays are invalid.
- V1 grants contain exactly one selector because `categories` and `uncategorized` are mutually exclusive.

The AND rule is defined now so a small number of future, broadly applicable selectors can be composed without creating a Boolean authorization language. Any future change to v1 relationship cardinality or alternative authorization paths requires an explicit specification amendment.

### Scope Boundaries

Scope describes what messages the exact grantee DID may deliver. It does not redefine who the grantee is.

- Direct person-to-person grants use `uncategorized` scope between exact individual DIDs.
- Trust between partner organizations targets an organization DID and requires separately verifiable delegation to employee or service DIDs.
- Company mergers use DID continuity, succession, or delegation rules rather than a merger-specific scope selector.
- Expiration, rate limits, body limits, attachment policy, and reply capability are constraints or separate authorization mechanisms, not scope selector types.

These boundaries are intended to resist pressure to turn `scope` into a general policy language.

### Categorized Scope

```json
{
  "scope": [
    {
      "type": "categories",
      "values": ["receipts", "security-alerts"]
    }
  ]
}
```

Rules:

- `values` is required and non-empty.
- Every value is a stable sender-defined category ID using the v1 grammar defined in [envelopes.md](envelopes.md#category).
- Values are unique and serialized in ascending bytewise order of their ASCII category IDs.
- The grant authorizes a message when its category equals any listed value.
- The grant does not authorize messages without a category.
- There is no wildcard category.

Category IDs are scoped to the grantee DID. The tuple `(grantee DID, category ID)` is globally unambiguous, so category IDs do not need to be URLs.

A sender must not repurpose an existing category ID for materially different content. A materially new purpose requires a new category ID and explicit opt-in.

### Uncategorized Scope

```json
{
  "scope": [
    {
      "type": "uncategorized"
    }
  ]
}
```

Rules:

- The selector has no additional fields.
- It authorizes only messages that omit category.
- It does not authorize any category introduced later.
- If a previously uncategorized sender introduces categories, each category requires explicit opt-in.

## Relationship Cardinality

V1 permits at most one active grant between one grantor DID and one grantee DID.

Category changes update that grant's scope rather than creating parallel active grants.

After revocation, re-establishing the relationship creates a new grant ID.

## Immutable And Mutable Fields

Immutable within a lineage:

- `type`
- `version`
- `grant_id`
- `grantor`
- `grantee`
- `issued_at`

Mutable through a signed revision:

- `scope`
- `status`
- `updated_at`
- `expires_at`
- `consent_context`

Changing either DID requires a new grant.

## Creation And Activation

High-level creation flow:

1. The recipient resolves and verifies the sender's Hail Address Binding.
2. The client displays the verified address, DID, sender profile, and available categories.
3. The recipient explicitly selects categorized or uncategorized delivery.
4. The recipient creates revision `1` and signs it with `#hail-identity`.
5. The recipient server verifies and stores the grant locally.
6. The grant becomes active locally immediately.
7. The recipient server asynchronously publishes it to the sender's current Hail service.
8. The sender verifies and stores the signed grant as consent evidence and send-list state.

Sender acknowledgment is not required for local activation. Until publication succeeds, the sender simply does not know to deliver.

## Local Lookup And Delivery

Every grant-authorized Hail Envelope includes `authorization.grant_id` as defined in [envelopes.md](envelopes.md).

The recipient server performs its initial local lookup using:

```text
(recipient DID, grant ID)
```

It then validates:

1. The grant exists.
2. `grantor` equals the envelope recipient DID.
3. `grantee` equals the authenticated envelope sender DID.
4. The latest status is active.
5. The grant is not expired.
6. The message satisfies every scope selector.
7. Other recipient policy permits delivery.
8. The envelope signature is valid under the sender's `#hail-messaging` key.

The grant ID is an efficient lookup hint. Possessing it does not bypass sender authentication or any grant check.

The sender indexes its copy by recipient DID and grant ID and resolves the recipient DID when delivering. Provider endpoints are not durable grant state.

## Revisions

Every update is a complete signed snapshot, not a patch.

The sender accepts a revision when:

- its signature is valid under the grantor's `#hail-identity` key
- immutable fields match the stored lineage
- `revision` is the stored revision plus one
- `previous` matches the preceding signed-state digest

Revision handling:

- Exact same canonical JWS representation: idempotent success.
- Same revision with different content: conflict.
- Lower revision: stale conflict.
- Revision gap: conflict; the recipient retransmits missing revisions.
- Invalid predecessor digest: fork conflict.
- Changed immutable field: invalid grant.

Full snapshots simplify validation, recovery, and auditing and avoid patch-order ambiguity.

Updates can:

- add explicitly approved categories
- remove categories
- switch between categorized and uncategorized scope after explicit consent
- renew or change expiration
- update consent context
- revoke the grant

Removing the last selected category revokes the grant unless the recipient explicitly approves uncategorized scope.

## Revocation

Revocation creates a signed revision with `status: "revoked"`.

Rules:

- The recipient server enforces revocation locally before notifying the sender.
- Revocation notification failure cannot delay enforcement.
- Revocation immediately prevents envelopes not yet accepted; an envelope whose acceptance transaction committed first retains its fixed authorization under [delivery-state.md](delivery-state.md).
- A revoked grant ID can never become active again.
- The recipient retains a tombstone sufficient to reject replayed older revisions.
- The sender retains signed revocation evidence as needed for compliance and list cleanup.
- Re-subscribing creates a new grant ID.

If the sender has not received the revocation, its next delivery attempt is rejected and may return a detailed revocation result only because a prior authenticated grant relationship existed.

## Expiration

Expiration prevents delivery while the latest grant state remains expired.

Unlike revocation, expiration is not terminal. The recipient may publish a higher active revision with a future `expires_at` to renew the grant.

Recipient policy may impose a shorter effective lifetime than the signed grant. Local policy cannot expand the signed authorization.

## Replacement

Most changes use revisions of the same grant.

A new grant ID is required when:

- a revoked relationship is re-established
- grantor DID changes
- grantee DID changes
- the parties intentionally establish a new consent lineage
- an incompatible future schema does not define a secure lineage upgrade

A future `replaces_grant_id` field may connect lineages for auditing, but it would not inherit authorization. It is not part of v1.

## Web-Native Publication

DNS and WebFinger discover identities and services. They are not used to publish grants because grants are private, user-specific, mutable, and immediately revocable.

The recipient publishes a signed grant state to the sender's resolved Hail base endpoint using idempotent HTTP `PUT`:

```http
PUT {hail-service-base}/grants/{grant_id}
```

The relative path contains the literal `grants` segment followed by the grant's canonical lowercase UUIDv7. The path value is exactly 36 ASCII characters, matches `[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}`, contains no percent encoding, and exactly equals the signed payload's `grant_id`. A malformed or mismatched ID follows the generic `400` behavior below.

The request body is the exact canonical flattened JWS representation and uses `Content-Type: application/hail-grant+json` with no parameters. V1 applies no HTTP content coding to a grant request. HTTPS authenticates the destination and protects the exchange; the grant JWS authenticates the grantor and signed state. V1 requires no additional transport authentication.

Initial publication requires `If-None-Match: *`:

```http
PUT {hail-service-base}/grants/01954144-8097-7a9d-a7a8-ef29a823eaf1
Content-Type: application/hail-grant+json
If-None-Match: *
Cache-Control: no-store
```

Revision `1` includes exactly `If-None-Match: *` and omits `If-Match`. A later revision includes exactly one `If-Match` field containing one strong entity-tag and omits `If-None-Match`. The entity-tag's opaque value exactly equals the signed payload's `previous` value. Weak entity-tags, entity-tag lists, `If-Match: *`, both conditional fields, and the conditional field inappropriate for the revision are invalid grant requests.

Successful creation returns:

```http
HTTP/1.1 201 Created
ETag: "base64url-sha256-canonical-jws"
Location: {hail-service-base}/grants/01954144-8097-7a9d-a7a8-ef29a823eaf1
Cache-Control: no-store
```

The `ETag` is a strong validator whose opaque value is the same 43-character digest used by a successor's `previous` field, enclosed in double quotes. It hashes the complete canonical JWS bytes, including the protected header and signature. The server emits an ETag only after storing the exact request representation without transformation.

A later revision, including revocation, requires `If-Match` with the preceding revision's ETag:

```http
PUT {hail-service-base}/grants/01954144-8097-7a9d-a7a8-ef29a823eaf1
Content-Type: application/hail-grant+json
If-Match: "base64url-sha256-previous-canonical-jws"
Cache-Control: no-store
```

Successful update:

```http
HTTP/1.1 204 No Content
ETag: "base64url-sha256-new-canonical-jws"
Cache-Control: no-store
```

`201` and `204` responses have no content. `Location` appears on `201` and is the target grant URL. Every `201` or `204` response includes the current strong ETag.

### Conditional Creation And Exact Retries

The server performs ordinary request validation, signature verification, and Hail conflict detection before applying HTTP preconditions, as permitted by RFC 9110. Initial publication has these outcomes:

| Stored state | HTTP result |
| --- | --- |
| No grant uses the ID and revision `1` is valid | Store it and return `201 Created` |
| The exact canonical signed revision is already current | Return `412 Precondition Failed` with the matching current ETag; do not write again |
| Different signed state already uses the grant ID | Return `409 Conflict` |

RFC 9110 requires `412` when `If-None-Match: *` is false for `PUT`. Hail treats that response as successful idempotent convergence only when its ETag exactly equals the digest of the submitted canonical JWS. A missing or different ETag is not evidence that publication succeeded.

For later revisions, an exact retry after the update was already applied returns `204 No Content` with the current matching ETag. RFC 9110 permits a successful response to a false `If-Match` when the origin server verifies that the requested state change was already applied. Any different current state follows the conflict or precondition rules below.

Grant publication uses:

- idempotent `PUT`
- strong `ETag` validators
- `If-None-Match` for creation
- `If-Match` for ordered updates
- `Location` for a created resource
- `Cache-Control: no-store`
- `Retry-After` for temporary throttling
- RFC 9457 Problem Details for errors

Revocation is published as a signed terminal revision using `PUT`, not HTTP `DELETE`. A signed tombstone provides ordering, replay protection, and evidence that deletion alone cannot provide.

## Problem Details

HTTP errors use RFC 9457 with media type:

```text
application/problem+json
```

Conceptual conflict response:

```json
{
  "type": "about:blank",
  "title": "Conflict",
  "status": 409,
  "detail": "The submitted revision does not follow the stored revision."
}
```

The shared HTTP binding defines the v1 Problem Details members and type rules. Grant publication uses these status mappings:

| Condition | HTTP status |
| --- | --- |
| Method other than `PUT` | `405 Method Not Allowed` with `Allow: PUT` |
| Media type other than `application/hail-grant+json`, or unsupported HTTP content coding | `415 Unsupported Media Type` |
| Request exceeds the supported grant transport limit | `413 Content Too Large` |
| Malformed path, JSON, JWS, protected header, or grant payload | `400 Bad Request` |
| Invalid or unverifiable grant signature before caller authentication | Uniform `400 Bad Request` |
| Required `If-None-Match` or `If-Match` is absent after grantor authentication | `428 Precondition Required` |
| Conditional field is malformed, uses a prohibited form, or is inappropriate for the signed revision | `400 Bad Request` |
| A nonduplicate HTTP precondition fails without a more specific Hail conflict | `412 Precondition Failed` |
| Same revision with different content, stale revision, revision gap, predecessor fork, immutable-field change, grant-ID reuse, or update after terminal revocation | `409 Conflict` |
| Rate limited | `429 Too Many Requests` |
| Temporarily unavailable | `503 Service Unavailable` |

`429` and `503` include `Retry-After` when the server supplies retry timing. Precondition and conflict failures are permanent until the publisher reconciles its state; they are not retried unchanged except for the exact-convergence cases above.

### Disclosure

Before the server verifies a valid grantor `#hail-identity` signature and confirms that the signed grantee is locally authoritative, every protected failure uses the same response:

```http
HTTP/1.1 400 Bad Request
Content-Type: application/problem+json
Cache-Control: no-store

{"type":"about:blank","title":"Bad Request","status":400}
```

The generic response omits `detail` and `instance` and uses the same representation shape, privacy-relevant headers, and bounded timing behavior for malformed protected content, unknown keys, invalid signatures, claimed-party mismatches, unknown or nonlocal grantees, and missing or revision-inappropriate preconditions before authentication. The detailed `428` mapping applies only after grantor authentication and local-target confirmation. Safe transport errors selected independently of claimed or actual grant state may return their explicit `405`, `413`, or `415` responses before this schedule. A source-wide or service-wide `429` may also be returned early only when selected independently of protected grant state.

After authentication and local-target confirmation, the server returns the applicable detailed status. Disclosure-safe `detail` may explain a stale revision, gap, fork, immutable-field conflict, throttling, or temporary outage. Clients determine protocol behavior from the status and never parse `detail`.

## Retry And Synchronization

The recipient server queues grant publication and retries transient failures with bounded exponential backoff and jitter.

The signed revision chain and HTTP conditional requests prevent retries from reordering or duplicating grant state.

Permanent conflicts require reconciliation. The recipient remains authoritative for delivery even while sender-side state is stale.

## Abuse Protection

The sender's grant endpoint is intentionally unsolicited and must enforce:

- strict request-size limits
- schema validation before expensive processing
- `#hail-identity` signature verification
- rate limits by source network, grantor DID, and provider
- active and pending grant quotas
- conflict detection for grant ID reuse
- generic failures before caller authentication
- `429` and `Retry-After` where appropriate

Grant publication contains no message body, HTML, assets, attachments, or user-visible contact request.

## HTTP Message Signatures

RFC 9421 HTTP Message Signatures may be defined by a future transport profile, but they do not replace the portable signed Hail Grant.

The grant must remain independently verifiable after transport and storage.

HTTP Message Signatures are not part of Hail v1.

## POC Requirements

The proof of concept implements:

- UUIDv7 grant IDs
- one active grant per grantor/grantee pair
- `categories` and `uncategorized` scope selectors only
- full-state signed revisions
- local authoritative state
- required envelope `authorization.grant_id`
- idempotent HTTPS `PUT`
- conditional updates using ETags
- RFC 8785 canonical payload, protected header, and flattened JWS wrapper
- RFC 7515 flattened JWS signed with RFC 9864 `Ed25519` and `#hail-identity`
- `application/hail-grant+json`
- canonical UUIDv7 grant path segment
- strong ETags and `previous` over complete canonical signed revisions
- signed terminal revocation
- RFC 9457 errors
- asynchronous publication retries

Deferred:

- additional scope types
- frequency and size limits in grants
- message-type restrictions
- organizational delegation
- multiple simultaneous active grants for one pair
- bulk grant publication
- HTTP Message Signatures
- automatic grant transfer between DIDs

## Open Questions

- What maximum grant size must servers accept?
- How long must revoked grant tombstones be retained?
- How does historical DID key verification interact with old grant revisions?
