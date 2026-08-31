# Hail Protocol Concept Design Notes

Hail Protocol is a federated, permission-based messaging concept intended to solve the downfalls of email by changing the default delivery model and strengthening sender identity, message authorization, and client-side safety.

Instead of allowing anyone who knows an address to attempt delivery, Hail requires recipient-controlled permission before messages can appear in a user's inbox.

## Core Principle

Only explicitly authorized senders can deliver messages to a recipient.

The central primitive is a recipient-issued, revocable, scoped delivery grant.

## Goals

- Prevent spam by default rather than filtering it after receipt.
- Support rich messages for newsletters, receipts, bookings, promotions, alerts, and personal messages.
- Allow federation between independently operated servers.
- Support user choice of providers and clients.
- Support portable identities for users and organizations that control their own domains.
- Use open standards where practical.
- Keep v1 implementable by hobbyists and independent developers.
- Allow existing email clients and tools to eventually adopt delivery and receipt of these messages, enabling side-by-side existence with email.
- Make sender authenticity visible at the consent moment, not hidden in technical headers.

## V1 Scope

V1 should focus primarily on B2C communication:

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
- Building a global central identity registry.
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

Hail addresses are case-insensitive and must be normalized before resolution or comparison.

V1 should distinguish receiver onboarding requirements from sender verification requirements.

Receivers may use provider-issued identities, especially if they only receive messages:

```text
alice@provider.example
```

Provider-issued identities use `did:plc` as their durable identity in the provisional v1 design. The provider-issued Hail address is an alias and may change when the user migrates, while the DID and grants remain stable.

Senders should generally be domain-backed:

```text
updates@example-store.com
receipts@airline.example
```

For v1, portability of the human-readable Hail address itself is available to users and organizations that control their own domain:

```text
alice@alice-me.com
updates@example-store.com
```

Bring-your-own-domain identities use `did:web`. Their Hail address and DID remain stable while the domain owner changes Hail hosting providers.

The provisional v1 identity policy is:

```text
Bring your own domain: did:web
Provider-issued identity: did:plc
```

A provider may later offer managed personal-domain registration and DNS as a paid service. This is optional rather than a baseline requirement because every user would otherwise incur domain registration and renewal costs. For meaningful portability, the user should be the registrant or otherwise have a guaranteed right to transfer the managed domain away from the provider.

## Portable Identity

A DID is the durable identity anchor. The Hail address is a human-readable, replaceable alias, and the hosting endpoint is mutable infrastructure delegated through the DID.

The intended resolution chain is:

```text
human address -> DID -> current Hail service endpoint and verification keys
```

Address-to-DID resolution uses an expiring Hail Address Binding discovered through the address domain. The address domain publishes the mapping, and a key authorized by the DID signs the same address and DID values. Hail does not require `alsoKnownAs` for this proof, avoiding permanent provider-address history in the public PLC log.

If Alice changes providers, she updates the service endpoint associated with her DID. Her DID, grants, and message relationships remain stable.

For domain-backed sender addresses, DNS or a well-known document proves that the domain authorizes the address-to-DID association. Hosting that DID's Hail service does not itself make a provider the identity owner.

V1 provisionally supports `did:web` for domain owners and `did:plc` for users who do not bring a domain.

`did:plc` use remains provisional until its maintainers confirm that the public PLC directory is intended to accept non-AT Protocol production identities and custom Hail verification methods and services. Hail implementations should access PLC through a configurable DID resolver boundary so caching, mirrors, audit verification, and alternative resolution infrastructure can be introduced later.

## Hail DID Profile

A Hail-capable DID exposes two distinct verification methods and one service entry:

```text
#hail-identity   Signs grants and address bindings.
#hail-messaging  Signs envelopes, replies, receipts, and operational metadata.
#hail            Locates the current Hail server.
```

The identity and messaging roles use separate keys. This allows a provider to operate routine messaging without automatically receiving authority to create grants or address bindings for the user.

The `#hail` service has type `HailMessaging` and one HTTPS base endpoint. Standard server-to-server paths are derived from that base URL.

Provider migration updates `#hail-messaging` and `#hail` while preserving the DID, `#hail-identity`, grants, and message relationships. DID update and recovery keys remain separate from both Hail keys.

The complete profile is defined in [`spec/did-profile.md`](spec/did-profile.md).

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

The envelope is delivered first. The body is fetched or transferred only after the receiving server has verified that the sender has an active grant.

Benefits:

- unauthorized traffic can be rejected before parsing large bodies
- signatures can be checked over compact metadata
- one body can be reused for many recipients
- recipient servers can deduplicate by content hash
- assets can be bundled, cached, and verified separately
- remote tracking pixels become avoidable by design

High-level delivery flow:

1. Sender creates one body bundle and computes its hash.
2. Sender creates one signed envelope per recipient.
3. Sender posts the envelope to the recipient server.
4. Recipient server checks grant existence and category scope.
5. Recipient server verifies the sender signature.
6. Recipient server accepts the envelope.
7. Recipient server fetches or receives the body by hash.
8. Recipient server verifies the body hash.
9. Recipient server stores the message.

## Hail Envelope

The envelope should be compact and should carry only data needed for routing, authorization, preview, threading, and body retrieval.

Conceptual fields:

```json
{
  "version": 1,
  "message_id": "...",
  "from": "did:web:example-store.com:updates",
  "to": "did:plc:examplealiceidentifier",
  "category": "promotions",
  "message_type": "promotion",
  "created_at": 1787851200,
  "subject": "Weekend Sale",
  "summary": "Save up to 40% on summer gear.",
  "body_hash": "sha256:...",
  "reply": false,
  "reply_by": null,
  "reply_to": null,
  "reply_handler": null,
  "key_id": "2026-main",
  "signature": "..."
}
```

