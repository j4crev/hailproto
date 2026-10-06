# Hail Protocol

Hail Protocol is a federated, permission-based messaging concept intended to solve the downfalls of email by changing the default delivery model and strengthening sender identity, message authorization, deliverability, and client-side safety.

Instead of allowing anyone who knows an address to send a message, Hail requires recipient-controlled permission before messages can appear in a user's inbox.

The project aims to support beautiful messages, independent providers, portable `did:plc` identities, and inexpensive rejection of unauthorized traffic.

## Status

Hail is in the protocol design and prototype phase. Two HTTPS-exposed TypeScript providers on one VPS use a private PLC directory. The POC implements onboarding, address discovery and activation, signed Sender Profiles, Grant publication/revocation, detached-body delivery, signed terminal status and single-use replies. Fresh user-key-held identities have completed provider transfers, including delivery of a pending message exactly once after cutover. A user-key reference CLI and a same-VPS PLC monitor also run through tested onboarding/transfer and signed-alert workflows.

This is an isolated POC, not public Hail federation or a production client. The original Alice/Bob accounts remain custodial; newer identities use user-held recovery/identity keys. The same-VPS monitor proves functionality, not independence. Public `plc.directory` rollout, independent monitoring/mirrors and second-device recovery remain outstanding. See the [current POC status](docs/typescript-backend-poc.md#current-poc-status-october-6-2026) and [portable-custody boundary](docs/production-portable-custody.md).

The repository includes TypeScript and Go reference codecs, shared conformance vectors, executable schema checks, diagnostic tooling and benchmarks. The intended v0 representation for Hail-owned signed objects and bodies is deterministic CBOR, with COSE_Sign1 for signatures; developer-facing and externally standardized JSON boundaries remain available where appropriate.

## Core Principles

- Recipients control who may deliver messages.
- Send permissions (grants) bind to stable DIDs rather than addresses or providers.
- Servers reject unauthorized envelopes before transferring message bodies.
- Grant revocation immediately prevents new envelope acceptance and does not require sender cooperation.
- Rich content uses Safe Portable Text, a custom subset of Sanity's Portable Text.
- Federation uses open web standards where practical.
- The protocol should remain approachable to hobbyists and independent implementers.

## Documentation

- [`DESIGN.md`](DESIGN.md): High-level product and protocol design.
- [`BUILD_ORDER.md`](BUILD_ORDER.md): Recommended specification and implementation sequence.
- [`docs/typescript-backend-poc.md`](docs/typescript-backend-poc.md): Reproducible Bun/Hono two-provider POC implementation and deployment guide.
- [`docs/production-portable-custody.md`](docs/production-portable-custody.md): Key custody, transfer ceremony, recovery checkpoints and POC/production boundaries.
- [Provider deployment runbook](https://github.com/j4crev/hail-server-ts/blob/main/deploy/poc/README.md): VPS, DNS/TLS, provider setup, delivery and verified rollout records.
- [User-key reference client](https://github.com/j4crev/hail-user-client-ts#readme): User-device vault, onboarding, Grant signing and exact-byte cutover commands.
- [Same-VPS monitor deployment](https://github.com/j4crev/hail-plc-monitor-ts/blob/main/deploy/poc/README.md): Private PLC ingestion, signed HTTPS alerts and restart verification; explicitly non-independent.
- [`CBOR_MIGRATION.md`](CBOR_MIGRATION.md): Active migration plan from the earlier JSON/JWS draft to deterministic CBOR and COSE.
- [`BODY_FORMAT.md`](BODY_FORMAT.md): Safe Portable Text body-format design.
- [`spec/encoding.md`](spec/encoding.md): Normative Hail data model, deterministic CBOR, COSE, and diagnostic JSON profile.
- [`spec/hail.cddl`](spec/hail.cddl): Draft machine-readable structural schemas for Hail v0 payloads and the initial body profile.
- [`packages/hail-codec-ts`](packages/hail-codec-ts): Bun-workspace TypeScript reference codec, validators, COSE implementation, diagnostic tooling, and tests.
- [`packages/hail-codec-go`](packages/hail-codec-go): Independent Go reference codec and cross-language conformance implementation.
- [`spec/core-delivery.md`](spec/core-delivery.md): Core grant-authorized delivery flow.
- [`spec/account-onboarding.md`](spec/account-onboarding.md): New and existing DID registration, portable key custody, address activation, and onboarding failure handling.
- [`spec/address-binding.md`](spec/address-binding.md): Human-readable address-to-DID binding.
- [`spec/did-profile.md`](spec/did-profile.md): PLC identity, Hail key roles, resolution, recovery, and service entry.
- [`spec/sender-profile.md`](spec/sender-profile.md): Signed sender metadata and category manifest.
- [`spec/grants.md`](spec/grants.md): Hail Grant schema and lifecycle.
- [`spec/bodies.md`](spec/bodies.md): Detached body publication, authorization, retrieval, and retention.
- [`spec/envelopes.md`](spec/envelopes.md): Hail Envelope schema, authorization, signatures, and replay behavior.
- [`spec/delivery-state.md`](spec/delivery-state.md): Acceptance, delivery, retries, failures, and signed status updates.
- [`spec/http-binding.md`](spec/http-binding.md): HTTPS submission outcomes, privacy, timing, retries, and remaining wire bindings.

## License

Hail Protocol is licensed under the [MIT License](LICENSE).
