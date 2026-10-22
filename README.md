# Hail Protocol

Hail is a federated messaging protocol where recipients decide who can reach their inbox. For approved senders, that permission provides a clear, reliable path to delivery.

Unlike email, knowing someone's address is not enough. A sender needs permission from the recipient — a Hail Grant — and providers can reject unauthorized traffic before accepting the message content.

Hail is designed for independent providers, portable `did:plc` identities, rich and safe messages, and inexpensive spam rejection.

## Core Principles

- Recipients control who may deliver messages.
- Send permissions (grants) bind to stable DIDs rather than addresses or providers.
- Servers reject unauthorized envelopes before transferring message bodies.
- Grant revocation immediately prevents new envelope acceptance and does not require sender cooperation.
- Rich content uses Safe Portable Text, a custom subset of Sanity's Portable Text.
- Federation uses open web standards where practical.
- The protocol should remain approachable to hobbyists and independent implementers.

## Status

Hail is a working **public alpha**. Three HTTPS TypeScript providers resolve
portable identities directly from `plc.directory`. The independently hosted
`haili.app` permanent canary and the disposable `hailproto.app` and
`hailproto.dev` canaries have signed monitor onboarding evidence, live Sender
Profiles and reciprocal Grants; test messages reached terminal `delivered`
state in both directions between `haili.app` and each alpha provider. The
canaries also delivered and rendered safe rich text and digest-bound bundled
PNG headers. Both sender canaries publish verified bundled PNG avatars through
Sender Profile v2, and the disposable GUI shows avatars and headers in its
inbox feed without remote image requests. Its minimal composer has also sent
plain and bundled-header messages over live reciprocal Grants and displayed
their terminal delivery status. A Sent view reads retained outbound bodies and
authenticated delivery status without inventing read receipts. Inbox and Sent
use bounded batch pages, evidence-backed address labels, and explicit guidance
for held, failed, cancelled, or receipt-indeterminate messages.

This is real public federation evidence. The permanent `haili.app` provider has
closed its operational launch gates, but the two disposable providers still
share one VPS and are not production services. Public managed transfer,
historical recovery, abandonment, and equivalent recovery/load/security controls
for every participating provider remain gated. Track the [`haili.app`
permanent-provider launch](docs/haili-launch.md),
the detailed [production gate checklist](apps/cli/docs/custody-transitions.md#production-enablement-required-versus-deferrable)
and the [portable-custody boundary](docs/portable-custody.md).

The repository includes TypeScript and Go reference codecs, shared conformance vectors, executable schema checks, diagnostic tooling and benchmarks. The intended v0 representation for Hail-owned signed objects and bodies is deterministic CBOR, with COSE_Sign1 for signatures; developer-facing and externally standardized JSON boundaries remain available where appropriate.

## Client capabilities

The reference CLI covers account administration and sensitive identity ceremonies. The thin GUI is intentionally limited to everyday messaging and keeps credentials and keys out of the browser.

| Capability | [`hailp` CLI](apps/cli) | [Thin GUI client](apps/gui-poc) |
| --- | --- | --- |
| View account identity | Full account details | Address, DID and custody summary |
| Account onboarding | Owner-controlled and managed | — |
| Vault backup and recovery | Create, verify, back up and import | — |
| Credential management | Create, rotate, revoke and recovery login | — |
| Sender Profiles | Create, view and update | Displays verified avatars |
| Grants | Create, list, inspect, update and revoke | Reads active Grants for composing and address labels |
| Inbox | List and retrieve messages | Paginated feed, safe rich-text rendering, avatars and bundled headers |
| Compose | Plain text with reply invitations | Plain or rich text, formatting and a bundled PNG header |
| Replies | Plain-text replies | Plain-text replies while the capability remains valid |
| Sent messages | Status and retry by message ID | Paginated Sent view, detail, status and indeterminate retry |
| Address bindings | View and renew | — |
| Custody transitions | Managed ↔ owner-controlled | — |
| Provider transfers | Owner-controlled and managed workflows | — |
| Credential storage | Local encrypted vault and credential files | Fixed server-side credential; none in the browser |

## Repository layout

- [`apps/server`](apps/server): TypeScript provider server, account APIs, delivery workers and custody-transfer runtime.
- [`apps/cli`](apps/cli): `hailp` reference CLI (`hail-cli-ts`), encrypted user vault and owner-authorized onboarding, recovery and transfer workflows.
- [`apps/gui-poc`](apps/gui-poc): Disposable thin GUI for inbox, safe rich-message rendering, composing, replies and sent-message status.
- [`apps/plc-monitor`](apps/plc-monitor): PLC history monitor, durable coverage and alerting, and signed onboarding/transfer attestations.
- [`packages/hail-codec-ts`](packages/hail-codec-ts): TypeScript reference codec.
- [`packages/hail-codec-go`](packages/hail-codec-go): Go reference codec.
- [`vendor/did-method-plc`](vendor/did-method-plc): pinned upstream submodule; maintained outside Hail.

## Documentation

- [`DESIGN.md`](DESIGN.md): High-level product and protocol design.
- [`BUILD_ORDER.md`](BUILD_ORDER.md): Recommended specification and implementation sequence.
- [`docs/portable-custody.md`](docs/portable-custody.md): Key custody, transfer ceremony, recovery checkpoints and POC/production boundaries.
- [`docs/passkey-authentication.md`](docs/passkey-authentication.md): Passwordless provider login, cross-platform client strategy, recovery boundaries and implementation checklist.
- [Key custody and offline operation](docs/portable-custody.md#key-custody-in-plain-language): Signing-role and custody comparisons, offline requirements and binding-expiration rationale.
- [Managed profiles and API-first clients](docs/portable-custody.md#managed-profiles-and-people-or-agents): Human/agent custody choices, owner-controlled recovery and native/`hailp` API interaction.
- [Provider deployment runbook](apps/server/deploy/public/README.md): Strict-public provider setup and validation.
- [User-key CLI](apps/cli/README.md): User-device vault, onboarding, Grant signing and exact-byte cutover commands.
- [Public monitor deployment](apps/plc-monitor/deploy/public/README.md): Per-DID public PLC monitoring, reviewed bootstrap, signed attestations and external email alerts.
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

## License

Hail Protocol is licensed under the [MIT License](LICENSE).
