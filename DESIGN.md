# Hail Protocol Concept Design Notes

This document is a nonnormative design overview. The files under [`spec/`](spec/) are authoritative where they differ. Sections explicitly labeled as future direction are not part of v0.

Hail Protocol is a federated, permission-based messaging concept intended to solve the downfalls of email by changing the default delivery model and strengthening sender identity, message authorization, deliverability, and client-side safety.

## Goals

- Prevent spam by default rather than filtering it after receipt.
- Support safe, rich messages.
- Allow federation between independently operated servers.
- Support user choice of providers and clients.
- Support portable identities for users and organizations with provider-issued or custom-domain addresses.
- Make sender authenticity visible at the consent moment, not hidden in technical headers.
- Use open standards where practical.
- Implementation should be approachable by hobbyists and independent developers.
- Explore future email-client and email-bridge integration without making it part of the v0 federation protocol or weakening Hail's authorization model.

## v0 Scope

v0 should focus primarily on B2C communication such as:

- newsletters
- receipts
- bookings
- account notifications
- promotions
- security alerts
- support replies to solicited messages

This is closer to consent-based business/customer messaging than a full replacement for all email conversations.

The initial prototype should validate:

- sender discovery
- receiver-created grants
- cheap rejection of unauthorized traffic
- signed message envelopes
- detached body retrieval by hash
- category-scoped subscriptions
- reply capabilities
- revocation behavior

## Non-Goals For v0

- Replacing all email use cases immediately.
- Solving provider-owned address portability.
- Building a Hail-specific global identity registry. Hail uses the external PLC registry and its verifiable operation log.
- Supporting unsolicited messages.
- End-to-end encryption.
- A complete rich block-document vocabulary.

## Identity Model

Hail uses DIDs as durable protocol identities and email-like addresses as human-readable aliases:

```text
alice@example.com
```

The address resolves to a DID. Grants, envelopes, and durable relationships bind to DIDs rather than addresses or provider endpoints.

Hail addresses are case-insensitive and serialize in lowercase canonical form. The strict public-federation profile permits an ASCII LDH-style local part of at most 63 bytes and an IDNA2008 A-label public DNS domain, subject to label, Public Suffix List, and 254-byte total limits. Bare public suffixes, special-use or unknown suffixes, root dots, quoted local parts, domain literals, and internationalized local parts are excluded. [`spec/address-binding.md`](spec/address-binding.md) is authoritative for the complete syntax and `acct:` URI mapping.

v0 distinguishes receiver onboarding requirements from sender verification requirements.

Receivers may use provider-issued Hail address aliases, especially if they only receive messages:

```text
alice@provider.example.com
```

All identities use `did:plc` as their durable identity. A provider-issued Hail address is an alias and may change when the user migrates, while the DID and grants remain stable.

A custom-domain address may provide a stronger user-visible organizational signal, but v0 permits either provider-issued or custom-domain sender addresses:

```text
updates@store.example.com
receipts@airline.example.com
```

For v0, portability of the human-readable Hail address itself is available to users and organizations that control their own domain:

```text
alice@alice.example.com
updates@store.example.com
```

Custom-domain identities also use `did:plc`. Their domain-backed Hail address can remain stable across hosting-provider migration if the domain continues publishing a valid binding to the same DID. Loss, transfer, removal, or expiration of that binding can make the address unverified without transferring or revoking DID-bound grants and history.

A provider may later offer managed personal-domain registration and DNS as a paid service. This is optional rather than a baseline requirement because every user would otherwise incur domain registration and renewal costs. For meaningful portability, the user should be the registrant or otherwise have a guaranteed right to transfer the managed domain away from the provider.

## Portable Identity

A DID is the durable identity anchor. The Hail address is a human-readable, replaceable alias, and the hosting endpoint is mutable infrastructure delegated through the DID.

The intended resolution chain is:

```text
human address -> DID -> current Hail service endpoint and verification keys
```

Address-to-DID resolution uses an expiring Hail Address Binding discovered through authenticated HTTPS WebFinger at the address domain. The WebFinger response selects one binding using the exact `https://hailproto.com/rel/address-binding` relation, and the selected binding separately verifies under the DID's `#hail-identity` key. Discovery follows the bounded redirect, SSRF, media-type, expiration, and one-hour maximum-cache rules in [`spec/address-binding.md`](spec/address-binding.md). Hail addresses are not written to `alsoKnownAs`, avoiding permanent address history in the public PLC log.

