# Hail Address Binding

Status: Draft

This document defines how a human-readable Hail address is associated with a durable DID.

Hail addresses are aliases. Hail Grants, Hail Envelopes, and durable relationships use DIDs.

## Goals

- Resolve a human-readable address to a DID.
- Require agreement from both the address domain and DID controller.
- Bind either a provider-issued or custom-domain address to a `did:plc` identity.
- Avoid permanently publishing Hail address history in a PLC operation log.
- Allow an address publication to be withdrawn or replaced without changing the DID.
- Keep a continuing address usable without periodic binding renewal.
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
- **Address binding**: A signed statement associating one canonical Hail address with one DID. Its current use requires publication by the address authority and verification with the DID’s current identity key; it has no expiration timestamp.
- **Address authority**: The address domain, publishing mappings through its own authenticated HTTPS endpoint or a DNS-delegated WebFinger provider.
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

1. The address domain selects a WebFinger authority through DNS delegation below, or its own authenticated HTTPS endpoint when delegation is absent. That authority's authenticated WebFinger JRD selects one Address Binding representation.
2. That representation contains the canonical address and DID and verifies under the DID’s current authorized `#hail-identity` key.

Conceptually:

```text
address domain --selects--> signed Address Binding representation
DID controller  ----signs----> address + DID payload
```

Neither statement is sufficient by itself.

A DID can claim an address it does not own, and a domain can point an address at a DID whose controller did not agree. Verification succeeds only when the published and signed values match and the signature verifies with the current identity key. The signature records consent to the signed association; it does not prove a new owner action at each lookup.

Because every Hail identity uses PLC, the address domain and PLC rotation authority are separate trust anchors. Domain control alone cannot rotate the named DID's keys or service, and PLC control alone cannot publish the domain's WebFinger mapping. A compromised domain can redirect the address to another DID, but it cannot inherit grants or message history bound to the original DID.

This profile trusts providers to cooperate with account closure, address withdrawal, and migration. It does not introduce an independently verifiable owner revocation list or a periodic proof of renewed owner consent. A noncooperating address authority can continue publishing or republish an old signed binding while its identity key remains current. Removing publication ends discovery through a cooperating provider; it does not cryptographically invalidate previously distributed signed bytes. This trust boundary applies to both managed and owner-controlled accounts.

## Discovery

### DNS Provider Delegation

Before constructing the WebFinger endpoint, query TXT records at
`_hail-provider.<canonical-address-domain>`. A domain can delegate all its Hail
local parts without operating an HTTPS server:

```dns
_hail-provider.j4crev.com. TXT "v=hail1; provider=haili.app"
```

A provider resolving its own exact, locally configured native address domain may
skip this TXT lookup and use that domain's HTTPS WebFinger endpoint directly.
This exception comes from provider configuration, never from the input address,
a suffix match, or a previously hosted custom-domain registration. Remote domains,
native-domain subdomains, and hosted custom domains still require DNS discovery.
Explicit domain registration and delegation checks must always query DNS.
All HTTPS, binding, and DID verification requirements remain in force; ordinary
A/AAAA resolution for HTTPS is not bypassed. Remote resolvers still use the
published delegation, so operators must keep it consistent with native hosting.

Concatenate character strings within each TXT RR, never across RRs. The RRset
must contain exactly one record with the exact grammar
`v=hail1; provider=<hostname>`, at most 512 UTF-8 bytes. The hostname must be a
lowercase canonical ASCII A-label public DNS domain accepted by Hail's address
domain rules. Reject URLs, ports, paths, address literals, unknown versions,
additional fields, and multiple records. These are Hail draft conventions, not
registered WebFinger discovery extensions.

For valid delegation, request `https://<hostname>/.well-known/webfinger`, retaining
the original address in `resource` and requiring that original JRD subject. Do not
recursively query the provider's `_hail-provider` record. Existing HTTPS redirect,
public-network, signature, representation, and exact address/DID checks apply.
The DID's Hail service need not share the discovery provider's hostname.

