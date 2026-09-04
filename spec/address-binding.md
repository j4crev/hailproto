# Hail Address Binding

Status: Draft

This document defines how a human-readable Hail address is associated with a durable DID.

Hail addresses are aliases. Hail Grants, Hail Envelopes, and durable relationships use DIDs.

## Goals

- Resolve a human-readable address to a DID.
- Require agreement from both the address domain and DID controller.
- Bind either a provider-issued or custom-domain address to a `did:plc` identity.
- Avoid permanently publishing Hail address history in a PLC operation log.
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

## Address Syntax And Canonicalization

Hail v1 uses common email-shaped addresses but does not adopt every legacy SMTP mailbox form. An address consists of one ASCII dot-atom local part, one `@`, and one public DNS domain.

The local-part grammar is:

```abnf
local-part = atom *("." atom)
atom = 1*(ALPHA / DIGIT / "!" / "#" / "$" / "%" / "&" / "'" /
          "*" / "+" / "-" / "/" / "=" / "?" / "^" / "_" / "`" /
          "{" / "|" / "}" / "~")
```

Consequently, a local part cannot be empty, begin or end with `.`, contain consecutive dots, whitespace, controls, non-ASCII characters, or another `@`. Quoted local parts, comments, display names, route syntax, and domain literals are not Hail addresses. The local part is at most 64 ASCII bytes.

The domain accepts Unicode U-label or ASCII A-label input. A verifier applies IDNA2008 lookup processing, rejects invalid or non-round-tripping labels, and emits every label as its lowercase ASCII A-label. A trailing root dot is invalid. Each resulting label is from 1 through 63 bytes, does not begin or end with `-`, and the complete domain is at most 253 ASCII bytes. The domain must have a registrable domain beneath a suffix recognized by the current [Public Suffix List](https://publicsuffix.org/list/); a bare public suffix, unqualified name, address literal, and special-use or unknown suffix are invalid for public Hail federation.

The complete canonical address is at most 254 ASCII bytes. To canonicalize an accepted address, lowercase the ASCII local part, append `@`, and append the lowercase IDNA A-label domain. Hail address comparison is exact bytewise comparison of this canonical form. This deliberately overrides SMTP's theoretical case sensitivity for mailbox local parts.

To construct the RFC 7565 `acct:` URI, prefix the canonical address with `acct:` and percent-encode local-part bytes not permitted directly by the `acct` URI `userpart` grammar using uppercase hexadecimal digits. The delimiter `@` and canonical A-label domain remain literal. The complete `acct:` URI is then percent-encoded as an RFC 7033 query-parameter value when constructing the WebFinger request.

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

Because every Hail identity uses PLC, the address domain and PLC rotation authority are separate trust anchors. Domain control alone cannot rotate the named DID's keys or service, and PLC control alone cannot publish the domain's WebFinger mapping. A compromised domain can redirect the address to another DID, but it cannot inherit grants or message history bound to the original DID.

## Discovery

Hail address discovery uses WebFinger, defined by RFC 7033, with an `acct` URI defined by RFC 7565. The permanent Hail Address Binding link relation is:

```text
https://hailproto.com/rel/address-binding
```

This is an RFC 8288 extension relation URI. Clients compare it as the exact lowercase string above and do not dereference it during discovery.

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
GET https://example.com/.well-known/webfinger?resource=acct%3Aalice%40example.com&rel=https%3A%2F%2Fhailproto.com%2Frel%2Faddress-binding
Accept: application/jrd+json
Accept-Encoding: identity
```

Conceptual response:

```json
{
  "subject": "acct:alice@example.com",
  "links": [
    {
      "rel": "https://hailproto.com/rel/address-binding",
      "type": "application/hail-address-binding+json",
      "href": "https://example.com/.well-known/hail/addresses/alice"
    }
  ]
}
```

The `rel` request parameter is a response filter, not a guarantee that the returned JRD contains only that relation. A verifier requires the JRD `subject` to exactly equal the canonical `acct:` URI and selects exactly one link whose `rel` and `type` exactly equal the Hail values above. No match or multiple matches fail address verification.

The WebFinger response proves that the address domain selected the binding resource. The binding `href` may use a different origin, allowing delegated providers and CDNs, but the client must first obtain that URL from the address domain's authenticated WebFinger response.

### WebFinger Retrieval