Continuity-preserving provider migration fences the old provider, transfers the complete grant, reply, replay, delivery, status, cache-provenance, and verification-evidence serialization domain, then updates both `#hail-messaging` and `#hail`. The new provider starts only after durable import and after the PLC update satisfies Hail's still-open recovery-window acceptance policy. The DID and DID-bound relationships remain stable.

For domain-backed sender addresses, authenticated WebFinger publication proves that the domain authorizes the address-to-DID association. Direct DNS proof is not part of v0. Hosting that DID's Hail service does not itself make a provider the identity owner.

Hail supports `did:plc` for individuals and organizations, whether their address is provider-issued or under a custom domain. The published PLC specification permits application-specific verification methods and services. Hail implementations access PLC through a configurable resolver boundary so caching, mirrors, audit verification, and alternative directory infrastructure do not affect protocol objects.

## Hail DID Profile

A Hail-capable DID exposes two distinct verification methods and one service entry:

```text
#hail-identity   Signs Hail Grants and Hail Address Bindings.
#hail-messaging  Signs Hail Envelopes (including replies), Sender Profiles,
                 and Hail Delivery Status snapshots.
#hail            Locates the current Hail server.
```

The identity and messaging roles use separate keys. This allows a provider to operate routine messaging without automatically receiving authority to create grants or address bindings for the user.

The `#hail` service has type `HailMessaging` and one HTTPS base endpoint. Standard server-to-server paths are derived from that base URL.

PLC operations store both Hail keys as named Ed25519 `did:key` values and store the Hail service as a named string endpoint. Resolvers expand relative IDs in PLC-rendered DID documents before validating the exact key roles, controllers, service type, and endpoint.

Provider migration updates `#hail-messaging` and `#hail` through a PLC operation while preserving the DID and `#hail-identity`. Operational continuity additionally requires the fenced state-transfer procedure described above. PLC rotation keys remain separate from both Hail keys.

The complete profile is defined in [`spec/did-profile.md`](spec/did-profile.md).

### PLC Operational Consequences

Using PLC for every identity establishes one recovery and resolution model, but also makes several constraints universal:

- Every account needs PLC rotation-key management using P-256 or secp256k1 in addition to Hail's Ed25519 signing keys.
- Hail consumes two of PLC's maximum ten verification-method slots; an existing PLC identity needs two free slots before it can enable Hail.
- Every identity and provider migration depends on PLC directory availability, so production servers need validated mirrors or local log replication.
- PLC updates are full state snapshots. Key rotation and provider migration tooling must preserve unrelated keys, aliases, and services rather than patching one field.
- PLC's 72-hour higher-authority recovery window can reverse a lower-authority update. Hail must define when new keys and endpoints become authoritative before production migration is safe.
- PLC rotation keys act unilaterally rather than by threshold. A user-held higher-priority key protects a provider-held update key only if unauthorized changes are detected and recovered within 72 hours, so monitoring is part of the recovery model.
- Verification keys, service endpoints, update timestamps, nullified operations, and tombstones are permanently public. Hail addresses stay in expiring Address Bindings and out of PLC state.
- Custom-domain control authenticates the human-readable address, while PLC rotation authority independently controls the durable identity. Losing or transferring the domain does not transfer DID-bound grants or message history.

## Account Onboarding

Creating a provider-local account, registering a DID, and publishing a Hail address are separate steps. Public Hail v0 DIDs submit their signed PLC operations to `https://plc.directory`; implementations may resolve the resulting canonical log through validated mirrors or local replicas. A local PLC directory is suitable for an isolated development network, but a DID registered only there is not a public-federation Hail identity because the DID itself contains no registry or network identifier.

Production providers must support portable custody. The user controls the top-priority PLC recovery key and `#hail-identity`; the provider controls a lower-priority PLC rotation key and `#hail-messaging`. User private keys are generated client-side, recoverable through an encrypted provider-independent backup, and unavailable in plaintext to the provider. A password alone is not sufficient protection for provider-accessible backup ciphertext.

