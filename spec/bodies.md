# Detached Hail Bodies

Status: Draft

This document defines publication, content addressing, authorization, retrieval, verification, caching, and retention for detached Hail Bodies.

A Hail Envelope carries a compact descriptor for a body that already exists on the sender's Hail server. A recipient server retrieves or reuses that body only after authorizing the envelope.

Safe Portable Text document semantics are defined separately in [`../BODY_FORMAT.md`](../BODY_FORMAT.md). This document treats the encoded body as immutable bytes.

## Core Rules

- The complete body must exist before any referencing envelope is submitted.
- A published body is immutable.
- The body digest covers exact uncompressed canonical body bytes.
- HTTP compression is a transport concern and does not change body identity.
- The body endpoint is derived from the sender DID's authenticated `#hail` service.
- Envelopes must not contain arbitrary body URLs.
- The recipient server pulls a body only after envelope authorization.
- One body may be referenced by envelopes for many recipients.
- Every recipient envelope carries separate retrieval authorization.
- Recipient servers may deduplicate exact body storage by digest; retrieval may be skipped only with matching recipient-and-sender cache provenance.
- Every envelope commits to at least 30 days of body availability from its creation time.
- A shared body remains available through the latest `available_until` value in any referencing envelope.
- Body retrieval is a server action and does not indicate that a user opened or read a message.

## Publication Before Submission

Before submitting a Hail Envelope, the sender:

1. Constructs the complete body document.
2. Encodes it into the canonical uncompressed byte representation.
3. Computes its body digest and uncompressed size.
4. Stores the exact bytes in immutable content-addressed storage.
5. Makes the body available through its authenticated Hail service.
6. Creates recipient-specific body access authorization.
7. Constructs and signs each recipient envelope.

An envelope must never refer to a body that the sender intends to generate later. This avoids acceptance races, inconsistent personalized content, and hash commitments to unavailable data.

## Canonical Body Bytes

For the POC, a Hail Body is a Safe Portable Text `spt-1` JSON document.

The sender canonicalizes the document using the JSON Canonicalization Scheme defined by RFC 8785 and encodes the result as UTF-8. Those bytes are the canonical body bytes.

Example source document:

```json
{
  "version": 1,
  "profile": "spt-1",
  "blocks": [
    {
      "_type": "block",
      "style": "normal",
      "children": [
        {
          "_type": "span",
          "text": "Hello from Hail.",
          "marks": []
        }
      ],
      "markDefs": []
    }
  ]
}
```

The exact canonical bytes are stored and served. A receiver hashes the bytes it receives after removing HTTP content coding; it does not use a reserialized document to reproduce that digest. After the raw-byte digest succeeds, it separately parses and JCS-canonicalizes the document and requires the result to equal the received bytes.

## Body Digest

The POC uses SHA-256 over the exact canonical body bytes.

The digest value is encoded using unpadded base64url as defined by RFC 4648.

Conceptual descriptor fragment:

```json
{
  "algorithm": "sha-256",
  "value": "base64url-sha256-digest"
}
```

The digest identifies content, not a delivery or message. Different envelopes may reference the same digest.

The digest is not secret. Implementations must not treat knowledge of it as authorization to retrieve the body.

## Envelope Body Descriptor

Every envelope contains a signed body descriptor.

Conceptual v1 shape:

```json
{
  "body": {
    "digest": {
      "algorithm": "sha-256",
      "value": "base64url-sha256-digest"
    },
    "size": 8421,
    "media_type": "application/spt+json",
    "profile": "spt-1",
    "available_until": 1790443200,
    "access": {
      "type": "bearer",
      "token": "base64url-random-token",
      "expires_at": 1790443200
    }
  }
}
```

The final placement, naming, and closed v1 schema of this descriptor are defined in [envelopes.md](envelopes.md).

### `digest`

The content digest of the exact uncompressed canonical body bytes.

### `size`

The exact uncompressed byte length. A recipient checks this limit before retrieval and enforces it while streaming and decompressing the response.

### `media_type`

The POC value is `application/spt+json`. This media type is provisional until registration or final specification.

### `profile`

The POC value is `spt-1`.

### `available_until`

The minimum UTC Unix timestamp through which the sender commits to serving the body.

It must be at least 30 days after the envelope's `created_at` time. A body reused by a later envelope receives a correspondingly later availability commitment.

### `access`

Recipient-specific retrieval authorization covered by the envelope signature.

## POC Retrieval Authorization

The POC uses a recipient-specific opaque bearer token.

The sender generates at least 256 bits of cryptographically secure random data and encodes it with unpadded base64url. The same token may be reused for retries of the same envelope but must not be reused for another recipient or unrelated envelope.

The sender stores only a cryptographic digest of the token, mapped to:

- body digest
- recipient DID
- envelope or message ID
- expiration
- authorization status

The sender includes the original token in the recipient's signed envelope. The envelope signature prevents an intermediary from changing which token, body, recipient, or expiration the sender authorized.