Notes:

- `reply` means the recipient may reply to this message.
- `reply_to` means this message is itself a reply to an earlier message.
- `reply_by` defines when the reply capability expires.
- `reply_handler` is an opaque sender-defined routing hint, such as a ticket id or queue id.
- Avatars should usually live in sender profile metadata, not every message.

## Replies

Replies are authorized by prior messages, not by standing grants in the reverse direction.

When a recipient receives a message with `reply: true`, the recipient server records a reply capability based on the signed envelope.

When the recipient sends a reply, the reply includes `reply_to` pointing at the original message. The original sender's server accepts the reply only if it previously sent that message with `reply: true` and the reply is still within `reply_by`.

Default reply window:

```text
120 days
```

Senders may set a longer or shorter `reply_by` timestamp when needed, such as for travel bookings made months in advance.

Sender profiles may declare reply limits, such as maximum body size and whether attachments are accepted. The protocol should define a minimum guaranteed reply capacity so ordinary text replies always work.

Open starting point:

```text
minimum reply body size: 64 KiB
```

Threads are chains of mutually solicited messages. Either side can end the thread by sending a message with `reply: false`.

## Revocation

Revocation is local and unilateral.

The recipient server enforces a signed revoked grant revision immediately and notifies the sender asynchronously. The sender does not approve revocation, and notification failure cannot delay it.

To reduce address probing, detailed rejection reasons should only be returned when the sender previously had a valid grant relationship. Unknown never-granted senders should receive a generic rejection.

Grant revocation is defined in [`spec/grants.md`](spec/grants.md). Delivery result semantics remain in [`spec/core-delivery.md`](spec/core-delivery.md) until the HTTP binding is finalized.

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

The main open design question is canonicalization.

Possible v1 approach:

- canonical JSON using RFC 8785 JSON Canonicalization Scheme
- detached Ed25519 signatures

Possible later approach:

- CBOR
- COSE signatures

Canonicalization means converting data into exactly one byte representation before signing. Without this, semantically identical JSON can have different byte encodings and break signatures.

## Server-To-Server Delivery

Minimal conceptual endpoints:

```text
GET  /.well-known/hail
PUT  /hail/grants/{grant_id}
POST /hail/envelopes
GET  /hail/bodies/{hash}
```

Replies should reuse `POST /hail/envelopes` as normal messages with reply-based authorization.

High-level delivery flow:

1. Sender discovers recipient server from the recipient domain or profile.
2. Sender sends a signed envelope to the recipient server.
3. Recipient server checks for an active delivery grant.
4. Recipient server checks category, expiration, rate limits, and content constraints.
5. Recipient server verifies sender identity and message signature.
6. Recipient server accepts or rejects the envelope.
7. Recipient server fetches or receives the detached body by hash.
8. Recipient server verifies and stores the message.

## Unsolicited Messages

V1 should not support unsolicited rich messages.

Unknown senders may eventually be allowed to send constrained contact or subscription requests, but those requests should be small, plain, rate-limited, and free of rich content or arbitrary links.

## Privacy And Analytics

Delivery receipts are a natural part of the protocol because the sender receives an accept or reject response from the recipient server.

Read receipts should be receiver-controlled and explicit. They should not be possible through covert mechanisms like tracking pixels.

Possible analytics model:

- delivery status is protocol-level
- read/open receipts are opt-in
- aggregate campaign stats may be provided by recipient servers or hosting providers
- per-user surveillance should not be built into the protocol

The pitch to legitimate senders is better deliverability and more honest engagement data in exchange for reduced covert tracking.

## Prototype Architecture

The first prototype should validate the wire protocol between two toy servers.

Suggested build phases:

1. Shared protocol library for envelope encode/decode, signing, verification, and schema validation.
2. Sender server with profile metadata, category manifest, grant receipt, body storage, and send pipeline.
3. Receiver server with grant table, inbox endpoint, ingest checks, body retrieval, and message store.
4. Test harness for subscribe, send, revoke, reply, expired reply, and unauthorized traffic rejection.
5. Minimal receiver client for grant approval and message reading.

The most important prototype metric is cost-to-reject unauthorized traffic.

If the receiver can drop unauthorized envelopes cheaply before signature verification and body transfer, Hail has a compelling infrastructure story compared with email spam filtering.

## Open Questions

- Should v1 require JSON, CBOR, or support JSON first with CBOR later?
- Should signatures use JCS plus Ed25519, COSE, or both?
- Will the PLC maintainers confirm non-AT Protocol production use of the public directory?
- What exact normalization, lifetime, and signature profile should Hail Address Bindings use?
- What non-DID profile fields are required for sender discovery?
- What should the guaranteed minimum reply size be?
- What is the initial body bundle format?
- What is the first useful block vocabulary after plain text?
- How should organization verification work beyond domain control?
- How should bridge-to-email work without weakening the anti-spam model?

## Topics To Discuss Next

- Minimal v1 protocol endpoints in detail.
- Discovery and domain ownership verification.
- Message envelope schema and required fields.
- Detached body bundle format.
- Reply path wire behavior.
- JSON versus CBOR for the prototype.
- Sender category manifest format.
- Block document v1 vocabulary.
- Server abuse protections and rate limits.
- Email bridge strategy.
- Business model and ecosystem incentives.
