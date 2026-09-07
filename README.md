# Hail Protocol

Hail Protocol is a federated, permission-based messaging concept intended to solve the downfalls of email by changing the default delivery model and strengthening sender identity, message authorization, deliverability, and client-side safety.

Instead of allowing anyone who knows an address to send a message, Hail requires recipient-controlled permission before messages can appear in a user's inbox.

The project aims to support beautiful messages, independent providers, portable `did:plc` identities, and inexpensive rejection of unauthorized traffic.

## Status

Hail is currently in the protocol design phase. There is no working server or client implementation yet. The sole intended v1 representation for Hail-owned signed objects and bodies is deterministic CBOR, with COSE_Sign1 for signatures; developer-facing and externally standardized JSON boundaries remain available where appropriate.

## Core Principles

- Recipients control who may deliver messages.
- Grants bind stable DIDs rather than addresses or providers.
- Revocation immediately prevents new envelope acceptance and does not require sender cooperation.
- Servers reject unauthorized envelopes before transferring message bodies.
- Rich content uses Safe Portable Text rather than arbitrary HTML.
- Federation uses open web standards where practical.
- The protocol should remain approachable to hobbyists and independent implementers.

## Documentation

- [`DESIGN.md`](DESIGN.md): High-level product and protocol design.
- [`BUILD_ORDER.md`](BUILD_ORDER.md): Recommended specification and implementation sequence.
- [`CBOR_MIGRATION.md`](CBOR_MIGRATION.md): Active migration plan from the earlier JSON/JWS draft to deterministic CBOR and COSE.
- [`BODY_FORMAT.md`](BODY_FORMAT.md): Safe Portable Text body-format design.
- [`spec/encoding.md`](spec/encoding.md): Normative Hail data model, deterministic CBOR, COSE, and diagnostic JSON profile.
- [`spec/hail.cddl`](spec/hail.cddl): Draft machine-readable structural schemas for Hail v1 payloads and the initial body profile.
- [`spec/core-delivery.md`](spec/core-delivery.md): Core grant-authorized delivery flow.
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