Only DNS absence (NXDOMAIN or NOERROR/NODATA) permits the domain-hosted WebFinger
path below. DNS timeouts, SERVFAIL, malformed or ambiguous records, and failure
of an advertised provider fail discovery without fallback. DNS and HTTP retrievals
share the existing 10-second response deadline.

The initial profile accepts unsigned DNS through the configured recursive
resolver. Operators should use a DNSSEC-validating resolver; bogus DNSSEC must
not be treated as absence. Hail does not itself validate DNSSEC. HTTPS authenticates
the selected provider, not the original DNS delegation. DNS-response integrity
is therefore an additional trust dependency: tampering can substitute an
attacker's DID but cannot transfer the original DID's keys, history, or grants.

Delegated discovery caches must additionally expire at the remaining DNS TTL of
the delegation and any DNS aliases used to obtain it. Implementations without
those TTLs must not application-cache delegated verification results. Recursive
DNS caching remains permitted. No periodic polling or per-message DNS check is
required.

Upgrade resolvers before advertising DNS-only addresses: older WebFinger-only
implementations cannot discover them. DNS delegation does not itself alter signed
message formats. This alpha profile requires Address Binding version 2; version 1
bindings are rejected rather than supported alongside it. Provider-private registration challenges such as
`_hail-domain-verify.<domain> TXT "hail-domain-verify=<random-token>"` authorize
registration at a provider; they do not replace public delegation.

### WebFinger Request

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

The WebFinger response selects the binding resource under the authority established above. The binding `href` may use a different origin, allowing providers and CDNs, but the client must first obtain that URL from the selected authority's authenticated WebFinger response.

### WebFinger Retrieval

A verifier sends the WebFinger request to the DNS-selected provider, or the canonical address domain when delegation is absent, over HTTPS. It may follow at most three WebFinger redirects, as permitted by RFC 7033. Every redirect target must use HTTPS, contain a public ASCII DNS hostname in canonical IDNA A-label form, contain no username, password, or fragment, and pass the network-address checks below. The verifier follows the supplied `Location` URI rather than reconstructing or appending query parameters.

The complete redirect chain shares a 10-second response deadline, with a 5-second connection timeout for each connection. Every TLS connection requires normal hostname and certificate validation. Every DNS result and connection address is checked to reject IP-address hostnames, loopback, link-local, private, reserved, or otherwise non-public addresses and to prevent DNS rebinding. Requests send no `Authorization`, `Cookie`, or `Referer` fields and use `Accept-Encoding: identity`.

The final WebFinger response must be `200 OK` with exact parameterless `Content-Type: application/jrd+json` and no `Content-Encoding`. The transmitted JRD is limited to 65536 bytes, must be valid UTF-8 JSON with one top-level object, and must not contain duplicate member names. Unknown JRD members and unrelated links are ignored as required by RFC 7033.

## Binding Payload

Diagnostic JSON rendering of the Address Binding payload map. The embedded wire payload is deterministic Hail CBOR; this JSON rendering is neither signed nor accepted as a federation representation, and its displayed member order has no canonical significance:

```json
{
  "version": 2,
  "type": "hail.address-binding",
  "address": "alice@example.com",
  "did": "did:plc:aaaaaaaaaaaaaaaaaaaaaaaa",
  "issued_at": 1787851200,
  "key_id": "did:plc:aaaaaaaaaaaaaaaaaaaaaaaa#hail-identity"
}
```

The payload map is deterministically CBOR-encoded and embedded as the payload byte string of one tagged COSE_Sign1 structure. The protected headers, embedded payload bytes, and signature are validated under the profile below.

Required members of the closed Address Binding payload map:

- `version`: Exact integer value `2`. Version 1 and all other versions are rejected.
- `type`: Exact value `hail.address-binding` for v0.
- `address`: Canonical Hail address without the `acct:` prefix.
- `did`: Canonical `did:plc` identifier associated with the address, as defined by the Hail DID profile.
- `issued_at`: UTC issuance time represented as Unix seconds.
- `key_id`: DID URL identifying the DID's `#hail-identity` verification method.

