# Hail Protocol

Hail is a federated messaging protocol where recipients decide who can reach their inbox.

Unlike email, knowing someone's address is not enough. A sender needs permission from the recipient — a Hail Grant — and providers can reject unauthorized traffic before accepting the message content.

Hail is designed for independent providers, portable `did:plc` identities, rich and safe messages, and inexpensive spam rejection.

## Status

Hail is a working private-network POC approaching its first release. Two HTTPS TypeScript providers use a private PLC directory. The reference server, `hailp` client and monitor cover owner-controlled and managed custody, onboarding, Grants, messaging, recovery and exact-retry `A → B → A` provider migration while preserving accepted state and fencing stale workers and credentials.

This is not yet public Hail federation. The strict-public runtime exists but remains disabled, and no production identity has been written to `plc.directory`. Remaining gates cover deployed reader/monitor proof, operational key and backup controls, cross-host restoration, blocked-history recovery, abandonment and load limits before one permanent public canary. See the [production gate checklist](https://github.com/j4crev/hail-user-client-ts/blob/main/docs/custody-transitions.md#production-enablement-required-versus-deferrable) and [portable-custody boundary](docs/production-portable-custody.md).

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
- [Key custody and offline operation](docs/production-portable-custody.md#key-custody-in-plain-language): Signing-role and custody comparisons, offline feature requirements, binding-expiration rationale and verification follow-ups.
- [Managed profiles and API-first clients](docs/production-portable-custody.md#managed-profiles-and-people-or-agents): Approved human/agent custody choices, owner-controlled recovery, native/`hailp` CLI interaction and implementation milestones.
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
- [`spec/managed-custody.md`](spec/managed-custody.md): Frozen managed-identity v1 custody, owner authority and production conformance gates.
- [`spec/plc-read-evidence.md`](spec/plc-read-evidence.md): Frozen v1 read agreement, reviewed monitor bootstrap and v2 coverage evidence.
- [`spec/address-binding.md`](spec/address-binding.md): Human-readable address-to-DID binding.
- [`spec/did-profile.md`](spec/did-profile.md): PLC identity, Hail key roles, resolution, recovery, and service entry.
- [`spec/sender-profile.md`](spec/sender-profile.md): Signed sender metadata and category manifest.
- [`spec/grants.md`](spec/grants.md): Hail Grant schema and lifecycle.
- [`spec/bodies.md`](spec/bodies.md): Detached body publication, authorization, retrieval, and retention.
- [`spec/envelopes.md`](spec/envelopes.md): Hail Envelope schema, authorization, signatures, and replay behavior.
- [`spec/delivery-state.md`](spec/delivery-state.md): Acceptance, delivery, retries, failures, and signed status updates.
- [`spec/http-binding.md`](spec/http-binding.md): HTTPS submission outcomes, privacy, timing, retries, and remaining wire bindings.

## Related Repositories

- [`hail-server-ts`](https://github.com/j4crev/hail-server-ts): TypeScript provider server, account APIs, delivery workers and custody-transfer runtime.
- [`hail-user-client-ts`](https://github.com/j4crev/hail-user-client-ts): `hailp` reference CLI, encrypted user vault and owner-authorized onboarding, recovery and transfer workflows.
- [`hail-plc-monitor-ts`](https://github.com/j4crev/hail-plc-monitor-ts): PLC history monitor, durable coverage and alerting, and signed onboarding/transfer attestations.

## License

Hail Protocol is licensed under the [MIT License](LICENSE).