The recipient presents the token in the HTTP `Authorization` header, never in the URL:

```http
GET /hail/bodies/{digest}
Authorization: Bearer base64url-random-token
Accept: application/spt+json
Accept-Encoding: gzip
```

The POC uses the Bearer authentication scheme syntax defined by RFC 6750 without adopting OAuth token issuance or authorization flows.

Query-string tokens are prohibited because URLs commonly appear in access logs, browser history, monitoring systems, and referrer data.

The sender accepts retrieval only when:

- the token digest matches an active authorization record
- the requested body digest matches the authorized body
- the authorization has not expired
- the token is presented over HTTPS

Invalid, unknown, mismatched, and expired tokens fail without revealing whether the body digest exists.

## Signatures Versus Encryption

A signature is created with a private key and verified with a public key. A token cannot be "signed with the receiver's public key."

The token could be encrypted to a recipient public key, but Hail v1 does not otherwise provide end-to-end envelope encryption. Encrypting only the retrieval token would add key-agreement and recovery complexity without protecting the rest of the envelope metadata.

For the POC, HTTPS protects the envelope in transit and the sender's `#hail-messaging` signature authenticates the token and body descriptor.

## Future Proof Of Possession

Bearer authorization is intentionally simple but possession of a stolen token permits retrieval until expiration.

A future profile may additionally require the recipient server to sign the retrieval request with its DID-authorized `#hail-messaging` key using RFC 9421 HTTP Message Signatures. That would bind retrieval to proof of recipient key possession rather than token possession alone.

Possible future flow:

```text
recipient-specific body authorization in signed envelope
  + bearer token or capability identifier
  + HTTP request signed by recipient #hail-messaging
```

This is deferred until the shared Hail HTTP signature profile is specified.

## Shared Bodies

The sender stores one immutable body blob per digest, regardless of how many recipient envelopes reference it.

Recipient authorization remains separate:

```text
body digest -> one stored blob
token A     -> recipient A + body digest
token B     -> recipient B + body digest
token C     -> recipient C + body digest
```

This preserves body deduplication while preventing the digest itself from becoming a public retrieval capability.

Personalized bodies naturally produce different canonical bytes and digests. Senders must not claim two bodies are shared unless every byte is identical.

## Recipient Deduplication

A recipient server may already possess verified canonical bytes for a digest from an earlier delivery to the same recipient from the same sender.

After authorizing an envelope, the server may satisfy body retrieval from its local content-addressed cache only when the cache has verified provenance for the same recipient DID and sender DID, and when:

- the cached byte length equals the envelope size
- the cached digest was previously verified
- the media type and profile match
- local retention policy permits reuse

The server does not need to redeem another token for a cache entry with matching recipient and sender provenance. Cross-recipient cache presence must not determine delivery behavior. V1 performs recipient-specific retrieval when matching provenance is absent; coordinated cross-recipient retrieval requires a future privacy-preserving authorization profile.

Consequences:

- underlying storage may deduplicate bytes without exposing cross-recipient cache membership
- body fetch counts are not reliable delivery counts
- body fetches must never be treated as opens or reads
- senders receive delivery state through the delivery protocol, not tracking requests

## Retrieval Endpoint

The body endpoint is derived from the sender DID's authenticated `#hail` service base URL.

Conceptual endpoint:

```text
{hail-service-base}/bodies/{digest}
```

An envelope does not carry a full body URL. This prevents envelopes from directing recipient servers to arbitrary networks or hosts.

V1 retrieval does not follow redirects. A provider migration is represented by updating the DID's `#hail` service and is handled by DID re-resolution, not HTTP redirection.

## Retrieval Response

Conceptual successful response:

```http
HTTP/1.1 200 OK
Content-Type: application/spt+json
Content-Encoding: gzip
Cache-Control: private, no-store
Content-Digest: sha-256=:base64-standard-digest:
```

The RFC 9530 `Content-Digest` header is recommended as transport-level integrity metadata. The digest committed by the signed envelope remains authoritative.

The response body may use an allowed HTTP content coding. After bounded decompression, the recipient verifies:

1. Uncompressed byte length exactly equals the declared `size`.
2. SHA-256 digest exactly equals the envelope digest.
3. HTTP media type equals the declared media type.
4. Body profile equals the declared and supported profile.
5. The bytes exactly equal the RFC 8785 canonicalization of the parsed JSON document.
6. The SPT document passes strict schema and resource-limit validation.

The recipient does not render or store the message as delivered until all checks succeed.

## Compression

Compression is outside body identity.

```text
canonical uncompressed bytes -> size and SHA-256 body digest
HTTP content coding          -> transfer optimization only
```

The same body may be transferred with no content coding or an allowed coding such as gzip without changing its digest.

Recipients must stream decompression with a hard output limit. They must stop before allocating or producing bytes beyond the envelope's declared size or their local maximum.

## POC Resource Limits