The payload is a closed Hail map containing exactly the six required members above. Unknown members, including `expires_at`, are rejected. This is an intentional alpha wire-format break; there is no version-1 compatibility path.

`issued_at` is a non-negative integer. At verification time it must not be more than 300 seconds in the future. A binding has no maximum age or expiration timestamp and requires no periodic renewal. Its issuance time does not make a cached discovery result current; the cache and revalidation rules below still apply. Expiration rules for grants, invitations, and transfer approvals are independent and remain in force.

## Signature And Representation Profile

Hail Address Binding version 2 uses the deterministic CBOR and tagged COSE_Sign1 profile in [encoding.md](encoding.md), with protected content type `application/hail-address-binding+cbor` and the `#hail-identity` key role. The protected `kid` is the UTF-8 encoding of payload `key_id`. The complete signed representation bytes are immutable evidence. A verifier parses and validates them as required, but retains and hashes the originally received bytes rather than a reserialized copy.

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
3. Resolves DNS provider delegation and performs WebFinger discovery against the selected authority over HTTPS.
4. Requires the WebFinger `subject` to equal the canonical `acct:` URI.
5. Selects exactly one supported Hail Address Binding link.
6. Validates the selected `href` and fetches the binding without redirects under the binding retrieval profile.
7. Enforces the representation-size limit, performs bounded CBOR and COSE decoding, and requires the exact tagged deterministic COSE_Sign1 structure and protected-header profile.
8. Requires the embedded payload to be one exact deterministic encoding of the closed Address Binding payload map and validates its schema.
9. Requires payload `address` to equal the canonical requested address.
10. Requires `issued_at` to be no more than 300 seconds in the future; no age-based expiration check applies.
11. Resolves the exact payload `did` through a conforming PLC resolver to obtain current validated Hail state, rejecting unavailable, invalid, or tombstoned state.
12. Requires payload `key_id` and protected `kid` to identify that DID's `#hail-identity` verification method as defined by [did-profile.md](did-profile.md).
13. Verifies the COSE signature under the Address Binding signature profile.
14. Returns the verified DID, exact binding representation, verification evidence, and verification time. Any cached result is bounded by the rules below.

Any mismatch or ambiguity causes address verification to fail.

## Use Of `alsoKnownAs`

Every regular PLC operation contains an `alsoKnownAs` array, but the array may be empty. A newly created Hail identity uses an empty array. Every Hail-constructed update to an existing DID preserves all non-Hail aliases in their existing order unless the DID controller explicitly authorizes an alias change in the exact signed full-state operation. Hail v0 publishers must not add a Hail address to `alsoKnownAs` in `acct:`, hypothetical `hail:` or `hail://`, or any other form. Hail v0 defines no `hail:` URI scheme.

Clients ignore any `alsoKnownAs` value for Hail discovery and must not treat it as proof of address ownership. The field is a unilateral DID-controller assertion: the PLC directory does not verify it against the named domain, it may become stale after address reassignment, and every prior value remains public in PLC history. It also cannot represent a trustworthy primary address because one DID may have multiple Hail addresses.

WebFinger authenticated under the selected discovery authority plus the signed Address Binding verified with the current PLC identity key supplies the two-sided check, subject to the DNS trust dependency and cooperative lifecycle trust described above. Current publication is checked through discovery; no `alsoKnownAs` membership check is performed. Keeping Hail addresses out of PLC avoids a permanent address history while preserving address changes and multiple-address support. A future reverse-discovery mechanism would need an explicit trust, privacy, staleness, and primary-address model rather than assigning semantics to `alsoKnownAs` retroactively.

## Publisher Activation

An address reservation is provider-private state and supplies no Hail authority. Before publishing an Address Binding, the publisher requires the named DID to have valid, non-tombstoned PLC state resolvable with the exact `#hail-identity`, `#hail-messaging`, and `#hail` entries expected for the account.

