# Hail Sender Profile

Status: Draft

This document defines the public signed metadata a prospective recipient reviews before granting a sender permission. The v1 Sender Profile includes the sender's category manifest; there is no separate Category Manifest object.

## Discovery Boundary

QR codes, search indexes, curated directories, and contact recommendations are application concerns. They provide a Hail address as an untrusted discovery hint. A client does not trust a search result or QR payload as identity evidence.

Before retrieving a profile, the client:

1. Canonicalizes and verifies the Hail address through its Address Binding.
2. Obtains the bound `did:plc` identity.
3. Resolves that DID's current Hail service and `#hail-messaging` key.
4. Retrieves the DID-scoped Sender Profile from the resolved service.
5. Verifies the profile signature and requires its `did` to equal the Address Binding DID.

The client displays the separately verified Hail address with the profile. The profile does not contain or authenticate an address, because one DID may have multiple independently verified addresses.

## Payload

Diagnostic JSON for the conceptual v1 payload:

```json
{
  "type": "hail.sender-profile",
  "version": 1,
  "did": "did:plc:bbbbbbbbbbbbbbbbbbbbbbbb",
  "revision": 1,
  "display_name": "Example Store",
  "description": "Receipts and account notifications",
  "offers_uncategorized": false,
  "categories": [
    {
      "id": "receipts",
      "label": "Receipts",
      "description": "Purchase receipts and refunds"
    },
    {
      "id": "security-alerts",
      "label": "Security alerts",
      "description": "Important account security notifications"
    }
  ],
  "updated_at": 1787851200,
  "key_id": "did:plc:bbbbbbbbbbbbbbbbbbbbbbbb#hail-messaging"
}
```

The payload is a closed Hail map under [encoding.md](encoding.md). Unknown fields are rejected in v1.

## Fields

### `type` And `version`

`type` is the exact string `hail.sender-profile`. `version` is the integer `1`.

### `did`

The canonical sender `did:plc` identifier. It identifies the profile lineage, must equal the DID used to discover the Hail service, and must control `key_id`.

### `revision`

A positive integer beginning at `1`. Every profile change, including re-signing after `#hail-messaging` rotation, increments the revision by exactly one.

A client that previously retained a profile for the DID rejects a lower revision. The same revision with a different complete signed representation is a conflict. An identical representation is the same profile. A first-time client cannot detect replay of an otherwise valid older revision and relies on the authenticated current service.

### `display_name`

Required plain text from 1 through 128 UTF-8 bytes after NFC normalization. It contains no Unicode `Cc` or `Cf` characters, including bidirectional controls, and contains no markup or interpreted links. It is descriptive metadata, not an identity authority; clients display the verified Hail address and DID separately.

### `description`

Optional plain text from 1 through 1024 UTF-8 bytes after NFC normalization. It contains no Unicode `Cc` or `Cf` characters, including bidirectional controls, and contains no markup. Clients render it as inert text.

### `offers_uncategorized`

Required boolean. `true` means the sender offers an uncategorized subscription. It does not grant permission; the recipient must still create a grant with the `uncategorized` selector.

### `categories`

Required array containing from 0 through 100 category entries. Entries are ordered by ascending bytewise category ID and IDs are unique.

Each category is a closed object containing:

