# Hail

Hail is a federated messaging medium powered by the RACR Protocol (Recipient-Authorized Content Retrieval, pronounced “racer”). Recipients control who may deliver messages to them. Senders submit signed envelopes announcing available content; the recipient’s provider validates authorization before retrieving and delivering that content.

Hail is designed for independent providers, portable `did:plc` identities, rich and safe messages, and inexpensive spam rejection.

## Differentiators

- Recipients control who may deliver messages.
- Send permissions bind to stable DIDs rather than addresses or providers, allowing seamless account migration between providers without needing to update Senders and Connections with your new Hail address.
- Servers must accept message envelopes before transferring message bodies and attachments. This reduces per-attempt spam-based traffic and allows servers to quickly drop it.
- Unsubscribing immediately prevents new envelope acceptance and does not require sender cooperation.
- Rich content uses what we call Safe Portable Text, our custom subset of Sanity's Portable Text.
- Sender's can use "header" images to enhance a user's feed experience and draw attention to their content.

## Status

Hail is currently in public alpha.

Public identities use the PLC Organization's `https://plc.directory` for DID registration and management - originally created by Bluesky Social PBC for the AT Protocol.

A TypeScript server and web client are available to deploy your own provider service. There's also a Rust-based CLI tool for agent use. We encourage you to create your own server implementations, web and native clients, or integrate client functionality into existing email and messaging platforms.

## Deploy your own provider

Start with the [provider setup guide](apps/server/deploy/standalone/README.md). The
guide includes the first administrator owner-key and monitor ceremony through
first dashboard login.

## Client capabilities

| Capability | [`racr` CLI](apps/cli) | [Web client](apps/client) |
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
| Address bindings | View and publish | — |
| Custody transitions | Managed ↔ owner-controlled | — |
| Provider transfers | Owner-controlled and managed workflows | — |
| Credential storage | Local encrypted vault and credential files | HttpOnly session cookie and encrypted pending setup; no full-access signup API credential |

## Repository layout

- [`apps/server`](apps/server): TypeScript provider server
- [`apps/cli`](apps/cli): Native Rust `racr` CLI
- [`apps/client`](apps/client): Web client
- [`apps/plc-monitor`](apps/plc-monitor): PLC history monitor, durable coverage and alerting, and signed onboarding/transfer attestations.
- [`packages/hail-client-support`](packages/hail-client-support): Shared browser vault/recovery and server-side web account transport.
- [`packages/hail-codec-ts`](packages/hail-codec-ts): TypeScript reference codec.
- [`packages/hail-codec-go`](packages/hail-codec-go): Go reference codec.
- [`vendor/did-method-plc`](vendor/did-method-plc): pinned upstream submodule; maintained outside Hail. 

## License

This project is licensed under the [MIT License](LICENSE).
