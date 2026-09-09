# Hail Deterministic CBOR Migration

Status: Active design migration

This document coordinates the pre-implementation migration of Hail-owned wire objects from canonical JSON and JWS to deterministic CBOR and COSE. It is a work plan, not the normative encoding definition. Normative requirements belong in [spec/encoding.md](spec/encoding.md) and the object specifications.

## Goals

- Use one compact, deterministic representation for federation, signing, hashing, and durable protocol evidence.
- Keep the logical data model approachable from ordinary JSON-shaped language values.
- Hide CBOR and COSE mechanics behind schemas, generated types, and shared codecs for application developers.
- Preserve Hail's authorization, privacy, delivery, replay, and identity semantics.
- Reuse sound AT Protocol and DRISL design constraints without creating an AT Protocol interoperability requirement.
- Complete the representation change before any public v0 implementation creates persistent signed objects.

## Non-Goals

- Hail objects are not AT Protocol records and do not need Lexicon, CIDs, CAR files, or Merkle repositories.
- The migration does not convert WebFinger JRD, rendered DID documents, RFC 9457 Problem Details, or generic HTTP receipts from JSON.
- The migration does not add JSON/CBOR federation negotiation or a legacy JWS fallback.
- The migration does not add zstd, bulk delivery, end-to-end encryption, or a new body vocabulary.
- The migration does not use integer application-map labels solely to reduce size.

## Target Architecture

Hail v0 has three deliberately separate layers:

1. The Hail Data Model defines null, booleans, bounded integers, UTF-8 text, bytes, arrays, and text-keyed maps.
2. Deterministic Hail CBOR is the sole authoritative encoding of Hail-owned payloads and bodies.
3. Diagnostic JSON is a non-authoritative projection for examples, tools, local APIs, and application development.

Signed Hail objects use tagged COSE_Sign1 with embedded deterministic-CBOR payloads. Hail application maps retain descriptive text keys. Digests, signatures, and bearer-token entropy use native byte strings inside CBOR and explicit textual encodings at HTTP boundaries.

The client-to-provider API remains outside the federation specification. Providers may expose JSON, GraphQL, native SDK models, or another local interface. A client application should not need to construct CBOR or COSE directly.

## Fixed v0 Decisions

| Area | Decision |
| --- | --- |
| Logical model | JSON-shaped constrained Hail Data Model |
| Wire encoding | Deterministic CBOR under `spec/encoding.md` |
| Map keys | UTF-8 text strings |
| Floating point | Prohibited |
| Integers | Schema-bounded; interoperable values do not exceed `2^53 - 1` |
| Binary values | Native CBOR byte strings |
| Signed wrapper | Tagged COSE_Sign1 with embedded payload |
| Signature algorithm | RFC 9864 fully specified COSE `Ed25519` (`-19`) |
| Protected headers | `alg`, `content type`, and `kid` only |
| Unprotected headers | Empty map |
| External AAD | Empty byte string |
| Hash algorithm | SHA-256 |
| Signed-object HTTP type | `application/cose; cose-type="cose-sign1"` |
| Body HTTP type | `application/hail-body+cbor` |
| Signed-object compression | None |
| Detached body compression | Identity or gzip |
| Federation alternatives | No JSON/JWS fallback or negotiation in v0 |

The older JSON/JWS text in repository history describes an unimplemented draft and is not a deployed Hail version.

## Representation Boundaries

| Value | Hail CBOR | HTTP or diagnostic text |
| --- | --- | --- |
| SHA-256 digest | Exactly 32-byte byte string | Unpadded base64url in URL segments, ETags, and diagnostic JSON |
| Bearer token | Exactly 32-byte byte string | Unpadded base64url after `Authorization: Bearer` |
| Ed25519 signature | Exactly 64-byte COSE signature byte string | Not separately rendered on the wire |
| COSE `kid` | UTF-8 bytes of the absolute DID URL | DID URL text when displayed |
| UUIDv7 | Canonical lowercase text | Same literal text |
| `Content-Digest` | SHA-256 of HTTP message content, including content coding | RFC 9530 structured-field byte sequence using standard base64 |

