# Hail Protocol

Hail Protocol is an early-stage design for federated, permission-based messaging. It changes email's default delivery model: a sender may deliver under an explicit, revocable Hail Grant or a single-use reply authorization created by an earlier solicited message.

The project aims to support secure rich messages, independent providers, portable DID-based identities, and inexpensive rejection of unauthorized traffic.

## Status

Hail is currently in the protocol design phase. There is no working server or client implementation yet.

Current provisional identity model:

```text
Bring your own domain: did:web
Provider-issued identity: did:plc
Human-readable address: signed, expiring Hail Address Binding
```

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
- [`BODY_FORMAT.md`](BODY_FORMAT.md): Safe Portable Text body-format design.
- [`spec/core-delivery.md`](spec/core-delivery.md): Core grant-authorized delivery flow.
- [`spec/address-binding.md`](spec/address-binding.md): Human-readable address-to-DID binding.
- [`spec/did-profile.md`](spec/did-profile.md): Required Hail DID keys and service entry.
- [`spec/grants.md`](spec/grants.md): Hail Grant schema and lifecycle.
- [`spec/bodies.md`](spec/bodies.md): Detached body publication, authorization, retrieval, and retention.
- [`spec/envelopes.md`](spec/envelopes.md): Hail Envelope schema, authorization, signatures, and replay behavior.
- [`spec/delivery-state.md`](spec/delivery-state.md): Acceptance, delivery, retries, failures, and signed status updates.
- [`spec/http-binding.md`](spec/http-binding.md): HTTPS submission outcomes, privacy, timing, retries, and remaining wire bindings.

## License

Hail Protocol is licensed under the [MIT License](LICENSE).
