# Hail Protocol Concept Design Notes

Hail Protocol is a federated, permission-based messaging concept intended to solve the downfalls of email by changing the default delivery model and strengthening sender identity, message authorization, deliverability, and client-side safety.

## Goals

- Prevent spam by default rather than filtering it after receipt.
- Support rich messages.
- Allow federation between independently operated servers.
- Support user choice of providers and clients.
- Support portable identities for users and organizations with provider-issued or custom-domain addresses.
- Use open standards where practical.
- Keep v1 implementable by hobbyists and independent developers.
- Allow existing email clients and tools to eventually adopt delivery and receipt of these messages, enabling side-by-side existence with email.
- Make sender authenticity visible at the consent moment, not hidden in technical headers.

## V1 Scope

V1 should focus primarily on B2C communication such as:

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

## Non-Goals For V1

- Replacing all email use cases immediately.
- Solving provider-owned address portability.
- Building a Hail-specific global identity registry. Hail uses the external PLC registry and its verifiable operation log.
- Supporting arbitrary browser-grade HTML.
- Supporting unsolicited rich messages.
- Solving lookalike-domain phishing completely.
- End-to-end encryption.
- A complete rich block-document vocabulary.

## Identity Model

Hail uses DIDs as durable protocol identities and email-like addresses as human-readable aliases:

```text
alice@example.com
```

The address resolves to a DID. Grants, envelopes, and durable relationships bind to DIDs rather than addresses or provider endpoints.

Hail addresses are case-insensitive and serialize in lowercase canonical form. V1 permits ASCII dot-atom local parts and IDNA2008 domains serialized as A-labels; quoted local parts, domain literals, and internationalized local parts are excluded.

V1 should distinguish receiver onboarding requirements from sender verification requirements.

Receivers may use provider-issued identities, especially if they only receive messages:

```text
alice@provider.example.com
```

All identities use `did:plc` as their durable identity. A provider-issued Hail address is an alias and may change when the user migrates, while the DID and grants remain stable.

Senders should generally be domain-backed:

```text
updates@store.example.com
receipts@airline.example.com
```

For v1, portability of the human-readable Hail address itself is available to users and organizations that control their own domain:

```text
alice@alice.example.com
updates@store.example.com
```

Custom-domain identities also use `did:plc`. Their domain-backed Hail address remains stable while the domain owner changes Hail hosting providers, and their DID remains independent of domain registration, DNS, and web hosting.

The v1 identity policy is:

```text
All identities: did:plc
```

A provider may later offer managed personal-domain registration and DNS as a paid service. This is optional rather than a baseline requirement because every user would otherwise incur domain registration and renewal costs. For meaningful portability, the user should be the registrant or otherwise have a guaranteed right to transfer the managed domain away from the provider.

## Portable Identity

A DID is the durable identity anchor. The Hail address is a human-readable, replaceable alias, and the hosting endpoint is mutable infrastructure delegated through the DID.

The intended resolution chain is:

```text
human address -> DID -> current Hail service endpoint and verification keys
```

Address-to-DID resolution uses an expiring Hail Address Binding discovered through the address domain. The address domain publishes the mapping, and a key authorized by the DID signs the same address and DID values. Hail addresses are not written to `alsoKnownAs`, avoiding permanent address history in the public PLC log.

If Alice changes providers, she updates the service endpoint associated with her DID. Her DID, grants, and message relationships remain stable.

For domain-backed sender addresses, DNS or a well-known document proves that the domain authorizes the address-to-DID association. Hosting that DID's Hail service does not itself make a provider the identity owner.

V1 supports `did:plc` for individuals and organizations, whether their address is provider-issued or under a custom domain. The published PLC specification permits application-specific verification methods and services. Hail implementations access PLC through a configurable resolver boundary so caching, mirrors, audit verification, and alternative directory infrastructure do not affect protocol objects.

## Hail DID Profile

A Hail-capable DID exposes two distinct verification methods and one service entry:

```text
#hail-identity   Signs grants and address bindings.
#hail-messaging  Signs envelopes, replies, receipts, and operational metadata.
#hail            Locates the current Hail server.
```

The identity and messaging roles use separate keys. This allows a provider to operate routine messaging without automatically receiving authority to create grants or address bindings for the user.

The `#hail` service has type `HailMessaging` and one HTTPS base endpoint. Standard server-to-server paths are derived from that base URL.

