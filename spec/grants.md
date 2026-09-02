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
    "address_binding_hash": "sha256:..."
  },
  "key_id": "did:plc:recipient123#hail-identity"
}
```

The signature wrapper is separate from the payload. Its exact encoding is defined by the Hail security profile.

Unknown top-level fields are rejected in v1 unless a future specification explicitly defines an extension mechanism.

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

The Hail security profile will define the exact hashed representation and digest encoding.

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

Optional non-authoritative metadata recording what the user verified during consent.

Candidate fields:

- `grantee_address`: Canonical sender address shown to the recipient.
- `address_binding_hash`: Digest of the verified Hail Address Binding.

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
- Every value is a stable sender-defined category ID.
- Values are unique and serialized in the canonical order required by the security profile.
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

- Exact duplicate: idempotent success.
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

The recipient publishes a signed grant state to the sender's resolved Hail base endpoint using idempotent HTTP `PUT`.

Conceptual initial request:

```http
PUT /hail/grants/01954144-8097-7a9d-a7a8-ef29a823eaf1
Content-Type: application/hail-grant+json
If-None-Match: *
Cache-Control: no-store
```

Conceptual response:

```http
HTTP/1.1 201 Created
ETag: "sha256-current-state"
Location: /hail/grants/01954144-8097-7a9d-a7a8-ef29a823eaf1
Cache-Control: no-store
```

Conceptual update:

```http
PUT /hail/grants/01954144-8097-7a9d-a7a8-ef29a823eaf1
If-Match: "sha256-previous-state"
Cache-Control: no-store
```

Successful update:

```http
HTTP/1.1 204 No Content
ETag: "sha256-new-state"
Cache-Control: no-store
```

The HTTP binding will finalize media types, paths, ETag calculation, and response codes.

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

The shared HTTP binding defines the v1 Problem Details members and type rules. The grant binding will finalize status mappings and which occurrence-specific `detail` may be disclosed.

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

RFC 9421 HTTP Message Signatures may later authenticate transport requests, but they do not replace the portable signed Hail Grant.

The grant must remain independently verifiable after transport and storage.

HTTP Message Signatures are deferred from the POC until the complete HTTP binding is specified.

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

- What exact canonical representation and signature wrapper signs a grant?
- What exact digest representation is used by `previous` and ETags?
- What maximum grant size must servers accept?
- How long must revoked grant tombstones be retained?
- How does historical DID key verification interact with old grant revisions?
- Which HTTP statuses represent grant-publication errors, and which occurrence-specific `detail` may be disclosed?