The POC supports no body assets or attachments and uses a maximum uncompressed body size of 256 KiB.

The receiver enforces:

- envelope-declared size no greater than 256 KiB
- bounded compressed response bytes
- streaming decompression capped at the declared size
- exact final uncompressed size
- Safe Portable Text depth, node-count, and string-length limits
- request and response timeouts

Production interoperability floors and ceilings remain to be specified from prototype measurements.

## Retention

The sender must retain the exact body bytes and each retrieval authorization through that envelope's signed `available_until` value. For a shared body, storage continues through the latest `available_until` value among all referencing envelopes.

Each envelope commits to at least 30 days from its `created_at` time. Retries of the same envelope do not extend that signed commitment. A sender may commit to and provide a longer period.

Recipient servers should attempt retrieval promptly. After successful verification, the recipient becomes responsible for its stored copy under its own retention policy.

If the sender removes or changes a body before `available_until`, it has violated the delivery contract. Content at the same digest path must never change; different bytes necessarily have a different digest.

After `available_until`, an incomplete delivery fails permanently. Voluntary continued service does not extend the signed delivery deadline or permit another retry of the accepted envelope.

## Retry Behavior

Transient network and server failures may be retried with bounded exponential backoff and jitter until `available_until` or 300 seconds after the envelope's `expires_at` delivery deadline, whichever occurs first. The 300 seconds are the envelope's clock tolerance, not an extension of body availability.

The same token is valid for multiple retrieval attempts until its expiration. Retrieval is not single-use because interrupted streams and recipient recovery require retries.

Delivery state, retry ownership, and reason codes are defined in [delivery-state.md](delivery-state.md). Body retrieval follows these classifications:

- temporary retrieval failure: retry
- rate limited with `Retry-After`: retry as directed
- invalid or mismatched authorization: permanent failure
- authorization expired: permanent failure
- body unavailable before commitment ends: retry and record sender fault
- body unavailable after commitment ends: permanent failure
- size, digest, media type, or schema mismatch: permanent integrity failure

Exact HTTP status codes and RFC 9457 problem types belong to the Hail HTTP binding.

## Privacy And Analytics

Body retrieval occurs between servers shortly after envelope authorization. It reveals neither a user open nor a read.

Recipient caching, proxying, and storage deduplication are explicitly allowed within the provenance rules above. Body fetches and token redemption are server delivery operations and do not indicate user engagement.

Remote resources inside SPT content remain prohibited unless a future Safe Portable Text asset profile explicitly defines them. Body retrieval authorization must not become a covert tracking channel.

## Security Considerations

### Bearer Token Leakage

Anyone possessing a token can retrieve its authorized body until expiration. Tokens must be generated securely, transmitted only over HTTPS, excluded from URLs and logs, stored hashed by the sender, and protected by recipient servers.

### Server-Side Request Forgery

Recipients derive the body endpoint only from the authenticated DID service. They do not accept envelope-supplied URLs or redirects. DNS rebinding and private-network protections from the Hail DID profile still apply.

### Content Guessing

A body digest may be guessable when content is public or predictable. Retrieval still requires recipient authorization; the endpoint must not serve a body based only on its digest.

### Token Enumeration

At least 256 random token bits make online guessing infeasible. The sender must rate-limit failures and return responses that do not distinguish a missing body from invalid authorization.

### Decompression Bombs

The declared uncompressed size is enforced while streaming. Implementations must not trust `Content-Length`, compressed size, or the sender's decompressor metadata as an output bound.

### Shared-Body Correlation

The same digest indicates byte-identical content. DIDs and envelopes are not globally published by Hail, but providers that observe several envelopes may infer shared campaign membership. End-to-end encrypted bodies may require a different deduplication design later.

## POC Requirements

The proof of concept implements:

- body creation before envelope submission
- immutable JCS-canonicalized `spt-1` JSON bytes
- SHA-256 digest over uncompressed bytes
- unpadded base64url digest representation
- exact uncompressed size declaration
- provisional `application/spt+json` media type
- recipient pull from the authenticated sender Hail service
- one random 256-bit bearer token per recipient envelope
- token presentation in the HTTP `Authorization` header
- one stored body shared by many authorization records
- recipient caching and digest deduplication
- no redirects or arbitrary body URLs
- gzip transfer support
- 256 KiB maximum uncompressed body size
- 30-day minimum availability commitment
- bounded retries and strict integrity validation

Deferred:

- RFC 9421 recipient proof of possession
- end-to-end encryption
- bundled and deferred assets
- attachments
- remote asset profiles
- content negotiation beyond the POC profile
- production size floors and ceilings

## Open Questions

- Should production retrieval use bearer authorization alone or require RFC 9421 proof of possession?
- Should access authorization be per envelope or reusable for the same recipient and body?
- What final body media type should be registered?
- What production uncompressed body size must every server accept?
- Which compression algorithms are required or optional after the POC?
- How does provider migration affect in-progress retrieval from an old service endpoint?