An accepted operation from the provider's lower-priority PLC key becomes current immediately and can remove the user's keys; the user's higher-priority key can nullify it only during PLC's 72-hour recovery window. Each production account therefore configures a continuously operating PLC monitor outside the provider's administrative control that detects changes within 24 hours and alerts the user through an out-of-band channel.

For a new identity, the client validates and signs the exact full genesis `plc_operation`, both sides derive the DID, the provider submits it, and the client and provider verify the registered operation and resulting state. A user may instead bring an existing `did:plc`; onboarding publishes a user-authorized full-state update that preserves unrelated entries and adds the provider below every user recovery key. An existing active Hail identity uses the provider-migration flow rather than ordinary onboarding.

Address publication occurs only after the expected DID state resolves. The immutable signed Address Binding is staged first, WebFinger selects it second, and the provider activates the account only after complete address-to-DID and DID-to-service verification. Ambiguous PLC submissions reuse and look up the already-derived DID rather than generating another genesis operation. PLC registration is permanent and is never rolled back by automatically tombstoning a failed onboarding attempt.

An isolated POC may use disclosed provider custody and a local PLC directory, but it does not conform to the production portable custody profile. The complete lifecycle, failure states, retained evidence, and existing-DID procedure are defined in [`spec/account-onboarding.md`](spec/account-onboarding.md).

## Sender Discovery

QR codes, application search, curated directories, and recommendations are entry points rather than identity authorities. They yield a Hail address that the client treats as untrusted until verification.

The grant-discovery chain is:

```text
Hail address
  -> signed Address Binding
  -> did:plc identity
  -> PLC-discovered Hail service and #hail-messaging key
  -> signed Sender Profile with embedded categories
```

The profile is retrieved from `GET {hail-service-base}/profiles/{sender_did}`. It is DID-scoped so one signed profile works with multiple independently verified addresses for that DID. The client displays the separately verified address alongside the profile rather than allowing profile metadata to claim an address.

The v0 profile contains a display name, optional description, whether uncategorized subscription is offered, stable category IDs with labels and descriptions, revision, update time, and signer key. It excludes avatars, remote assets, subscriber data, and recipient-specific state. Profiles form a monotonic DID-scoped revision sequence; category IDs must not be repurposed, and profile changes do not alter existing grants. New consent requires a profile verified against sufficiently fresh current PLC state. The complete profile is signed by `#hail-messaging`, and its representation digest is retained in every grant's required consent context.

Search and QR encoding remain application-specific. A forged or stale search result cannot authorize a sender because the client independently verifies the Address Binding, PLC state, profile DID, and profile signature before consent.

## Consent-Time Sender Address Verification

For v0 consent, the visible sender address and profile are anchored jointly to the address domain's WebFinger publication, the DID-signed Address Binding, and the PLC-authorized profile key.

A sender claiming `updates@store.example.com` must have that address domain publish its Address Binding, and the binding and Sender Profile must verify under the same PLC identity.

This does not fully solve lookalike domains such as `example-store-security.com`, but it gives users and clients a concrete verified domain to inspect during the grant flow.

After grant creation, routine delivery authorization uses the grant and envelope DIDs. Delivery authenticates `from` through its current `#hail-messaging` key and does not transfer or re-evaluate a grant based on current address resolution.

Possible later mitigations:

- domain age display
- organization verification
- transparency logs
- trust registries
- verified brand relationships
- warning UX for newly registered or deceptive domains

## Hail Grants

A Hail Grant is a recipient-created, recipient-signed authorization from one DID to another. The recipient server is authoritative, and the sender cannot create or expand consent on the recipient's behalf.

v0 permits at most one active grant for a grantor/grantee DID pair and supports exactly one categorized or uncategorized scope selector. Every revision carries consent context committing to the verified Address Binding and Sender Profile shown during consent. A revision that adds or replaces an authorized category, or switches scope mode, requires fresh evidence and explicit opt-in; merely adding a category to a Sender Profile grants nothing. Restrictions and revocation preserve prior evidence and never depend on sender availability. Unknown scope types fail closed. Revocation is terminal for that grant ID, while expiration is nonterminal and may be renewed by a higher valid revision. A `grant_id` is only a lookup hint, never a bearer capability.