During a user-initiated provider transfer, the user selects the destination
address **directly at the new Hail server**, after its inactive Transfer Offer
and before the source freezes the account. That server's provider domain is
the selected address domain, whether self-hosted or third-party. It verifies
the signed Address Selection against the original user grant and Offer and
reserves the address locally, but does **not** publish a binding or WebFinger
selection while the current PLC service still names the old provider. After
the exact user-signed PLC cutover is validated, publication and external
verification follow the normal sequence below. A reservation receipt by
itself does not establish a publicly verified Hail address.

The publisher makes the immutable signed binding representation retrievable at its final HTTPS URL before publishing the WebFinger response that selects it. It then performs this document's complete verification algorithm from the public address through the binding to the DID. A provider activates the account for Hail federation only after that verification and separate confirmation of its own exact Hail service endpoint and messaging key succeed.

If activation fails after WebFinger begins selecting the binding, the address authority withdraws the selection and its publicly served binding artifacts, or repairs the same activation before retrying. Before assigning the address to another DID, it waits at least 3600 seconds after withdrawal of both the WebFinger mapping and the prior public binding artifacts, so no conforming cached discovery result remains current. New-account sequencing and partial-failure behavior are defined in [account-onboarding.md](account-onboarding.md).

## Address Changes

Changing a Hail address does not change the DID.

Example:

```text
alice@provider-a.example.com -> did:plc:aaaaaaaaaaaaaaaaaaaaaaaa
alice@provider-b.example.net -> did:plc:aaaaaaaaaaaaaaaaaaaaaaaa
```

The new address domain publishes a new binding signed by the same DID. Existing grants continue to reference the DID and remain valid.

When the old address is relinquished, its provider must withdraw the WebFinger mapping and stop publicly serving the corresponding COSE binding artifacts. It must not wait for expiry: version 2 has none. If the old address is later reassigned, its new binding must name a different DID. The new address holder does not inherit grants, messages, or reply capabilities belonging to the previous DID.

At any instant, one canonical Hail address has at most one currently selected Address Binding and therefore names at most one DID. For reassignment to a different DID, the authority first withdraws the old mapping and public binding artifacts, waits out the 3600-second cache bound, then publishes the new artifact followed by its WebFinger selection. During that withdrawal interval the address is unavailable for new discovery. Replacing a binding for the same address and DID does not transfer address ownership; each observed WebFinger response still selects only one binding.

One DID may have multiple simultaneously verified Hail addresses. Each address requires its own WebFinger response and independently signed binding, and changing or losing one address does not affect the others.

One address domain may publish independent bindings for any number of valid local parts. Each WebFinger query is scoped to one complete canonical `acct:` URI and reveals no authority over another local part.

### Lifecycle Withdrawal

Ordinary account deletion and successful source migration retirement must trigger withdrawal at the provider as part of their durable lifecycle transition. The provider must stop selecting the account’s departing address in WebFinger and stop serving its associated public COSE binding URLs, including old URLs that may have been retained by a resolver. A compliant public discovery endpoint returns an unavailable response, such as `404`, for those withdrawn mappings and artifacts. A failed or ambiguous migration must follow the coordinated transfer rules; it must not silently retire the source before the destination has safely taken over.

Withdrawal is a change to public availability, not permission to erase signed audit evidence. Providers retain required binding bytes, digests, and historical verification evidence privately under the relevant retention policy. Account deletion or migration does not erase PLC history or automatically tombstone a DID. A separate `binding revoke` command is not required: the account and transfer workflows own this behavior. Other addresses independently authorized for the same DID are unaffected.

Withdrawal does not prove that a hostile provider deleted all copies or could never republish a still-verifiable signature. Clients rely on provider cooperation for this lifecycle guarantee, while verifying current discovery and DID state on refresh.


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
- the shorter freshness lifetime of the WebFinger and binding HTTP responses
- the remaining TTL of DNS delegation and aliases, when delegation is used
- any shorter freshness bound imposed by the PLC resolution policy
- any shorter local security policy

