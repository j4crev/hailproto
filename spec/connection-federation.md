# Cross-Provider QR Connections — Preview v1

This completes connection admission/reconciliation/disconnect across compatible
providers, for managed and owner-controlled identities. It does **not** authorize
message delivery, change subscriptions, implement block/unblock, or make the retained
connection history portable. Those remain separate gates. The separate connection
messaging implementation uses version-2 Envelopes and this coordinator's current
state; see [messaging](../docs/connection-messaging.md). See
[connection consent](connection-auth.md) for the local identity-signing flow.

## Authority And Wire

The inviter signs `hail.connection-invitation` with `#hail-identity`; the scanner
signs the exact `hail.connection-confirmation` with its own `#hail-identity`.
Owner-controlled keys stay local. Passkeys approve only account-local exact actions,
not arbitrary identity signatures. Providers sign `hail.connection-control` with
their account's current `#hail-messaging`, not an owner/recovery key.

The control object has a distinct protected COSE content type
`application/hail-connection-control+cbor`, version 1, closed fields and a 16 KiB
representation ceiling. TypeScript, Go, CDDL and shared signed vectors agree on:

- operation: `probe`, `offer`, `connect`, `disconnect`, `snapshot`, `admission`, `ack`;
- exact from/to DIDs, UUIDv7 request ID, nullable connection ID, pair epoch and state;
- SHA-256 proof digest, issuance time, nullable expiry and exact messaging key ID.

Commands expire within five minutes. Durable receipts (`snapshot`, `admission`,
`ack`) have null expiry: they attest recorded history, not evergreen fresh consent.
A receipt cannot move an old admitted proof into a new epoch. New activation must
occur within the identity-confirmation and invitation validity windows. Retrying an
already committed operation may recover its historical result after those windows,
but must not create new authority.

All provider requests target the current PLC-resolved service base via the existing
DNS-pinned public HTTPS transport. No QR-supplied arbitrary endpoint, redirect,
compression, browser cookie, API credential, or Origin is forwarded. POST bodies
and responses are bounded at 128 KiB and duplicate JSON keys are rejected. The
identity, provider role, service and fresh public PLC evidence are checked.
Pair history pins both peer and coordinator service locations; provider moves fail
closed until portable history reconciliation exists.

## Pair Coordinator And Epochs

The lexicographically smaller DID's current provider is the coordinator. Only its
account-local transaction advances the canonical DID pair's epoch. No distributed
SQL transaction or synchronized clocks are assumed. Each provider keeps its own
account-scoped pair, proofs, terminal tombstones and durable work.

An empty pair is `(epoch=0, state=empty, connection_id=null)`. Creating a connection
advances the epoch and assigns one UUIDv7 connection ID; disconnect advances the epoch
again and closes that exact ID. Reconnecting requires a fresh review of the closed
epoch and a newly created/replaced invitation after the inviter learned of the
disconnect. Local immutable database timestamps establish invitation freshness;
remote wall-clock comparisons are not used for that ordering.

Crossed compatible scans of the same base epoch converge on the first active event's
ID. Each operation still gets its own proof-bound result. A closed or superseded
epoch cannot be recreated by an old proof, request ID or delayed activation. Active
receipts must either reuse the reviewed active ID/epoch or advance the admitted
empty/disconnected epoch by exactly one. A coordinator signature alone cannot
substitute for a participant's locally retained consent.

## Handshake

`POST <service-base>/connections/invitations/review` verifies the code's current
token, expiry, signature, selected address binding and local serving generation.
It returns signed invitation/binding bytes and `federation:1` when these lifecycle
endpoints are available. Read-only review creates no permission or inbox request.
Older providers without that capability can be reviewed but not activated.

1. **State:** the scanner's provider signs a `probe` to
   `POST .../connections/state`. The coordinator returns a signed snapshot bound
   to its nonce and the exact pair. The scanner reviews and signs one confirmation;
   an owner-controlled scanner uses the offline identity-only CLI/file flow.