The complete grant schema, scope semantics, lookup rules, revision lifecycle, and HTTP publication behavior are defined in [`spec/grants.md`](spec/grants.md).

## Message Types

Message types allow clients to render and organize messages more intelligently than email.

When present, `message_type` must use one of these exact closed v0 values:

- personal
- newsletter
- promotion
- receipt
- invoice
- ticket
- boarding-pass
- account-alert
- security-alert
- package-update
- calendar-event

Message type and category are related but not identical.

Category is sender-defined consent scope. Message type is protocol-defined presentation metadata; it grants no authority and is not a grant selector.

## Detached Hail Body Delivery

Hail Messages should use a small signed Hail Envelope with a detached Hail Body.

The complete immutable body must exist before envelope submission. The envelope is delivered first, and the recipient server retrieves or reuses the body only after authorizing the envelope.

Benefits:

- unauthorized traffic can be rejected before parsing large bodies
- signatures can be checked over compact metadata
- one body can be reused for many recipients
- recipient servers can deduplicate underlying storage by content hash without exposing cross-recipient cache membership
- future asset profiles can preserve independent authorization, caching, and verification
- remote tracking pixels become avoidable by design

V0 uses one content-addressed body for any number of byte-identical messages, plus a separate recipient-specific retrieval token in each signed envelope. Each envelope commits to availability for at least 30 days after its signed `created_at`; a shared body and each recipient-specific authorization remain available through the latest applicable signed `available_until`. Exact hashing, token, retrieval, caching, compression, integrity, and retention rules are defined in [`spec/bodies.md`](spec/bodies.md).

## Hail Envelope

The envelope is compact and carries only data needed for routing, authorization, presentation, threading, and body retrieval.

v0 uses one recipient per envelope, UUIDv7 message IDs scoped by sender DID, grant or reply authorization, required timestamps, and explicit reply behavior. The envelope signature covers a closed detached-body descriptor containing the digest, uncompressed size, media type, profile, availability commitment, and recipient-specific bearer authorization. The payload uses deterministic Hail CBOR in tagged COSE_Sign1 signed with the sender's `#hail-messaging` key and the RFC 9864 fully specified COSE `Ed25519` algorithm. POC limits include a 16,384-byte signed representation, a 256 KiB uncompressed body, 300 seconds of timestamp tolerance, and an envelope expiration no more than seven days after creation.

The complete schema, signature profile, validation order, and replay behavior are defined in [`spec/envelopes.md`](spec/envelopes.md). Detached body behavior is defined in [`spec/bodies.md`](spec/bodies.md).

## Delivery State

`accepted` means the recipient server authenticated and authorized the envelope, fixed its authorization, and durably assumed responsibility for body processing. A later grant change prevents future acceptance but does not cancel an already accepted envelope.

`delivered` means the recipient server verified the body and durably stored the accepted envelope, recipient-specific message record, and either the body bytes or a durable reference to their verified content-addressed copy. It does not mean that a client synchronized, displayed, opened, or read the message.

Retry scheduling belongs to the recipient server until the earliest of `expires_at + 300 seconds`, `body.available_until`, and `body.access.expires_at`, using bounded backoff and jitter. Sender-visible state uses `accepted`, `on-hold`, `delivered`, `failed`, and `cancelled`, with state-specific reason codes. The current signed state may be returned synchronously to an eligible authenticated sender. v0 asynchronously pushes every terminal `delivered`, `failed`, or `cancelled` snapshot, but does not push `accepted` or `on-hold` snapshots.

For a logical message sent to many recipients, each recipient envelope has its own message ID and delivery state. Campaign grouping and aggregate counts remain local to the sender; byte-identical recipients may still share one body digest.

The complete state machine and status object are defined in [`spec/delivery-state.md`](spec/delivery-state.md).

## Replies

Replies are authorized by prior messages, not by standing grants in the reverse direction.

When an envelope permits replies, the original sender retains an authenticated sent-message record proving the signed reply permission. The message ID reference is a lookup hint, not a transferable bearer capability.

When the recipient sends a reply, `authorization.reply_to` points at the original message. The original sender's server accepts one next message only if it previously sent that message with replies allowed and the reply is still within `reply.until`. The capability is atomically claimed during acceptance and consumed by completed delivery. Terminal failure or cancellation releases the claim for one replacement before the deadline; an idempotent retry retains the same claim.