PLC operations store both Hail keys as named Ed25519 `did:key` values and store the Hail service as a named string endpoint. Resolvers expand relative IDs in PLC-rendered DID documents before validating the exact key roles, controllers, service type, and endpoint.

Provider migration updates `#hail-messaging` and `#hail` through a PLC operation while preserving the DID, `#hail-identity`, grants, and message relationships. PLC rotation keys remain separate from both Hail keys.

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

## Discovery

Sender and recipient discovery should support both domain-local metadata and DNS indirection.

Default discovery:

```text
https://example.com/.well-known/hail
```

DNS indirection:

```text
_hail.example.com TXT "v=hail1 profile=https://hail-host.example/profiles/example.com"
```

DNS indirection allows a verified domain to host its Hail profile and server infrastructure somewhere else.

Key rules:

- The verified identity remains the domain that published the DNS or well-known record.
- The hosted profile URL is infrastructure, not identity.
- Clients should display the verified domain during subscription and grant approval.
- Profiles should be signed so hosted infrastructure cannot silently mutate sender metadata without authorization.

Profile metadata may include:

- sender DID; authoritative keys and the Hail service base endpoint come from DID resolution
- display name
- avatar
- description
- category manifest
- reply size limits
- supported encodings

## Sender Verification

For v1, sender authenticity is anchored to domain control.

A sender claiming to represent `example-store.com` must prove control of `example-store.com` through DNS or a well-known HTTPS document.

This does not fully solve lookalike domains such as `example-store-security.com`, but it gives users and clients a concrete verified domain to inspect during the grant flow.

Possible later mitigations:

- domain age display
- organization verification
- transparency logs
- trust registries
- verified brand relationships
- warning UX for newly registered or deceptive domains

## Hail Grants

A Hail Grant is a recipient-created, recipient-signed authorization from one DID to another. The recipient server is authoritative, and the sender cannot create or expand consent on the recipient's behalf.

V1 supports categorized and uncategorized grants. New categories always require explicit opt-in, and unknown scope types fail closed. Grant state uses signed revisions, local immediate enforcement, asynchronous sender notification, and terminal revocation.

The complete grant schema, scope semantics, lookup rules, revision lifecycle, and HTTP publication behavior are defined in [`spec/grants.md`](spec/grants.md).

## Message Types

Message types allow clients to render and organize messages more intelligently than email.

Initial candidate types:

- personal
- newsletter
- promotion
- receipt
- invoice
- ticket
- boarding pass
- account alert
- security alert
- package update
- calendar event

Message type and category are related but not identical.

Category is sender-defined consent scope. Message type is protocol-defined rendering and behavior metadata.

## Detached Hail Body Delivery

Hail Messages should use a small signed Hail Envelope with a detached Hail Body.

The complete immutable body exists before envelope submission. The envelope is delivered first, and the recipient server retrieves or reuses the body only after authorizing the envelope.

Benefits:

- unauthorized traffic can be rejected before parsing large bodies
- signatures can be checked over compact metadata
- one body can be reused for many recipients
- recipient servers can deduplicate underlying storage by content hash without exposing cross-recipient cache membership
- assets can be bundled, cached, and verified separately
- remote tracking pixels become avoidable by design

The POC uses one content-addressed body for any number of byte-identical messages, plus a separate recipient-specific retrieval token in each signed envelope. Senders commit to at least 30 days of availability. Exact hashing, token, retrieval, caching, compression, integrity, and retention rules are defined in [`spec/bodies.md`](spec/bodies.md).

## Hail Envelope

The envelope is compact and carries only data needed for routing, authorization, presentation, threading, and body retrieval.

V1 uses one recipient per envelope, UUIDv7 message IDs scoped by sender DID, grant or reply authorization, required timestamps, a signed detached body descriptor, and explicit reply behavior. The payload uses RFC 8785 canonical JSON in an RFC 7515 flattened JWS signed with the sender's `#hail-messaging` key and the RFC 9864 `Ed25519` algorithm identifier.

The complete schema, signature profile, validation order, and replay behavior are defined in [`spec/envelopes.md`](spec/envelopes.md). Detached body behavior is defined in [`spec/bodies.md`](spec/bodies.md).

## Delivery State

`accepted` means the recipient server authenticated and authorized the envelope, fixed its authorization, and durably assumed responsibility for body processing. A later grant change prevents future acceptance but does not cancel an already accepted envelope.

