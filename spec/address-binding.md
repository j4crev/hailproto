# Hail Address Binding

Status: Draft

This document defines how a human-readable Hail address is associated with a durable DID.

Hail addresses are aliases. Hail Grants, Hail Envelopes, and durable relationships use DIDs.

## Goals

- Resolve a human-readable address to a DID.
- Require agreement from both the address domain and DID controller.
- Work with both `did:web` and `did:plc`.
- Avoid permanently publishing provider-address history in a PLC operation log.
- Allow an address binding to expire or be replaced without changing the DID.
- Prevent address reassignment from transferring grants or message history.
- Use existing web standards where practical.

## Non-Goals

- Making a human-readable address the durable identity.
- Preventing impersonation after complete compromise of the address domain.
- Defining provider account recovery.
- Defining DID key rotation or recovery.
- Granting delivery permission. An address binding is not a Hail Grant.

## Terminology

- **Hail address**: A case-insensitive human-readable alias such as `alice@example.com`.
- **Address domain**: The domain portion of a Hail address, such as `example.com`.
- **Address binding**: A signed statement associating one canonical Hail address with one DID for a limited period.
- **Address authority**: The domain that publishes the address mapping over authenticated HTTPS.
- **DID controller**: The entity authorized to use a verification method in the resolved DID document.

## Trust Model

An address is verified only when both sides agree:

1. The address domain publishes a mapping to the DID.
2. A key authorized by that DID signs the same mapping.

Conceptually:

```text
address domain --publishes--> address + DID
DID controller  ----signs----> address + DID
```

Neither statement is sufficient by itself.

A DID can claim an address it does not own, and a domain can point an address at a DID whose controller did not agree. Verification succeeds only when the published and signed values match.

## Discovery

The provisional discovery mechanism is WebFinger, defined by RFC 7033, using an `acct` URI as defined by RFC 7565.

Given:

```text
alice@example.com
```

the client constructs the canonical resource identifier:

```text
acct:alice@example.com
```

and requests:

```http
GET https://example.com/.well-known/webfinger?resource=acct%3Aalice%40example.com
Accept: application/jrd+json
```

Conceptual response:

```json
{
  "subject": "acct:alice@example.com",
  "links": [
    {
      "rel": "https://hailprotocol.example/rel/address-binding",
      "type": "application/hail-address-binding+json",
      "href": "https://example.com/.well-known/hail/addresses/alice"
    }
  ]
}
```

The final relation URI and publication domain remain to be selected before standardization.

The WebFinger response proves that the address domain selected the binding resource. The binding resource may be hosted by delegated infrastructure, but the client must first obtain its URL from the address domain's authenticated WebFinger response.

## Binding Payload

Conceptual signed payload:

```json
{
  "version": 1,
  "type": "hail.address-binding",
  "address": "alice@example.com",
  "did": "did:plc:examplealiceidentifier",
  "issued_at": 1787851200,
  "expires_at": 1795627200,
  "key_id": "did:plc:examplealiceidentifier#hail-identity"
}
```

The signature wrapper is separate from the payload so the exact signed fields are unambiguous. Its representation is defined below.

Required payload fields:

- `version`: Address Binding profile version.
- `type`: Exact value `hail.address-binding` for v1.
- `address`: Canonical Hail address without the `acct:` prefix.
- `did`: Exact DID associated with the address.
- `issued_at`: UTC issuance time represented as Unix seconds.
- `expires_at`: UTC expiration time represented as Unix seconds.
- `key_id`: DID URL identifying the DID's `#hail-identity` verification method.

Unknown payload fields are rejected in v1.

## Signature And Representation Profile

Hail Address Binding v1 uses RFC 8785 canonical JSON in RFC 7515 flattened JWS JSON Serialization. The complete wrapper is a closed JSON object containing exactly `payload`, `protected`, and `signature`; an unprotected `header` member is prohibited.

Conceptual wrapper, shown in canonical member order:

```json
{
  "payload": "base64url-jcs-address-binding-payload",
  "protected": "base64url-protected-header",
  "signature": "base64url-ed25519-signature"
}
```

The decoded protected header is the closed object:

```json
{
  "alg": "Ed25519",
  "kid": "did:plc:examplealiceidentifier#hail-identity",
  "typ": "hail-address-binding+jws"
}
```

Rules:

- The payload, protected header, and complete flattened JWS wrapper use their exact RFC 8785 canonical UTF-8 representations.
- `alg` is the RFC 9864 value `Ed25519`; `EdDSA`, other algorithms, negotiation, and fallback are rejected in v1.
- `kid` is an absolute DID URL under the payload's `did`, has that DID as its controller, and identifies its authorized `#hail-identity` verification method.
- Protected `kid` exactly equals payload `key_id`.
- `typ` is the exact string `hail-address-binding+jws`.
- All three protected parameters are required. Unknown protected parameters and all unprotected parameters are rejected.
- Payload and protected-header bytes are base64url encoded without padding and signed using the RFC 7515 JWS Signing Input.
- Duplicate member names, invalid UTF-8, non-I-JSON values, padded or noncanonical base64url, and decoded payload or header bytes that are not their exact JCS representations are rejected.

The complete canonical JWS bytes are the immutable signed representation of one Address Binding. A verifier retains and hashes those exact bytes rather than parsing and reserializing the binding.

## Retrieval Representation And Limits

The WebFinger link and binding response use the provisional v1 media type:

```text
application/hail-address-binding+json
```

The media type contains the flattened JWS wrapper and carries no parameters. A verifier requests it with `Accept: application/hail-address-binding+json`. A successful binding retrieval returns `200 OK` with that exact parameterless `Content-Type` and no `Content-Encoding`. A verifier rejects another success status, a different or parameterized media type, or any HTTP content coding.

A conforming publisher produces, and a conforming verifier accepts, complete valid Address Binding JWS representations through 16384 bytes. A verifier rejects a larger response before cryptographic verification. This limit applies to the transmitted UTF-8 representation; the WebFinger JRD has a separate response-size limit.

## Binding Representation Digest

The Address Binding representation digest is SHA-256 over the complete exact canonical flattened JWS bytes, including the protected header, payload, and signature. Its value is encoded as exactly 43 unpadded base64url characters representing 32 digest bytes.

When a grant records the binding used during consent, its `address_binding_hash` commits to this digest. The recipient retains the exact Address Binding JWS and its DID-resolution verification evidence for as long as it retains the corresponding grant revision or consent evidence, subject to the historical DID evidence rules still to be finalized. The digest identifies the signer key, signature, and payload that were verified.

## Verification Algorithm

Given a user-supplied Hail address, a verifier:

1. Normalizes the address according to the Hail address profile.
2. Constructs its canonical `acct:` URI.
3. Performs WebFinger discovery against the address domain over HTTPS.
4. Requires the WebFinger `subject` to equal the canonical `acct:` URI.
5. Selects exactly one supported Hail Address Binding link.
6. Fetches the binding with strict response-size, timeout, redirect, and network-address limits.
7. Validates the binding schema.
8. Requires the binding `address` to equal the canonical requested address.
9. Checks `issued_at` and `expires_at` using the allowed clock-skew policy.
10. Resolves the exact DID from the binding according to its DID method.
11. Requires `key_id` to be that DID's `#hail-identity` verification method as defined by [did-profile.md](did-profile.md).
12. Verifies the flattened JWS and exact canonical representation under the Address Binding signature profile.
13. Returns the verified DID and binding expiration.

Any mismatch or ambiguity causes address verification to fail.

## Use Of `alsoKnownAs`

Hail does not require `alsoKnownAs` for address verification.

A DID document may include a Hail address in `alsoKnownAs` as informational metadata, but clients must not treat it as sufficient proof of address ownership.

