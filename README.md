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

Hail is a working pre-launch public alpha. The reference provider supports
category subscriptions, explicit connections, rich messages, forwarding, threaded
replies, passkey login, managed browser signup, and owner-authorized custody and
provider transfers. Public identities use canonical `plc.directory` writes and
validated audit reads. Deployment features remain explicitly configured by each
operator; running code is not proof of independent operation or recovery readiness.

The repository includes TypeScript and Go codecs, shared conformance vectors,
schema checks and benchmarks. Hail-owned signed objects use deterministic CBOR
and COSE_Sign1; JSON remains available at authoring and standardized boundaries.

For unresolved product work, see the [browser roadmap](docs/browser-client-roadmap.md).
For transfer authority and provider readiness, see [custody transitions](apps/cli/docs/custody-transitions.md).

## Deploy your own provider

Start with the [new provider setup guide](apps/server/deploy/public/README.md).
It covers the host, domain, container stack, HTTPS ingress, monitoring, first
administrator, registration and ongoing operations. The
[first administrator walkthrough](docs/provider-admin-setup.md) explains the
owner-key and monitor ceremony through first dashboard login.

## Client capabilities

The reference CLI covers account administration and sensitive identity ceremonies. The thin GUI now supports invited managed signup, passkey access and everyday messaging. Signup temporarily handles owner recovery keys in the browser; routine managed signing stays with the provider.

| Capability | [`hailp` CLI](apps/cli) | [Thin GUI client](apps/client) |
| --- | --- | --- |
| View account identity | Full account details | Address, DID and custody summary |
| Account onboarding | Owner-controlled and managed | Invited managed signup: resumable setup, verified recovery kit, external email verification and automatic monitoring |
| Vault backup and recovery | Create, verify, back up and import | Generate, save and verify a recovery kit during signup; no post-signup recovery import |
| Passkeys and sessions | Browser-mediated passkey login | Sign in, add/rename/revoke passkeys, and sign out all sessions |
| API credential management | Create, rotate, revoke and recovery login | Approve scoped CLI access; no credential-management UI |
| Sender Profiles | Create, view and update | Verified avatars, passkey-confirmed photo editing and publishing-category management |
| Grants | Create, list, inspect, update and revoke | List scopes/expiry; managed sender approval by address or QR link, with passkey-confirmed creation and revocation |
| Inbox | List, retrieve and wait with resumable delivery cursors | Paginated feed, safe rich-text rendering, avatars and bundled headers |
| Conversations | List peers, read messages/threads, mark read/unread, trash and restore | Reply threads and read/unread/trash controls |
| Diagnostics | Read-only provider/account checks, scope/expiry and workflow prerequisites | — |
| Compose | Explicit Grant/reply text workflows | Category publications and connection messages, forwarding, rich text, bundled PNG headers and separate work/delivery status |
| Replies | Plain-text replies | Plain-text replies while the capability remains valid |
| Sent messages | Status and retry by message ID | Paginated Sent view, detail, status and indeterminate retry |
| Address bindings | View and renew | — |
| Custody transitions | Managed ↔ owner-controlled | — |
| Provider transfers | Owner-controlled and managed workflows | — |
| Credential storage | Local encrypted vault and credential files | HttpOnly session cookie and encrypted pending setup; no full-access signup API credential |

Browser onboarding uses the [reduced-assurance alpha profile](docs/public-authentication.md).
Registration defaults to invitations and can be opened explicitly by an operator.
Same-operator monitoring is disclosed; broader platform validation and post-signup
browser recovery remain separate work.

## Repository layout

- [`apps/server`](apps/server): TypeScript provider server, account APIs, delivery workers and custody-transfer runtime.
- [`apps/cli`](apps/cli): Native Rust `hailp` CLI, encrypted user vault and owner-authorized onboarding, recovery and transfer workflows.
- [`apps/client`](apps/client): Browser client for inbox, safe rich-message rendering, composing, replies and sent-message status.
- [`apps/plc-monitor`](apps/plc-monitor): PLC history monitor, durable coverage and alerting, and signed onboarding/transfer attestations.
- [`packages/hail-client-support`](packages/hail-client-support): Shared browser vault/recovery and server-side web account transport.
- [`packages/hail-codec-ts`](packages/hail-codec-ts): TypeScript reference codec.
- [`packages/hail-codec-go`](packages/hail-codec-go): Go reference codec.
- [`vendor/did-method-plc`](vendor/did-method-plc): pinned upstream submodule; maintained outside Hail.

## Documentation

- [Production readiness](docs/production-readiness.md): release checklist and verification evidence.
- [Install hailp](apps/cli/docs/cli-installation.md), [CLI quickstart](apps/cli/docs/cli-quickstart.md), and [command reference](apps/cli/docs/cli-reference.md).
- [`DESIGN.md`](DESIGN.md): High-level product and protocol design.
- [`docs/portable-custody.md`](docs/portable-custody.md): Key custody, transfer ceremony, recovery checkpoints and POC/production boundaries.
- [`docs/passkey-authentication.md`](docs/passkey-authentication.md): Passwordless provider login, cross-platform client strategy, recovery boundaries and remaining platform validation.
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