2. **Durable submission:** exact-action passkey approval atomically stores the
   scanner's signed confirmation, frozen bundle and encrypted admission token in
   its provider's outbox. The browser receives **Connecting**, never an invented
   successful remote connection. Closing the tab does not lose the work.
3. **Issuer admission:** an authenticated `offer` to `.../connections/admit`
   carries the complete signed invitation, confirmation, both address bindings,
   reviewed coordinator snapshot and the token. Their deterministic CBOR bundle
   is hashed by the provider controls. The issuer verifies current authority,
   token possession and admission window, learns signed disconnect state, checks
   its local invitation cutoff, and durably signs a proof/epoch-bound `admission`.
   The inviter does not approve each redemption again.
4. **Canonical commit:** the scanner provider sends `connect` with the bundle and
   issuer admission to `.../connections/commit`. The coordinator checks both
   identities/providers and its own retained local consent, then serializes the
   pair CAS. It stores an immutable event and request result. Responses contain a
   historical operation receipt **and a separate current-state snapshot**; an old
   successful result is not permission to reopen a relationship.
5. **Replication:** the coordinator durably sends the signed event and its proof
   to `.../connections/sync`. The recipient verifies local consent, both identity
   proofs and issuer admission, then applies monotonic state. Before first adopting
   an activation it probes current coordinator state. Terminal IDs always win over
   delayed active receipts. A signed, digest-bound `ack` confirms delivery, not that
   the relationship can never subsequently be disconnected.

## Disconnect, Retry And UI

An exact-action local disconnect immediately inserts a terminal tombstone and hides
that connection locally. Its durable `disconnect` command targets the exact global
ID, not an unqualified DID pair. The coordinator records the close and replicates it.
Retrying an old disconnect acknowledges its old closed event and cannot terminate a
new connection. A peer can learn disconnect before it ever sees activation; delayed
activation still cannot reopen the ID. Fresh codes are required to reconnect.

The worker resumes from PostgreSQL, handles ambiguous committed replies idempotently
and backs off up to one hour. Disconnects and unacknowledged state are never dropped
merely because a provider is offline. Superseded state deliveries carry the latest
coordinator event rather than reasserting stale active state. Historical event rows
are retained. The preview uses one bounded delivery at a time per provider; no network
call holds both providers' account locks.

Security lists current connections, unfinished synchronization and the latest failed
outbound attempt per peer. The scanner and Security poll saved status; no additional
acceptance click is needed. Failures/expiry are not relabeled as successful saves.
There is one pending outbound operation per pair and at most 100 retained federated
peer slots per account. Account/API and provider ingress rate limits also apply.

## Storage, Rollout And Proof

Migration 64 is additive. It retains separate pairs, proof bundles, admission and
result receipts, canonical events, causal signed commands, tombstones, disconnect
work, replication work and public signing evidence. Composite foreign keys bind
every pair/event to its account; immutable-intent and no-delete/no-truncate guards
preserve history. Generation/fence checks apply to both request handlers and workers.

Confirmed federation intent/tombstones block transfer fences, serving-generation
advances and custody-transition preparation. Do not bypass those guards to migrate.
Schema rollback works while empty and refuses retained federation history; code
rollback must retain all tables and may pause remote synchronization. Disabling the
preview does not cancel consent or erase pending disconnects.

Local verification uses two independent PostgreSQL schemas and provider HTTP handlers,
separate account/identity/messaging/passkey keys, and real signed assertions. It covers
crossed scans, process restarts, lost admission/commit/sync/disconnect replies, immutable
bundles, old successful retries, expiry after durable admission, revocation before
admission, fresh-code reconnect, stale activation/disconnect ordering, forged purpose,
proof/epoch substitutions, absent local consent, account isolation and rollback/fencing.
Browser checks use local API fixtures with real virtual WebAuthn for owner signing,
vault-file refusal, durable Connecting status, tab closure and Security polling. These
checks are not a claim of an authenticated production exchange with an unrelated
provider; that requires its compatible deployment and the users' actual passkeys.