A verifier sends the WebFinger request to the canonical address domain over HTTPS. It may follow at most three WebFinger redirects, as permitted by RFC 7033. Every redirect target must use HTTPS, contain a public ASCII DNS hostname in canonical IDNA A-label form, contain no username, password, or fragment, and pass the network-address checks below. The verifier follows the supplied `Location` URI rather than reconstructing or appending query parameters.

The complete redirect chain shares a 10-second response deadline, with a 5-second connection timeout for each connection. Every TLS connection requires normal hostname and certificate validation. Every DNS result and connection address is checked to reject IP-address hostnames, loopback, link-local, private, reserved, or otherwise non-public addresses and to prevent DNS rebinding. Requests send no `Authorization`, `Cookie`, or `Referer` fields and use `Accept-Encoding: identity`.

The final WebFinger response must be `200 OK` with exact parameterless `Content-Type: application/jrd+json` and no `Content-Encoding`. The transmitted JRD is limited to 65536 bytes, must be valid UTF-8 JSON with one top-level object, and must not contain duplicate member names. Unknown JRD members and unrelated links are ignored as required by RFC 7033.

## Binding Payload

Conceptual signed payload:

```json
{
  "version": 1,
  "type": "hail.address-binding",
  "address": "alice@example.com",
  "did": "did:plc:aaaaaaaaaaaaaaaaaaaaaaaa",
  "issued_at": 1787851200,
  "expires_at": 1795627200,
  "key_id": "did:plc:aaaaaaaaaaaaaaaaaaaaaaaa#hail-identity"
}
```

The signature wrapper is separate from the payload so the exact signed fields are unambiguous. Its representation is defined below.

Required payload fields:

- `version`: Address Binding profile version.
- `type`: Exact value `hail.address-binding` for v1.
- `address`: Canonical Hail address without the `acct:` prefix.
- `did`: Canonical `did:plc` identifier associated with the address, as defined by the Hail DID profile.
- `issued_at`: UTC issuance time represented as Unix seconds.
- `expires_at`: UTC expiration time represented as Unix seconds.
- `key_id`: DID URL identifying the DID's `#hail-identity` verification method.

Unknown payload fields are rejected in v1.

`issued_at` and `expires_at` are non-negative integers. `expires_at` must be greater than `issued_at`, and their difference must not exceed 7776000 seconds, or 90 days. At verification time, `issued_at` must not be more than 300 seconds in the future and current time must not be more than 300 seconds after `expires_at`. Clock tolerance does not alter either signed timestamp or extend the cache lifetime below.

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
  "kid": "did:plc:aaaaaaaaaaaaaaaaaaaaaaaa#hail-identity",
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

The WebFinger link and binding response use the v1 media type:

```text
application/hail-address-binding+json
```

The media type contains the flattened JWS wrapper and carries no parameters. A verifier requests it with `Accept: application/hail-address-binding+json` and `Accept-Encoding: identity`. A successful binding retrieval returns `200 OK` with that exact parameterless `Content-Type` and no `Content-Encoding`. A verifier rejects another success status, a different or parameterized media type, or any HTTP content coding.

A conforming publisher produces, and a conforming verifier accepts, complete valid Address Binding JWS representations through 16384 bytes. A verifier rejects a larger response before cryptographic verification. This limit applies to the transmitted UTF-8 representation; the WebFinger JRD has a separate response-size limit.

The binding `href` must be an absolute HTTPS URL with a public ASCII DNS hostname in canonical IDNA A-label form. It contains no username, password, query, or fragment and does not use an IP-address hostname. Binding retrieval does not follow redirects; any `3xx` response fails verification. It uses a 5-second connection timeout, a 10-second total response deadline, normal TLS hostname and certificate validation, the same per-connection DNS and public-address checks as WebFinger, and sends no credentials, cookies, or referrer information. Cross-origin retrieval receives no ambient authority beyond the URL selected by the address domain.

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
6. Validates the selected `href` and fetches the binding without redirects under the binding retrieval profile.
7. Validates the binding schema.
8. Requires the binding `address` to equal the canonical requested address.
9. Checks `issued_at` and `expires_at` using the allowed clock-skew policy.
10. Resolves the exact `did:plc` DID from the binding through a conforming PLC resolver.
11. Requires `key_id` to be that DID's `#hail-identity` verification method as defined by [did-profile.md](did-profile.md).
12. Verifies the flattened JWS and exact canonical representation under the Address Binding signature profile.
13. Returns the verified DID and binding expiration.

Any mismatch or ambiguity causes address verification to fail.