The codec must never infer that an arbitrary text string is base64. Binary conversion is determined by the schema and boundary.

## Digest Domains

| Digest | Exact input |
| --- | --- |
| Address Binding representation digest | Complete tagged deterministic COSE_Sign1 bytes |
| Sender Profile representation digest | Complete tagged deterministic COSE_Sign1 bytes |
| Grant revision digest, `previous`, and ETag | Complete tagged deterministic COSE_Sign1 bytes |
| Envelope payload and replay digest | Embedded deterministic envelope payload bytes, excluding COSE |
| Delivery-status `envelope_digest` | Same envelope payload bytes used by replay handling |
| Body content digest | Exact uncompressed deterministic body CBOR bytes |

These domains remain intentionally distinct. Evidence and grant-lineage digests bind signer metadata and signatures; envelope and body digests identify payload content.

## Work Phases

### 1. Foundation

- Add the normative Hail Data Model, deterministic encoding, diagnostic JSON, COSE, media-type, boundary-conversion, and digest-domain rules.
- Define one vocabulary for deterministic payload bytes and complete signed representation bytes.
- State that v0 has one mandatory representation.

### 2. Signed Objects

- Convert Address Binding, Sender Profile, Grant, Envelope, and Delivery Status payload schemas to closed Hail CBOR maps.
- Replace every JWS wrapper and signing procedure with the shared COSE_Sign1 profile.
- Give every object an exact protected content type.
- Preserve payload `type`, payload `key_id`, DID controller checks, and identity-versus-messaging key roles.
- Define key-rotation behavior wherever complete signed representation bytes participate in lineage, ETags, or retained evidence.

### 3. Binary Fields And Digests

- Convert payload digest values, predecessor values, consent hashes, and bearer tokens to byte strings.
- Preserve unpadded base64url only where HTTP syntax requires text.
- Update grant lineage, ETags, replay records, delivery correlation, and retained evidence to their exact new domains.

### 4. Bodies

- Encode `spt-1` bodies as deterministic Hail CBOR.
- Keep JSON-shaped authoring and diagnostic examples explicitly non-wire.
- Hash and size the exact uncompressed deterministic bytes.
- Preserve identity/gzip transfer coding and bounded decompression.
- Finalize structural decoder limits before production interoperability.

### 5. HTTP Binding

- Use the exact signed-object and body media types.
- Keep WebFinger JRD, Problem Details, and generic receipts in JSON.
- Update safe transport errors and protected malformed-object behavior from JSON/JWS to CBOR/COSE.
- Preserve privacy timing, retry, redirect, conditional request, and acknowledgement semantics.
- Finalize or register every provisional Hail `+cbor` media type before stable v0 publication.

### 6. Developer Tooling

- Publish CDDL for every payload and body profile.
- Provide a reference deterministic encoder, strict decoder, COSE signer, and verifier.
- Generate models and validators for initial implementation languages.
- Provide a diagnostic JSON converter and a CBOR diagnostic-notation command.
- Ensure high-level SDK calls do not expose canonicalization or COSE construction.

Implementation status:

- TypeScript is the reference and first application language.
- The repository uses Bun workspaces, supports Node.js 24 and newer, and tests with Vitest.
- `packages/hail-codec-ts` implements strict deterministic CBOR, typed v0 payload models, structural and semantic validators, tagged COSE_Sign1 signing and verification, Web Crypto adapters, schema-aware diagnostic JSON, and a disclosure-safe inspection CLI.
- Decoder-side structural scanning enforces byte, nesting, item, collection, text, and byte-string limits before general CBOR decoding. Signed COSE structures and protected headers receive the same pre-decode treatment.
- Inspected and cryptographically verified values have distinct public types; only successful verification returns the nominally branded `VerifiedHailObject`.
- Address validation applies non-transitional UTS #46 checks and the current ICANN public suffix list. Protocol contexts that permit special-use domains remain future explicit policy inputs rather than implicit exceptions.
- `cborg` is the selected CBOR primitive; Hail layers constrained-model validation and mandatory decode/re-encode equality over it. A generic TypeScript COSE dependency was not selected because the evaluated package identifies itself as unstable and does not replace Hail's exact profile checks.
- Diagnostic JSON file encoding is intentionally absent until a duplicate-member-aware, lossless parser is selected. The typed conversion API remains available for already-parsed, schema-validated values.
- The test suite compiles `spec/hail.cddl` with a pinned, development-only validator and checks raw positive vectors, structural mutation boundaries, payload registries, and the intentional boundary between CDDL structure and stricter semantic validation.
- The CLI renders validated payloads as deterministic-key-ordered CBOR diagnostic notation with bearer-token redaction by default.
- Remaining Phase 6 work includes stabilizing production resource limits and expanding API documentation.

### 7. Conformance And Performance

- Publish exact hexadecimal payload and complete COSE vectors for every signed object.
- Cover duplicate keys, non-shortest integers, wrong map order, indefinite lengths, tags, floats, invalid UTF-8, null versus absent, trailing data, and nesting/allocation limits.
- Cover signatures, every digest domain, byte-string/text confusion, HTTP conversion, and key-role failures.
- Benchmark encoded size, encode/decode time, allocations, signing/verification, body compression, and complete delivery paths against the former JSON/JWS draft.
- Treat end-to-end measurements as authoritative; DID resolution, storage, and network costs are not codec improvements.

Implementation status:

- `packages/hail-codec-ts/vectors/v0.json` publishes deterministic payload vectors for all six payload families and complete COSE_Sign1 vectors for all five signed families using explicitly public test-only Ed25519 seeds.
- The manifest links every v0 digest domain across its source and target object, includes exact Sig_structure bytes, and publishes SHA-256, base64url, URL-segment, ETag, bearer-token, and `Content-Digest` boundary values plus malformed CBOR, payload, and COSE vectors.
- The conformance suite reads checked-in vectors independently and compares exact encoding, deterministic signatures, independent signature verification, cross-object digest domains, boundary conversions, and reference-codec error classifications.
- The independent Go codec consumes the same checked-in vectors and verifies exact payload encoding, COSE signing and verification, Sig_structure bytes, digest links, boundary conversions, malformed-input rejection, and mutation/resource safety without importing TypeScript implementation code.
- Repeatable Tinybench and Go `benchmem` harnesses measure matching payload and complete envelope COSE workloads; a deterministic report records CBOR, compact diagnostic JSON, gzip-CBOR, and COSE sizes. Historical JSON/JWS results are not claimed because no authoritative former wire vectors were retained.
- Remaining Phase 7 work includes end-to-end measurements from the two-server prototype and any broader vectors discovered during that implementation.

## Completion Criteria

The migration is complete when:

- No Hail-owned v0 signed object normatively depends on JSON, JCS, JWS, or I-JSON.
- No Hail Body normatively uses JSON as its federation encoding.
- Every binary field has one schema type and one explicit HTTP/diagnostic conversion.
- Every hash identifies an exact byte domain.
- Every signed-object endpoint uses the same outer COSE media type and an object-specific protected content type.
- Every Hail-owned media type has a stable registration or final allocation.
- Remaining JSON use is explicitly identified as an external standard, HTTP response, diagnostic projection, or implementation-local API.
- CDDL, reference codecs, golden vectors, negative vectors, and cross-language tests exist before interoperability is claimed.

## Deferred Decisions

- Production limits beyond the POC interoperability floors
- zstd body transfer support
- Additional signing algorithms
- End-to-end encrypted bodies or envelopes
- Future representation negotiation
- CIDs or other typed content links if Hail later develops a concrete need
- Integer map labels in a future incompatible profile

None of these decisions blocks the deterministic CBOR and COSE v0 profile.
