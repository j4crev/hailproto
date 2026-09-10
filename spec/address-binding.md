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

Hail v0 uses email-shaped addresses but does not adopt SMTP mailbox syntax. An address consists of one ASCII LDH-style local part, one `@`, and one public DNS domain. The local-part labels follow the letter-digit-hyphen character and boundary rules of the preferred Internet hostname syntax in [RFC 1034 section 3.5](https://www.rfc-editor.org/rfc/rfc1034#section-3.5), as relaxed by [RFC 1123 section 2.1](https://www.rfc-editor.org/rfc/rfc1123#section-2.1) to permit an initial digit.

The local-part grammar is:

```abnf
local-part = ldh-label *("." ldh-label)
ldh-label  = let-dig [*(let-dig / "-") let-dig]
let-dig    = ALPHA / DIGIT
```

`ALPHA` accepts uppercase or lowercase ASCII input. Consequently, a local part contains only ASCII letters, digits, hyphens, and label-separating dots. It cannot be empty; begin or end with `.` or `-`; contain consecutive dots; or contain whitespace, controls, non-ASCII characters, or another `@`. Consecutive hyphens are valid. An `xn--` prefix is syntactically valid in a local-part label but has no IDNA meaning in v0. Quoted local parts, comments, display names, route syntax, and domain literals are not Hail addresses. The complete local part is at most 63 ASCII bytes.

The domain accepts Unicode U-label or ASCII A-label input. A verifier applies IDNA2008 lookup processing, rejects invalid or non-round-tripping labels, and emits every label as its lowercase ASCII A-label. A trailing root dot is invalid. Each resulting label is from 1 through 63 bytes, does not begin or end with `-`, and the complete domain is at most 253 ASCII bytes. The domain must have a registrable domain beneath a suffix recognized by the current [Public Suffix List](https://publicsuffix.org/list/); a bare public suffix, unqualified name, address literal, and special-use or unknown suffix are invalid for public Hail federation.

The complete canonical address is at most 254 ASCII bytes. To canonicalize an accepted address, lowercase the ASCII local part, append `@`, and append the lowercase IDNA A-label domain. Clients should canonicalize addresses before submitting them; servers and verifiers must canonicalize accepted input rather than requiring callers to supply lowercase. Hail address comparison is exact bytewise comparison of the canonical form. This deliberately overrides SMTP's theoretical case sensitivity for mailbox local parts.

To construct the RFC 7565 `acct:` URI, prefix the canonical address with `acct:`. The LDH-style local part, delimiter `@`, and canonical A-label domain remain literal. The complete `acct:` URI is then percent-encoded as an RFC 7033 query-parameter value when constructing the WebFinger request.

## Trust Model

An address is verified only when both sides agree:

1. The address domain's authenticated WebFinger JRD selects one Address Binding representation.
2. That representation contains the canonical address and DID and is signed by the DID's authorized `#hail-identity` key.

Conceptually:

```text
address domain --selects--> signed Address Binding representation
DID controller  ----signs----> address + DID payload
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
      "type": "application/cose; cose-type=\"cose-sign1\"",
      "href": "https://example.com/.well-known/hail/addresses/alice"
    }
  ]
}
```

The `rel` request parameter is a response filter, not a guarantee that the returned JRD contains only that relation. A verifier requires the JRD `subject` to exactly equal the canonical `acct:` URI and selects exactly one link whose `rel` equals the Hail relation and whose parsed `type` is equivalent to the Hail COSE media type above. No match or multiple matches fail address verification.

The WebFinger response proves that the address domain selected the binding resource. The binding `href` may use a different origin, allowing delegated providers and CDNs, but the client must first obtain that URL from the address domain's authenticated WebFinger response.

### WebFinger Retrieval

A verifier sends the WebFinger request to the canonical address domain over HTTPS. It may follow at most three WebFinger redirects, as permitted by RFC 7033. Every redirect target must use HTTPS, contain a public ASCII DNS hostname in canonical IDNA A-label form, contain no username, password, or fragment, and pass the network-address checks below. The verifier follows the supplied `Location` URI rather than reconstructing or appending query parameters.

The complete redirect chain shares a 10-second response deadline, with a 5-second connection timeout for each connection. Every TLS connection requires normal hostname and certificate validation. Every DNS result and connection address is checked to reject IP-address hostnames, loopback, link-local, private, reserved, or otherwise non-public addresses and to prevent DNS rebinding. Requests send no `Authorization`, `Cookie`, or `Referer` fields and use `Accept-Encoding: identity`.

The final WebFinger response must be `200 OK` with exact parameterless `Content-Type: application/jrd+json` and no `Content-Encoding`. The transmitted JRD is limited to 65536 bytes, must be valid UTF-8 JSON with one top-level object, and must not contain duplicate member names. Unknown JRD members and unrelated links are ignored as required by RFC 7033.

## Binding Payload

Diagnostic JSON rendering of the Address Binding payload map. The embedded wire payload is deterministic Hail CBOR; this JSON rendering is neither signed nor accepted as a federation representation, and its displayed member order has no canonical significance:

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

The payload map is deterministically CBOR-encoded and embedded as the payload byte string of one tagged COSE_Sign1 structure. The protected headers, embedded payload bytes, and signature are validated under the profile below.

Required members of the closed Address Binding payload map:

- `version`: Address Binding profile version.
- `type`: Exact value `hail.address-binding` for v0.
- `address`: Canonical Hail address without the `acct:` prefix.
- `did`: Canonical `did:plc` identifier associated with the address, as defined by the Hail DID profile.
- `issued_at`: UTC issuance time represented as Unix seconds.
- `expires_at`: UTC expiration time represented as Unix seconds.
- `key_id`: DID URL identifying the DID's `#hail-identity` verification method.

The payload is a closed Hail map; unknown map members are rejected in v0.

`issued_at` and `expires_at` are non-negative integers. `expires_at` must be greater than `issued_at`, and their difference must not exceed 7776000 seconds, or 90 days. At verification time, `issued_at` must not be more than 300 seconds in the future and current time must not be more than 300 seconds after `expires_at`. Clock tolerance does not alter either signed timestamp or extend the cache lifetime below.

## Signature And Representation Profile

Hail Address Binding v0 uses the deterministic CBOR and tagged COSE_Sign1 profile in [encoding.md](encoding.md), with protected content type `application/hail-address-binding+cbor` and the `#hail-identity` key role. The protected `kid` is the UTF-8 encoding of payload `key_id`. The complete signed representation bytes are immutable evidence. A verifier parses and validates them as required, but retains and hashes the originally received bytes rather than a reserialized copy.

## Retrieval Representation And Limits

The WebFinger link's `type` hint and the binding HTTP response's `Content-Type` identify the outer signed representation as:

```text
application/cose; cose-type="cose-sign1"
```

The response content is exactly one tagged COSE_Sign1 representation whose protected content-type header is the exact text string `application/hail-address-binding+cbor`. A verifier sends `Accept: application/cose; cose-type="cose-sign1"` and `Accept-Encoding: identity`. A successful retrieval must be `200 OK`, must have an equivalent parsed outer `Content-Type` under [encoding.md](encoding.md), and must have no `Content-Encoding`. A verifier rejects another success status, a different parsed media type, or any HTTP content coding. The WebFinger link `type` is compared using those same outer media-type rules.

A conforming publisher produces, and a conforming verifier accepts, complete valid Address Binding COSE representations up to and including 16384 octets. A verifier rejects response content larger than 16384 octets before CBOR or COSE decoding. The WebFinger JRD has its separate 65536-byte transmitted-content limit.

The binding `href` must be an absolute HTTPS URL with a public ASCII DNS hostname in canonical IDNA A-label form. It contains no username, password, query, or fragment and does not use an IP-address hostname. Binding retrieval does not follow redirects; any `3xx` response fails verification. It uses a 5-second connection timeout, a 10-second total response deadline, normal TLS hostname and certificate validation, the same per-connection DNS and public-address checks as WebFinger, and sends no credentials, cookies, or referrer information. Cross-origin retrieval receives no ambient authority beyond the URL selected by the address domain.

## Binding Representation Digest

The Address Binding representation digest is SHA-256 over the exact complete tagged deterministic COSE_Sign1 representation bytes. In a grant's `consent_context.address_binding_hash`, `algorithm` is `sha-256` and `value` is this digest as a 32-byte CBOR byte string. Diagnostic JSON renders `value` as exactly 43 unpadded base64url characters.

Every grant's required `consent_context` records the verified address and commits to the exact Address Binding representation through `address_binding_hash`. The recipient separately retains the exact Address Binding COSE representation and its DID-resolution verification evidence for as long as it retains the corresponding grant revision or consent evidence, subject to the historical DID evidence rules still to be finalized. Given the retained representation, the digest commits to the protected `kid`, embedded payload bytes, signature, and all other bytes in the complete tagged COSE_Sign1 representation.

## Verification Algorithm

Given a user-supplied Hail address, a verifier:

1. Normalizes the address according to the Hail address profile.
2. Constructs its canonical `acct:` URI.
3. Performs WebFinger discovery against the address domain over HTTPS.
4. Requires the WebFinger `subject` to equal the canonical `acct:` URI.
5. Selects exactly one supported Hail Address Binding link.
6. Validates the selected `href` and fetches the binding without redirects under the binding retrieval profile.
7. Enforces the representation-size limit, performs bounded CBOR and COSE decoding, and requires the exact tagged deterministic COSE_Sign1 structure and protected-header profile.
8. Requires the embedded payload to be one exact deterministic encoding of the closed Address Binding payload map and validates its schema.
9. Requires payload `address` to equal the canonical requested address.
10. Checks `issued_at` and `expires_at` using the allowed clock-skew policy.
11. Resolves the exact payload `did` through a conforming PLC resolver.
12. Requires payload `key_id` and protected `kid` to identify that DID's `#hail-identity` verification method as defined by [did-profile.md](did-profile.md).
13. Verifies the COSE signature under the Address Binding signature profile.
14. Returns the verified DID and binding expiration.

Any mismatch or ambiguity causes address verification to fail.

## Use Of `alsoKnownAs`

Hail v0 publishers must not place Hail addresses in PLC `alsoKnownAs`. Clients ignore any such value and must not treat it as proof of address ownership.

PLC history is permanent and publicly enumerable. Signed, expiring Address Bindings keep both provider-issued and custom-domain address changes out of that permanent history.

## Publisher Activation

An address reservation is provider-private state and supplies no Hail authority. Before publishing an Address Binding, the publisher requires the named DID to have valid, non-tombstoned PLC state resolvable with the exact `#hail-identity`, `#hail-messaging`, and `#hail` entries expected for the account.

The publisher makes the immutable signed binding representation retrievable at its final HTTPS URL before publishing the WebFinger response that selects it. It then performs this document's complete verification algorithm from the public address through the binding to the DID. A provider activates the account for Hail federation only after that verification and separate confirmation of its own exact Hail service endpoint and messaging key succeed.

If activation fails after WebFinger begins selecting the binding, the address authority removes that selection or repairs it before retrying. Before assigning the address to another account, it waits until the earlier of 300 seconds after the prior binding's `expires_at` and 3600 seconds after WebFinger withdrawal, so no conforming cached discovery result can verify the prior binding. New-account sequencing and partial-failure behavior are defined in [account-onboarding.md](account-onboarding.md).

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
- canonical LDH-style address validation and lowercase serialization
- WebFinger lookup using canonical `acct:` URIs
- exact `https://hailproto.com/rel/address-binding` relation and one Address Binding link
- at most three HTTPS WebFinger redirects and no binding redirects
- delegated cross-origin binding hosting with strict safe-fetch behavior
- one closed Address Binding payload map embedded in one complete tagged COSE_Sign1 representation
- `did:plc` resolution
- 90-day maximum binding lifetime, 300-second clock tolerance, and one-hour maximum cache
- deterministic Hail CBOR and tagged COSE_Sign1
- RFC 9864 COSE `Ed25519` (`-19`) signature verification using `#hail-identity`
- `application/cose; cose-type="cose-sign1"` with protected content type `application/hail-address-binding+cbor` and no HTTP content coding
- 16384-byte maximum complete binding representation
- strict fetch limits

The POC uses the v0 discovery, signature, representation, lifetime, caching, and cardinality profiles defined above.