`delivered` means the recipient server obtained or reused the body, verified it, and durably stored both the message record and verified body reference. It does not mean that a client synchronized, displayed, opened, or read the message.

Retry scheduling belongs to the recipient server within the signed delivery deadline. Sender-visible state uses `accepted`, `on-hold`, `delivered`, `failed`, and `cancelled`, with separate reason codes. The recipient sends signed per-envelope status snapshots back to the sender's DID-discovered Hail service.

For a logical message sent to many recipients, each recipient envelope has its own message ID and delivery state. Campaign grouping and aggregate counts remain local to the sender; byte-identical recipients may still share one body digest.

The complete state machine and status object are defined in [`spec/delivery-state.md`](spec/delivery-state.md).

## Replies

Replies are authorized by prior messages, not by standing grants in the reverse direction.

When a recipient receives a message with `reply.allowed: true`, the recipient server records the signed, single-use reply capability.

When the recipient sends a reply, `authorization.reply_to` points at the original message. The original sender's server accepts one next message only if it previously sent that message with replies allowed and the reply is still within `reply.until`. The capability is atomically claimed during acceptance and consumed by completed delivery.

Default reply window:

```text
120 days
```

Senders may set a longer or shorter `reply.until` timestamp when needed, such as for travel bookings made months in advance.

Sender profiles may declare reply limits, such as maximum body size and whether attachments are accepted. The protocol should define a minimum guaranteed reply capacity so ordinary text replies always work.

Open starting point:

```text
minimum reply body size: 64 KiB
```

Threads are linear chains of mutually solicited messages. Either side can end the thread by sending a message with `reply.allowed: false`.

## Revocation

Revocation is local and unilateral.

The recipient server enforces a signed revoked grant revision immediately and notifies the sender asynchronously. The sender does not approve revocation, and notification failure cannot delay it.

To reduce address probing, detailed rejection reasons should only be returned when the sender previously had a valid grant relationship. Unknown never-granted senders should receive a generic rejection.

Grant revocation is defined in [`spec/grants.md`](spec/grants.md). Revocation wins if it commits before envelope acceptance; acceptance wins if it commits first. Delivery state is defined in [`spec/delivery-state.md`](spec/delivery-state.md).

## Hail Body Format Strategy

V1 should not depend on arbitrary HTML as the long-term rich message format.

The preferred direction is a structured block document model: a schema-validated tree of typed blocks and inline nodes. This makes unsafe behavior inexpressible instead of relying on sanitization after parsing untrusted markup.

Long-term body model examples:

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

For the proof of concept, plain text is sufficient, but it should still be wrapped in a versioned body structure:

```json
{
  "version": 1,
  "blocks": [
    { "type": "text", "text": "Hello from the prototype." }
  ]
}
```

This allows the POC to evolve into a richer block vocabulary without changing the transport model.

Useful prior art to research:

- Portable Text
- Slack Block Kit
- Atlassian Document Format
- ProseMirror schemas
- Editor.js
- Lexical
- MJML
- AMP for Email

## Rich Content And Assets

Messages should be packaged as structured metadata plus a detached body and declared assets.

Every external or bundled resource should be declared in a manifest with:

- asset id
- content type
- byte size
- hash
- dimensions, where relevant
- role, such as `preview`, `logo`, or `attachment`
- loading mode

Allowed asset loading modes:

- bundled
- deferred
- remote, only if declared and controlled by client/server policy

Remote assets must be optional from the user's perspective. Clients and recipient servers may block, proxy, prefetch, or cache remote assets according to user policy.

Body content should not reference arbitrary external resources. Instead, body content should reference declared assets.

Example:

```text
spt-asset:hero
```

## Encoding And Compression

The logical message model should be JSON-compatible.

Likely v1 baseline:

```text
Content-Type: application/hail+json
Content-Encoding: gzip
```

Possible optional advanced support:

```text
Content-Type: application/hail+cbor
Content-Encoding: zstd
```

JSON keeps the barrier to entry low for hobbyists and independent developers. CBOR, COSE, and zstd are attractive for efficiency and standards alignment, but they add implementation and debugging complexity.

The long-term efficient profile may use:

- CBOR or DAG-CBOR for compact deterministic encoding
- CDDL for schemas
- COSE for signatures
- zstd for compression

