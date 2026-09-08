# Hail Codec for Go

Independent Go implementation of the strict Hail v1 deterministic-CBOR profile. It supports typed payloads for all six families, constrained value and resource validation, tagged COSE_Sign1 inspection/signing/Ed25519 verification, SHA-256 digest inputs, and canonical unpadded base64url.

## API

- `EncodePayload` and `DecodePayload` validate and encode/decode the typed payload models.
- `EncodeDeterministic` and `DecodeDeterministic` expose constrained deterministic CBOR, with `ResourceLimits` variants for custom limits.
- `DefaultResourceLimits()` returns a fresh default limits value; all custom limit fields are validated before use.
- `SignPayload`, `InspectSignedPayload`, and `VerifySignedPayload` implement the Hail COSE_Sign1 profile only. Verification requires a `Verifier` that receives the protected key ID and exact signature inputs, keeping key resolution and signature checking inseparable.
- `SigStructure` produces the exact COSE `Signature1` structure.
- `EncodeBase64URL` and `DecodeBase64URL` produce and require canonical unpadded base64url. Pass `-1` when no decoded-length check is needed.
- `InspectedObject` and `VerifiedObject` are distinct result types. Their `Type`, `KeyID`, `Payload`, `PayloadBytes`, and `RepresentationBytes` getters expose immutable metadata or deep independent copies.

The codec rejects non-deterministic encodings, tags in payloads, floats and unsupported simple values, non-text or duplicate map keys, indefinite lengths, invalid UTF-8, trailing data, and inputs exceeding declared resource limits. COSE parsing is intentionally not a general COSE implementation.

## Development

Tests consume the shared vectors directly from `../hail-codec-ts/vectors/v1.json`; they are not copied into this module.

```sh
mise exec -- gofmt -w .
mise exec -- go test ./...
mise exec -- go vet ./...
```

Run native benchmarks with allocation reporting:

```sh
mise exec -- go test -run=^$ -bench=. -benchmem ./...
```