Suggested product default:

```text
120 days
```

The protocol has no implicit default. `reply.allowed: true` requires an explicit signed `reply.until`; products may suggest a 120-day value and senders may choose a different deadline.

The POC applies the common 256 KiB maximum uncompressed body size to replies and defines no reply-specific minimum. Sender Profiles do not advertise sender-specific reply-size or attachment limits; assets and attachments are unsupported by the POC body profile.

v0 deliberately permits one next message per capability. Multiple conversational turns form a linear chain in which each delivered reply may grant one further reply. Either side can end the thread with `reply.allowed: false`; sibling replies require a future authorization design.

## Revocation

Revocation is local and unilateral.

The recipient server enforces a signed revoked grant revision immediately and notifies the sender asynchronously. The sender does not approve revocation, and notification failure cannot delay it.

Current address-to-DID discovery and DID routing are public. To prevent probing of grants, replies, replay records, message state, local-account state, recipient policy, cache state, and user activity, protected failures use the generic `202`/`received` response until the sender signature is verified and local state confirms a current or previous grant or reply relationship. Only then may privacy policy permit detailed outcomes such as revoked grant or ungranted category.

Grant revocation is defined in [`spec/grants.md`](spec/grants.md). Revocation wins if it commits before envelope acceptance; acceptance wins if it commits first. Delivery state is defined in [`spec/delivery-state.md`](spec/delivery-state.md).

## Hail Body Format Strategy

V0 does not depend on arbitrary HTML as the rich message format.

The POC uses the fixed `spt-1` schema: a closed deterministic-CBOR body containing Portable Text-shaped plain-text blocks and spans. This makes unsafe behavior inexpressible instead of relying on sanitization after parsing untrusted markup.

The following diagnostic JSON illustrates possible future body models and is not part of v0:

```json
{
  "version": 1,
  "blocks": [
    { "type": "hero", "asset": "sha256:...", "alt": "Weekend sale banner" },
    { "type": "heading", "level": 1, "text": "Weekend Sale" },
    { "type": "paragraph", "text": "Save up to 40% on summer gear." },
    { "type": "button", "label": "Shop Sale", "url": "https://example-store.com/sale" }
  ]
}
```

The exact POC logical structure is shown below as diagnostic JSON rather than wire data:

```json
{
  "version": 1,
  "profile": "spt-1",
  "blocks": [
    {
      "_type": "block",
      "style": "normal",
      "children": [
        { "_type": "span", "text": "Hello from the prototype.", "marks": [] }
      ],
      "markDefs": []
    }
  ]
}
```

This allows Hail to evolve into a richer block vocabulary without changing the transport model.

Useful prior art to research:

- Portable Text
- Slack Block Kit
- Atlassian Document Format
- ProseMirror schemas
- Editor.js
- Lexical
- MJML
- AMP for Email

## Future Rich Content And Assets

None of the asset manifest, loading mode, or `spt-asset:` concepts below is part of v0. The POC supports no assets or attachments and prohibits remote resources. A future asset profile would need to define manifest syntax, authorization, integrity, loading policy, resource limits, and privacy behavior.

Future messages may package structured metadata plus a detached body and declared assets.

Every external or bundled resource in such a future profile would need a manifest entry with:

- asset id
- content type
- byte size
- hash
- dimensions, where relevant
- role, such as `preview`, `logo`, or `attachment`
- loading mode

Possible future asset loading modes:

- bundled
- deferred
- remote, only if declared and controlled by client/server policy

Remote assets would remain optional from the user's perspective. Clients and recipient servers could block, proxy, prefetch, or cache them according to user policy.

Future body content should not reference arbitrary external resources. It should reference declared assets instead.

Example:

```text
spt-asset:hero
```

## Encoding And Compression

The logical message model is deliberately JSON-shaped, but the sole authoritative v0 federation representation for Hail-owned objects and bodies is deterministic CBOR. Application developers may use diagnostic JSON, generated models, or provider-local JSON APIs without implementing the wire codec.

POC detached-body transfer uses `application/hail-body+cbor` and permits either an unencoded response or optional gzip transport compression:

