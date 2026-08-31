# Hail Protocol

Hail Protocol is an early-stage design for federated, permission-based messaging. It changes email's default delivery model: a sender may deliver messages only after the recipient creates an explicit, revocable Hail Grant.

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
- Revocation is immediate and does not require sender cooperation.
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

## License

Hail Protocol is licensed under the [MIT License](LICENSE).