- `id`: Required stable category ID using the grammar in [envelopes.md](envelopes.md#category).
- `label`: Required plain-text label from 1 through 128 UTF-8 bytes after NFC normalization.
- `description`: Optional plain-text explanation from 1 through 1024 UTF-8 bytes after NFC normalization.

Labels and descriptions contain no Unicode `Cc` or `Cf` characters, including bidirectional controls, contain no markup, and are rendered as inert text. They explain consent but do not alter the category ID's authorization semantics.

A sender must never repurpose a category ID for a materially different purpose. A new purpose requires a new ID. Renaming or removing a category from a later profile does not expand, narrow, or revoke an existing grant. Adding a category does not authorize it for any existing grant. A recipient changes authorization only by issuing a new signed grant revision.

### `updated_at`

Required non-negative Unix timestamp in seconds. It changes with every revision and must be no earlier than the prior retained revision's value. At verification it must not be more than 300 seconds in the future.

### `key_id`

The exact absolute DID URL formed from `did` and `#hail-messaging`. Its UTF-8 bytes must equal the protected COSE `kid` and identify the currently authorized Hail messaging key under the PLC rules in [did-profile.md](did-profile.md).

## Signature And Representation

Hail Sender Profile v1 uses the deterministic CBOR and tagged COSE_Sign1 profile in [encoding.md](encoding.md). Its protected content type is:

```text
application/hail-sender-profile+cbor
```

V1 applies no HTTP content coding to the signed representation.

## Representation Digest

The Sender Profile representation digest is SHA-256 over the complete signed representation bytes, including protected headers, payload, and signature. A Hail payload carries it as exactly 32 bytes; an HTTP ETag or diagnostic value uses the exact 43-character unpadded base64url rendering defined by [encoding.md](encoding.md).

Every grant's required `consent_context` includes `sender_profile_hash`, which records the profile reviewed during consent. The grantor retains the exact signed profile and its PLC verification evidence with that consent evidence. The digest is evidence of presentation context; delivery authorization still comes exclusively from the signed grant's DID parties and scope.

## Retrieval

The HTTPS binding defines:

```http
GET {sender-hail-service-base}/profiles/{sender_did}
```

The complete canonical `did:plc` value is inserted as one literal path segment without percent encoding. The response is public, but its signed COSE representation is still required so profile evidence remains verifiable after retrieval and storage.

Clients do not follow redirects. Provider migration is discovered through PLC. A client may retry at a newly resolved Hail service under the endpoint-refresh rules in [http-binding.md](http-binding.md).

The complete signed representation is limited to 65536 bytes. A profile may contain no active subscription choices when `categories` is empty and `offers_uncategorized` is false; clients then display it as unavailable for new grants.

A cached profile never extends the PLC cache lifetime or authorization of its signing key. Before using a profile for new consent, the client verifies it against PLC state fresh enough for new Hail signature acceptance under [did-profile.md](did-profile.md). If `#hail-messaging` was removed, the cached profile is unusable even when its HTTP freshness lifetime has not ended.

## Grant Creation

For categorized consent, every selected grant category must appear in the verified profile revision. For uncategorized consent, `offers_uncategorized` must be `true`.

The client shows the verified address, DID, profile display name, description, and offered choices. Display names and descriptions never replace the verified address as the visible identity anchor.

The recipient creates and signs the grant or instructs its own provider to do so under its disclosed key-custody model. The recipient server stores the grant locally before asynchronously publishing it to the sender's current Hail service.

## Security And Privacy

Sender Profiles are public and may be copied or indexed. They contain no recipient-specific state and must not reveal subscriber counts, grant existence, delivery history, or other relationship information.

Search indexes can omit, reorder, or forge profile metadata. Clients treat search results only as discovery hints and verify the address, DID, current signed profile, and profile-to-DID match before consent.

Profile text is untrusted display content. Clients render it without HTML, active links, bidirectional-control characters, remote assets, or other behavior that could obscure the verified Hail address. Avatars and profile assets are excluded from v1 so profile retrieval cannot become a tracking or active-content channel.

## POC Requirements

The POC implements:

- one DID-scoped signed Sender Profile with embedded categories
- deterministic retrieval from the sender's PLC-discovered Hail service
- revision and rollback checks
- `#hail-messaging` Ed25519 signatures
- deterministic Hail CBOR and tagged COSE_Sign1
- protected content type `application/hail-sender-profile+cbor`
- 65536-byte maximum signed representation
- no redirects or HTTP content coding
- required Sender Profile digest in grant consent context
- application-specific QR and search entry points that yield a Hail address