## Use Of `alsoKnownAs`

Hail v1 publishers must not place Hail addresses in PLC `alsoKnownAs`. Clients ignore any such value and must not treat it as proof of address ownership.

PLC history is permanent and publicly enumerable. Signed, expiring Address Bindings keep both provider-issued and custom-domain address changes out of that permanent history.

## Address Changes

Changing a Hail address does not change the DID.

Example:

```text
alice@provider-a.example.com -> did:plc:aaaaaaaaaaaaaaaaaaaaaaaa
alice@provider-b.example.net -> did:plc:aaaaaaaaaaaaaaaaaaaaaaaa
```

The new address domain publishes a new binding signed by the same DID. Existing grants continue to reference the DID and remain valid.

The old binding may be removed or allowed to expire. If the old address is later reassigned, its new binding must name a different DID. The new address holder does not inherit grants, messages, or reply capabilities belonging to the previous DID.

At any instant, one canonical Hail address has exactly one currently selected Address Binding and therefore names exactly one DID. Hail defines no overlapping transition in which one address verifies for two DIDs. For reassignment, the authority makes the new binding available before replacing the WebFinger link, then removes the old binding after replacement. Each observed WebFinger response still selects only one binding; previously cached results remain usable only through their bounded cache lifetime.

One DID may have multiple simultaneously verified Hail addresses. Each address requires its own WebFinger response and independently signed binding, and changing or losing one address does not affect the others.

One address domain may publish independent bindings for any number of valid local parts. Each WebFinger query is scoped to one complete canonical `acct:` URI and reveals no authority over another local part.

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

- 3600 seconds after successful verification
- the binding's `expires_at` time
- the shorter freshness lifetime of the WebFinger and binding HTTP responses
- any shorter local security policy

An absent explicit HTTP freshness lifetime does not extend the 3600-second maximum. `no-store` prevents caching. Clock tolerance does not extend caching beyond the signed `expires_at`. After the cached lifetime expires, a client must re-run discovery before displaying the address as currently verified; until successful refresh, it displays the address as unverified rather than treating expiration as a protocol revocation.

Changing or expiring an address binding does not revoke grants issued to the DID.

## Security Considerations

### Domain Compromise

If an attacker controls the address domain and an attacker-controlled DID, the attacker can publish and sign a new binding. Address binding cannot eliminate the address domain as the trust anchor for its namespace.

### DID Key Compromise

Compromise of `#hail-identity` allows unauthorized bindings and grants until the key is rotated or revoked through PLC. The identity key is separate from `#hail-messaging` and from PLC rotation keys.

### Binding Replay

Bindings must expire. Verifiers must check current publication through the address domain and must not accept an unexpired binding obtained from an unrelated source as proof that the domain still publishes it.

### Address Reassignment

Applications must key grants, messages, and contacts by DID rather than address. Otherwise, address reassignment could transfer authority or private data.

### Server-Side Request Forgery

WebFinger and binding retrieval use the URL, redirect, DNS rebinding, private-network, timeout, credential-isolation, and response-size protections defined above. The address domain must not be able to direct a verifier to internal network resources.

### Enumeration

WebFinger may reveal whether a Hail address exists. Providers should apply rate limits and should avoid returning unnecessary account metadata.

### Correlation

The current address-to-DID mapping is public by nature. Avoiding `alsoKnownAs` prevents PLC from retaining a permanent address history, but observers may still collect mappings while they are active.

## POC Profile

The proof of concept should implement the same signed binding model rather than an `alsoKnownAs` shortcut.

The POC needs:

- case-insensitive ASCII local parts and IDNA2008 A-label domains
- canonical dot-atom address validation and lowercase serialization
- WebFinger lookup using canonical `acct:` URIs
- exact `https://hailproto.com/rel/address-binding` relation and one Address Binding link
- at most three HTTPS WebFinger redirects and no binding redirects
- delegated cross-origin binding hosting with strict safe-fetch behavior
- one signed binding payload
- `did:plc` resolution
- 90-day maximum binding lifetime, 300-second clock tolerance, and one-hour maximum cache
- RFC 8785 canonical payload, protected header, and flattened JWS wrapper
- RFC 9864 `Ed25519` signature verification using `#hail-identity`
- `application/hail-address-binding+json` with no HTTP content coding
- 16384-byte maximum complete binding representation
- strict fetch limits

The POC uses the v1 discovery, signature, representation, lifetime, caching, and cardinality profiles defined above.
