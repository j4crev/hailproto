# Hail v1 Conformance Vectors

`v1.json` is the checked-in, language-neutral conformance manifest for the Hail v1 encoding profile. It contains:

- diagnostic projections and exact deterministic payload hex for all six payload families;
- complete tagged COSE_Sign1 hex for all five signed object families;
- exact COSE Sig_structure hex for independent signature verification;
- linked digest domains connecting Address Binding and Sender Profile evidence to grants, grant revisions to their predecessors, bodies to envelopes, and envelope payloads to delivery statuses;
- SHA-256 values and canonical base64url renderings;
- URL segment, strong ETag, bearer authorization, and RFC 9530 `Content-Digest` examples;
- malformed CBOR and COSE inputs with expected error classifications; and
- fixed Ed25519 seeds and public keys used only for reproducible tests.

Package consumers can access the manifest through the exported `@hailproto/codec/vectors/v1.json` subpath. JSON module loading syntax remains runtime-specific; consumers may also read the file as package data.

The private seeds are public test material. They MUST NOT be used for any identity, deployment, or non-test message. `seed_hex` is the raw 32-byte Ed25519 seed used in RFC 8410 PKCS#8 key material. `public_key_hex` is the corresponding raw 32-byte Ed25519 public key.

`expected_error` records the reference TypeScript codec's stable error classification. Other implementations MUST reject each negative vector but may map failures into different local error taxonomies or apply a different rejection precedence.

Conformance tests consume `v1.json` directly. They do not invoke the generator. This makes the checked-in bytes the expected values and detects accidental encoding or signing changes.

To intentionally regenerate the manifest after a reviewed protocol change:

```text
bun run --cwd packages/hail-codec vectors:generate
```

Review the complete manifest diff. Any changed payload, signature, digest, or negative-vector classification is a protocol-visible change and requires an explanation.