## Signatures

Hail Envelopes and routine server objects must be signed with the sender DID's authorized `#hail-messaging` key. Hail Grants and Hail Address Bindings must be signed with the relevant DID's `#hail-identity` key.

The Hail Envelope v1 profile uses:

- canonical JSON using RFC 8785 JSON Canonicalization Scheme
- RFC 7515 flattened JWS JSON Serialization
- the RFC 9864 `Ed25519` algorithm identifier
- the sender DID's `#hail-messaging` key

This exact profile is defined in [`spec/envelopes.md`](spec/envelopes.md). Other signed Hail object types require object-specific profiles so their types and key roles remain domain-separated.

Possible later approach:

- CBOR
- COSE signatures

Canonicalization means converting data into exactly one byte representation before signing. Without this, semantically identical JSON can have different byte encodings and break signatures.

## Server-To-Server Delivery

Minimal conceptual Hail service endpoints:

```text
PUT  /hail/grants/{grant_id}
POST /hail/envelopes
GET  /hail/bodies/{digest}
PUT  /hail/deliveries/{envelope_digest}
```

`SubmitEnvelope` uses `POST {hail-service-base}/envelopes`. Replies reuse it as normal messages with reply-based authorization.

High-level delivery flow:

1. Sender resolves the recipient's address binding to a DID when necessary, then resolves that DID's current Hail service.
2. Sender sends a signed envelope to the recipient server.
3. Recipient server checks for an active delivery grant or valid single-use reply authorization.
4. Recipient server checks category, expiration, rate limits, and content constraints.
5. Recipient server verifies sender identity and message signature.
6. Recipient server accepts or rejects the envelope.
7. Recipient server fetches or receives the detached body by hash.
8. Recipient server verifies and stores the message.

The generic HTTP response reports only receipt and does not reveal Hail acceptance. Privacy-preserving submission outcomes, timing, retries, and idempotency are defined in [`spec/http-binding.md`](spec/http-binding.md).

## Unsolicited Messages

V1 should not support unsolicited rich messages.

Unknown senders may eventually be allowed to send constrained contact or subscription requests, but those requests should be small, plain, rate-limited, and free of rich content or arbitrary links.

## Privacy And Analytics

HTTP receipt, Hail envelope acceptance, and completed delivery are separate. A generic transport response proves only receipt. Authenticated acceptance and delivery are reported by signed server status snapshots; they do not imply that a person opened or read the message.

Read receipts should be receiver-controlled and explicit. They should not be possible through covert mechanisms like tracking pixels.

Possible analytics model:

- delivery status is protocol-level
- read/open receipts are opt-in
- aggregate campaign stats may be computed by the sender from per-recipient delivery statuses
- per-user surveillance should not be built into the protocol

The pitch to legitimate senders is better deliverability and more honest engagement data in exchange for reduced covert tracking.

## Prototype Architecture

The first prototype should validate the wire protocol between two toy servers.

Suggested build phases:

1. Shared protocol library for envelope encode/decode, signing, verification, and schema validation.
2. Sender server with profile metadata, category manifest, grant receipt, body storage, and send pipeline.
3. Receiver server with grant table, envelope endpoint, ingest checks, body retrieval, and message store.
4. Test harness for subscribe, send, revoke, reply, expired reply, and unauthorized traffic rejection.
5. Minimal receiver client for grant approval and message reading.

The most important prototype metric is cost-to-reject unauthorized traffic.

If the receiver can drop unauthorized envelopes cheaply before signature verification and body transfer, Hail has a compelling infrastructure story compared with email spam filtering.

## Open Questions

- When does Hail treat a PLC update as authoritative during the 72-hour recovery window?
- What PLC mirror, checkpoint, and locally validated log behavior is required for production resolution?
- What minimum PLC rotation-key custody and backup arrangement is required at onboarding?
- What non-DID profile fields are required for sender discovery?
- What should the guaranteed minimum reply size be?
- What is the first useful block vocabulary after plain text?
- How should organization verification work beyond domain control?
- How should bridge-to-email work without weakening the anti-spam model?

## Topics To Discuss Next

- Discovery and domain ownership verification.
- Reply path wire behavior.
- Sender category manifest format.
- Block document v1 vocabulary.
- Server abuse protections and rate limits.
- Email bridge strategy.
- Business model and ecosystem incentives.