```text
Content-Type: application/hail-body+cbor
Content-Encoding: gzip  # optional
```

The signed body digest and size cover exact uncompressed deterministic body bytes, regardless of transport coding. Signed objects use tagged COSE_Sign1 and are not HTTP-compressed. Their outer media type is `application/cose; cose-type="cose-sign1"`; the protected COSE content type identifies the exact embedded Hail object. WebFinger, rendered DID documents, Problem Details, and generic receipts retain their externally defined JSON representations. Zstd remains a separate future body-transfer decision.

The shared codecs, schemas, typed models, diagnostic converters, and conformance vectors keep CBOR and COSE mechanics out of ordinary application code. Hail follows the constrained-data-model precedent of DRISL and AT Protocol where useful but does not require AT Protocol interoperability, CIDs, CAR files, or repository structures.

## Signatures

v0 defines exactly five signed object profiles:

| Object | Protected content type | Required key role |
| --- | --- | --- |
| Hail Address Binding | `application/hail-address-binding+cbor` | `#hail-identity` |
| Hail Sender Profile | `application/hail-sender-profile+cbor` | `#hail-messaging` |
| Hail Grant | `application/hail-grant+cbor` | `#hail-identity` |
| Hail Envelope, including replies | `application/hail-envelope+cbor` | `#hail-messaging` |
| Hail Delivery Status | `application/hail-delivery-status+cbor` | `#hail-messaging` |

Any additional signed object type requires an explicit future schema, protected content type, and key-role definition.

The Hail Envelope v0 profile uses:

- deterministic Hail CBOR
- tagged COSE_Sign1 with embedded payload
- the RFC 9864 fully specified COSE `Ed25519` algorithm value `-19`
- the sender DID's `#hail-messaging` key

The common profile is defined in [`spec/encoding.md`](spec/encoding.md), and envelope-specific rules are defined in [`spec/envelopes.md`](spec/envelopes.md). Every signed object has an exact protected content type and key role so types remain domain-separated.

Deterministic encoding produces exactly one accepted byte representation before signing or hashing. Receivers reject alternate valid-CBOR spellings to prevent ambiguous signatures, digests, and replay identities.

Digest domains remain distinct:

| Purpose | SHA-256 input |
| --- | --- |
| Address Binding, Sender Profile, and Grant revision digest | Complete tagged signed COSE representation bytes |
| Envelope replay and Delivery Status correlation | Deterministic envelope payload bytes, excluding COSE |
| Body content identity | Exact uncompressed deterministic body bytes |

## Server-To-Server Delivery

The `#hail` DID service publishes an arbitrary validated HTTPS base path. v0 appends these fixed relative operations:

```text
GET  {base}/profiles/{sender_did}
PUT  {base}/grants/{grant_id}
POST {base}/envelopes
GET  {base}/bodies/{digest}
PUT  {base}/deliveries/{envelope_digest}
```

Replies reuse `POST {base}/envelopes` as normal messages with reply-based authorization. v0 defines no `QueryDeliveryStatus` method or path. Federation clients do not follow redirects; selected network, redirect, endpoint, or refreshable key failures trigger one PLC refresh and retry only at a changed authenticated endpoint.

| Operation | Key transport behavior |
| --- | --- |
| Retrieve Sender Profile | Public `GET`; `200` or `304`, strong ETag, and at most one hour of cache freshness |
| Publish Grant Revision | Conditional `PUT` using `If-None-Match` or `If-Match`; successful create/update uses `201` or `204` |
| Submit Envelope | Signed COSE `POST`; protected outcomes use generic `202`, while eligible authenticated success may return `200` with signed status |
| Retrieve Body | Bearer-authorized `GET`; uniform `404` for protected absence/authorization failures, with retryable `429` and `503` |
| Push Delivery Status | At-least-once terminal-status `PUT`; only `204` acknowledges receipt, while generic `202` is not an acknowledgement |

Detailed errors use RFC 9457 `application/problem+json` only when disclosure policy permits. Signed COSE objects use no HTTP content coding.

High-level delivery flow:

1. The sender resolves the recipient's address binding to a DID when necessary, then resolves that DID's current Hail service.
2. The recipient applies transport-size, bounded CBOR/COSE, closed-schema, and inexpensive field checks to the submitted envelope.
3. Claimed fields may support only a preliminary local grant or reply lookup whose result is not externally distinguishable and reveals no relationship state.
4. The recipient resolves current DID keys, verifies COSE, and binds the authenticated sender and recipient.
5. It atomically checks `(from, message_id)` and either returns the stored result or reserves a pending authenticated replay record before final policy and authorization checks.
6. It applies policy, then atomically rechecks grant category scope or reply authority, claims any reply capability, and creates `accepted`; otherwise it stores the authenticated rejection.
7. After acceptance, the recipient retrieves the body with the signed bearer authorization, or reuses a verified cache entry with matching recipient-and-sender provenance.
8. The recipient verifies body bytes and commits exactly one terminal delivery outcome.

Protected outcomes remain a generic `202`/`received` unless the sender is authenticated, has current or previous local relationship state, privacy policy permits detail, and processing completes within the bounded response schedule. Eligible success returns `200` with signed Delivery Status; eligible explicit failures use Problem Details. Envelope transport ambiguity, generic receipt, `429`, and `503` permit byte-identical retries with the same message ID. After acceptance, body retries belong to the recipient. Terminal-status pushes use the fixed jittered schedule and continue until acknowledged or permanently rejected as defined in [`spec/http-binding.md`](spec/http-binding.md).

## Unsolicited Messages

V0 should not support unsolicited messages.

Unknown senders may eventually be allowed to send constrained contact or subscription requests, but those requests should be small, plain, rate-limited, and free of rich content or arbitrary links.

## Privacy And Analytics

HTTP receipt, Hail envelope acceptance, and completed delivery are separate. The generic `202` response proves only receipt. An eligible authenticated exchange may instead return a signed current status or detailed Problem Details without changing that distinction. Acceptance and delivery status do not imply that a person opened or read the message.

Read/open receipts are not part of v0. Any future read-receipt protocol would require separate explicit recipient consent and must prevent covert mechanisms such as tracking pixels.

Possible analytics model:

- delivery status is protocol-level
- future read/open receipts require explicit opt-in
- aggregate campaign stats may be computed by the sender from per-recipient delivery statuses
- per-user surveillance should not be built into the protocol

The pitch to legitimate senders is better deliverability and more honest engagement data in exchange for reduced covert tracking.

## Prototype Architecture

The first prototype should validate the wire protocol between two toy servers.

Current implementation status: independent TypeScript and Go reference codecs implement strict deterministic CBOR, tagged COSE_Sign1, typed payload validation, shared conformance vectors, executable schema checks, diagnostic tooling, and benchmarks. DID/WebFinger/PLC discovery, federation HTTP operations, durable grant/replay/reply/delivery state, body service behavior, and a working server or client remain unimplemented. The next milestone is the two-server end-to-end slice.

Suggested build phases:

1. Shared protocol codecs for encode/decode, signing, verification, schema validation, and conformance. **Implemented for the current draft in TypeScript and Go; pre-release and subject to schema, vector, limit, and conformance stabilization.**
2. Sender server with a signed Sender Profile, grant receipt, body storage, and send pipeline.
3. Receiver server with grant table, envelope endpoint, ingest checks, body retrieval, and message store.
4. Test harness for subscribe, send, revoke, reply, expired reply, and unauthorized traffic rejection.
5. Minimal receiver client for grant approval and message reading.

The most important prototype metric is cost-to-reject unauthorized traffic.

If the receiver can drop unauthorized envelopes cheaply before signature verification and body transfer, Hail has a compelling infrastructure story compared with email spam filtering.

## Open Questions

- When does Hail treat a PLC update as authoritative during the 72-hour recovery window?
- What PLC mirror, checkpoint, and locally validated log behavior is required for production resolution?
- What production uncompressed body size must every conforming server accept, and what recipient-configurable ceiling is permitted?
- What is the first useful post-POC block vocabulary after plain text?
- How should organization verification work beyond domain control?
- How should bridge-to-email work without weakening the anti-spam model?

## Topics To Discuss Next

- Production body-size interoperability floors and ceilings.
- Post-POC block document vocabulary.
- Server abuse protections and rate limits.
- Email bridge strategy.
- Business model and ecosystem incentives.