An absent explicit HTTP freshness lifetime does not extend the 3600-second maximum. `no-store` prevents caching. Without available delegation TTLs, delegated verification results must not be application-cached. After the cached lifetime expires, a client must re-run DNS/WebFinger and binding discovery and revalidate current PLC authority before displaying the address as currently verified. Until successful refresh, it displays the address as unverified. A reusable signed artifact is not permission to extend a verification cache indefinitely or to fall back to stale PLC state.

Changing or withdrawing an address publication does not revoke grants issued to the DID.

## Security Considerations

### Domain Compromise

If an attacker controls the address domain and an attacker-controlled DID, the attacker can publish and sign a new binding. Address binding cannot eliminate the address domain as the trust anchor for its namespace.

### DID Key Compromise

Compromise of `#hail-identity` allows unauthorized bindings and grants until the key is rotated or revoked through PLC. The identity key is separate from `#hail-messaging` and from PLC rotation keys.

### Binding Replay

Bindings do not expire. Verifiers must check current publication through the address authority and current PLC identity-key authorization; a signed binding obtained from an unrelated source or private audit store is not proof of current publication. Bounded caches limit how long compliant resolvers can retain a withdrawn mapping. They do not prevent a noncooperating authority from republishing an old binding whose identity key remains current. This profile deliberately relies on cooperative provider withdrawal rather than cryptographic per-address revocation or periodic owner signatures.

### Address Reassignment

Applications must key grants, messages, and contacts by DID rather than address. Otherwise, address reassignment could transfer authority or private data.

### Server-Side Request Forgery

WebFinger and binding retrieval use the URL, redirect, DNS rebinding, private-network, timeout, credential-isolation, and response-size protections defined above. The address domain must not be able to direct a verifier to internal network resources.

### Enumeration

A successful complete Hail discovery intentionally reveals that the canonical address currently has a Hail mapping, including the verified signed Address Binding and DID, after which an observer can resolve that DID's public PLC keys and current Hail service. A successful WebFinger response alone selects a binding URL; binding retrieval, validation, and DID resolution can still fail. Implementations must not treat difficulty of enumeration as an authorization or confidentiality boundary.

Providers should rate-limit discovery and must avoid returning unrelated account metadata to reduce bulk harvesting and operational abuse. Hail v0 defines no address-listing or reverse-DID-to-address operation. A failed lookup is not authoritative proof that an address does not exist because throttling, outage, withdrawal, or validation failure can also prevent verified resolution.

Although the mapping is public, the WebFinger and binding hosts can observe requester network information, lookup timing, and the queried address. The retrieval profile sends no credentials, cookies, or referrer information to limit ambient-identity leakage. Providers should minimize discovery logs and retention consistent with abuse prevention.

### Correlation

The current address-to-DID mapping is public and may be collected and archived while active. Avoiding `alsoKnownAs` prevents a mandatory permanent PLC address history and PLC-based reverse correlation; it does not make an active Address Binding confidential or prevent observers from retaining it.

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
- version-2 bindings without `expires_at`, with a 300-second future-issuance tolerance
- one-hour maximum discovery cache, further bounded by HTTP, DNS, and PLC freshness
- lifecycle withdrawal of both WebFinger mappings and public COSE artifacts
- deterministic Hail CBOR and tagged COSE_Sign1
- RFC 9864 COSE `Ed25519` (`-19`) signature verification using `#hail-identity`
- `application/cose; cose-type="cose-sign1"` with protected content type `application/hail-address-binding+cbor` and no HTTP content coding
- 16384-byte maximum complete binding representation
- strict fetch limits

The POC uses the discovery, version-2 signature and representation, lifecycle withdrawal, caching, and cardinality profiles defined above. It does not accept version-1 bindings or implement periodic binding renewal.
