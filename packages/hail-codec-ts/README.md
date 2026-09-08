# `@hailproto/codec`

Reference TypeScript implementation of the Hail v1 deterministic CBOR and COSE_Sign1 profile.

Status: pre-release protocol work. The package is private until schemas and conformance vectors stabilize.

## Requirements

- Node.js 24 or newer for the supported server runtime
- Bun for repository workspace commands
- Web Crypto Ed25519 support when using the included signing adapters

The core codec uses web-platform `Uint8Array`, `TextEncoder`, and `TextDecoder` APIs and does not depend on Node-specific modules.

`cborg` is the selected CBOR primitive because it supports RFC 8949 ordering, shortest encodings, duplicate-key rejection, prohibited-tag defaults, and browser-safe byte arrays. Hail additionally validates the constrained data model and requires decode/re-encode byte equality. More permissive high-throughput codecs may be benchmarked later, but are not used on the strict acceptance path unless they can preserve these checks.

The current decoder safety defaults are provisional implementation ceilings while production interoperability limits remain under specification: 256 KiB encoded input, depth 32, 16,384 total values, 4,096 array entries, and 256 map entries. Object-level limits can be lower.

## Usage

```ts
import {
  createWebCryptoSigner,
  createWebCryptoVerifier,
  signPayload,
  verifySignedPayload,
  type HailAddressBinding,
} from "@hailproto/codec";

const binding: HailAddressBinding = {
  version: 1,
  type: "hail.address-binding",
  address: "alice@example.com",
  did: "did:plc:aaaaaaaaaaaaaaaaaaaaaaaa",
  issued_at: 1787851200,
  expires_at: 1795627200,
  key_id: "did:plc:aaaaaaaaaaaaaaaaaaaaaaaa#hail-identity",
};

const signed = await signPayload(
  "hail.address-binding",
  binding,
  createWebCryptoSigner(binding.key_id, privateKey),
);

const verified = await verifySignedPayload(
  "hail.address-binding",
  signed,
  createWebCryptoVerifier(async (keyId) => resolvePublicKey(keyId)),
);
```

Key resolution and DID verification remain caller responsibilities. The verifier callback must return only a key authorized after applying the Hail DID profile.

## Commands

From the repository root:

```text
bun install
bun run typecheck
bun run test
bun run build
```

The checked-in language-neutral vectors are documented in [`vectors/README.md`](vectors/README.md). Tests consume these fixed values directly. `bun run --cwd packages/hail-codec-ts vectors:generate` is a maintainer command for intentional protocol changes, not part of normal test execution.

After building, inspect a signed object without verifying its signature:

```text
node packages/hail-codec-ts/dist/cli.js inspect hail.envelope envelope.cose
```

Bearer tokens are redacted unless `--show-secrets` is explicitly supplied. Inspection returns an `InspectedHailObject` and never establishes authenticity; only `verifySignedPayload` returns the nominally branded `VerifiedHailObject`.

Render a strict deterministic payload as CBOR diagnostic notation:

```text
node packages/hail-codec-ts/dist/cli.js diagnose hail.body.spt-1 body.cbor
```

The diagnostic-notation command bounds file reads, validates the payload against its named Hail schema, and escapes terminal-control Unicode before rendering it. Byte strings use `h'...'` notation, map keys retain deterministic CBOR ordering, and bearer tokens are redacted unless `--show-secrets` is the sole optional argument.

Diagnostic JSON file input is intentionally not exposed by the CLI until a duplicate-aware, lossless JSON parser is integrated. This prevents JSON number rounding or duplicate members from silently changing deterministic payload bytes. Federation endpoints never accept diagnostic JSON.

## Schema Consistency

Tests compile `spec/hail.cddl` with the exactly pinned, development-only `@cbortech/cbor` validator and apply it directly to checked-in payload bytes. The suite checks every positive vector, missing required members, closed maps, byte-string and collection boundaries, and structural negative vectors. It separately records cases where Hail's semantic validator is intentionally stricter than CDDL.

This dependency is a test oracle only. It is not used by the production encoder or decoder, and it does not replace deterministic re-encoding, resource scanning, or semantic validation.

## Benchmarks

Run repeatable TypeScript payload, deterministic-CBOR, and complete COSE envelope benchmarks with:

```text
bun run bench:codec
```

Run the deterministic representation-size report with `bun run bench:sizes`. It compares CBOR with compact diagnostic JSON for developer context and reports gzip-compressed CBOR; diagnostic JSON is not a federation representation or a substitute for historical JSON/JWS wire measurements.

Go benchmarks use the same checked-in envelope and body vectors and report native allocations through `go test -benchmem`; see `packages/hail-codec-go/README.md`. Benchmark output is environment-dependent and is not checked in as a protocol guarantee.
