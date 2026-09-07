# `@hail-protocol/codec`

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
} from "@hail-protocol/codec";

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

After building, inspect a signed object without verifying its signature:

```text
node packages/hail-codec/dist/cli.js inspect hail.envelope envelope.cose
```

Bearer tokens are redacted unless `--show-secrets` is explicitly supplied. Inspection returns an `InspectedHailObject` and never establishes authenticity; only `verifySignedPayload` returns the nominally branded `VerifiedHailObject`.

Diagnostic JSON file input is intentionally not exposed by the CLI until a duplicate-aware, lossless JSON parser is integrated. This prevents JSON number rounding or duplicate members from silently changing deterministic payload bytes. Federation endpoints never accept diagnostic JSON.