In particular, Hail should not require provider-issued addresses to be written into PLC operations because PLC history is permanent and publicly enumerable. Signed, expiring Address Bindings avoid creating a permanent history of every provider address used by one identity.

## Address Changes

Changing a Hail address does not change the DID.

Example:

```text
alice@provider-a.example -> did:plc:examplealiceidentifier
alice@provider-b.example -> did:plc:examplealiceidentifier
```

The new address domain publishes a new binding signed by the same DID. Existing grants continue to reference the DID and remain valid.

The old binding may be removed or allowed to expire. If the old address is later reassigned, its new binding must name a different DID. The new address holder does not inherit grants, messages, or reply capabilities belonging to the previous DID.

## Grant And Delivery Behavior

Address verification is primarily used during:

- sender discovery
- grant approval
- initial grant publication
- contact display
- address-change handling

After a grant is created, delivery authorization uses the DIDs in the grant and envelope. A recipient server must not re-resolve the sender's address on every delivery or transfer a grant merely because an address now resolves to another DID.

The verified address used during consent may be retained as grant metadata for display and auditing, but it is not the grant's authorization identity.

## Caching

A successful address-resolution result must not be cached beyond:

- the binding's `expires_at` time
- any shorter HTTP cache lifetime
- any shorter local security policy

Clients should refresh a binding before displaying an address as currently verified after its cached lifetime expires.

Changing or expiring an address binding does not revoke grants issued to the DID.

## Security Considerations

### Domain Compromise

If an attacker controls the address domain and an attacker-controlled DID, the attacker can publish and sign a new binding. Address binding cannot eliminate the address domain as the trust anchor for its namespace.

### DID Key Compromise

Compromise of `#hail-identity` allows unauthorized bindings and grants until the key is rotated or revoked through the DID method. The identity key is separate from `#hail-messaging` and from DID update or recovery keys.

### Binding Replay

Bindings must expire. Verifiers must check current publication through the address domain and must not accept an unexpired binding obtained from an unrelated source as proof that the domain still publishes it.

### Address Reassignment

Applications must key grants, messages, and contacts by DID rather than address. Otherwise, address reassignment could transfer authority or private data.

### Server-Side Request Forgery

Binding retrieval must use an HTTP client with URL, redirect, DNS rebinding, private-network, timeout, and response-size protections. The WebFinger response must not provide unrestricted access to internal network resources.

### Enumeration

WebFinger may reveal whether a Hail address exists. Providers should apply rate limits and should avoid returning unnecessary account metadata.

### Correlation

The current address-to-DID mapping is public by nature. Avoiding `alsoKnownAs` prevents PLC from retaining a permanent address history, but observers may still collect mappings while they are active.

## POC Profile

The proof of concept should implement the same signed binding model rather than an `alsoKnownAs` shortcut.

The POC needs:

- case-insensitive ASCII Hail addresses
- WebFinger lookup using canonical `acct:` URIs
- one Address Binding link
- one signed binding payload
- `did:web` and `did:plc` resolution
- binding expiration checks
- RFC 8785 canonical payload, protected header, and flattened JWS wrapper
- RFC 9864 `Ed25519` signature verification using `#hail-identity`
- `application/hail-address-binding+json` with no HTTP content coding
- 16384-byte maximum complete binding representation
- strict fetch limits

The POC may use a temporary relation URI. It uses the v1 signature and representation profile defined above.

## Open Questions

- What exact ASCII and Unicode normalization rules define a canonical Hail address?
- Are internationalized local parts or domains supported in v1?
- What permanent WebFinger link relation URI should identify an Address Binding?
- May a binding URL use a different origin than the address domain?
- Are redirects ever allowed when fetching bindings?
- What maximum binding lifetime is allowed?
- What clock skew is permitted?
- Can one address have overlapping bindings during a DID transition?
- Can one DID have multiple simultaneously verified Hail addresses?
- What response should clients show when a previously verified binding expires?
