# Connection messaging

Connection sends reuse signed envelopes, detached bodies, body-token retrieval,
delivery/status handling, the rich composer and the bounded outbound worker.
Forwarding and threaded replies use the same authenticated account surfaces.

## Authorization And Delivery

Envelope **version 2** carries only
`{"type":"connection","connection_id":"<UUIDv7>","epoch":<positive integer>}`.
Version 1 subscriptions/replies and every existing signed v0 vector are unchanged.
No category is sent, General is not overloaded, and no independent reply capability
is minted. Normal provider-held messaging keys sign messages for both custody modes;
an owner does not need to unlock the identity/recovery key for each ordinary message.

One shared local permission predicate binds both DIDs, ID, epoch, serving generation,
fences and disconnect tombstones. All new local and remote connections use the shared coordinator model and
its canonical epoch; obsolete native records do not authorize new messages. Sender creation and every
submission retry check this exact permission. Receiver acceptance uses the same
locally retained consent and the existing authenticated reception path.

Before body fetch and again before final delivery, the recipient rechecks permission.
Federated delivery requires a fresh authenticated coordinator snapshot; an unavailable
coordinator holds the existing delivery job without fetching the body. Final local
checks serialize with local disconnect. A queued message is not retargeted after
reconnect; its frozen old ID/epoch becomes blocked/rejected. Existing status reasons
report denial as `receiver-policy-rejected`.

This is not recall: an in-flight delivery authorized before a remote disconnect may
finish, delivered content stays readable, and already shared body capabilities have
their existing bounded lifetime. Subscription and independently offered reply
permissions remain separate from a connection disconnect.

## Reused Outbox And UI

- Compose has **Subscribers** and **Connections** audience choices using the same
  plain/rich editor, safe preview, PNG header support and form action.
- Connection sends select 1–100 active individual connections. Each receives its own
  envelope/message ID/body token; the recipient list is never put on the wire.
  This is a set of private copies, not a group-chat membership object.
- The sender's batch freezes the selected IDs, peer DIDs/epochs and body. Retried
  IDs cannot change content or recipients. The shared bounded worker resumes exact
  envelopes after restart/lost responses, with the existing 24-hour attempt window
  and five unfinished outbound-batch limit across both audience types.
- Category and connection intent have separate tables so old category workers do
  not misread new jobs during rollback. Signing, submission, body rendering, worker
  scheduling/locking, private status aggregation and cancellation behavior are reused.
- Existing forms use native SvelteKit enhancement so ambiguous errors retain the
  typed body and selected recipients. The original request status/history remains
  available; HTTP acceptance is not mislabeled as confirmed delivery.
- Feed reads explicitly select subscription delivery. **Conversations** reuses the
  existing inbox/reader for connection messages. A received connection message offers an inline reply using its connection
  authorization and signed parent reference, not a subscription reply capability. Disconnected history is
  readable without an active-send action. Sent uses the existing statuses/readers.

The account API reuses the publication status shape on `/connection-messages`:
`GET /targets`, `GET` recent work, `POST` immutable intent, `GET /:id` status,
`POST /:id/cancel`. Intent is `{publicationId,connections:[id,...],text}` or the same
with the existing rich `body`. No category or reply settings are accepted. Ordinary
`/messages` also accepts one `connectionId`, `connectionEpoch` and `recipientDid`
instead of Grant/reply selectors, for clients using individual sends. Account scopes,
session Origin checks and account isolation are unchanged.
The contact-picker inventory additionally requires a browser passkey session; old
message-read bearer credentials do not gain a previously unavailable contact graph.

## Migration And Verification

Migration 65 adds nullable envelope connection metadata, extends the authorization
checks without changing old rows, and retains immutable connection batches/targets.
Pending jobs block cutover. Empty schema rollback is supported; persisted connection
messages or batches refuse schema rollback. Code rollback must retain the new tables;
older envelope readers cannot interpret version 2, so use a compatible build when
restoring messaging service rather than rewriting messages into subscription Grants.

Checks cover TypeScript/Go signed-byte agreement and rejection of v1-connection,
v2-Grant, category and independent-reply substitutions. Independent provider-store
tests use real envelope/body/status handlers for mixed local/remote multi-send,
private tokens, duplicate reception, restart recovery, missing authority/on-hold,
disconnect before retrieval/during retrieval, immutable recipients, cross-account
refusal, cancellation, fresh reconnect and historical readability.

## Portable history

Configured owner-controlled and managed completion paths export supported connection
history through the existing signed account snapshot and fenced cutover. Destination
staging is inert until authenticated handover and PLC/activation checks succeed.
Original envelopes, consent, IDs/epochs, terminal history and completed handover
journals remain exact. Missing orchestration, obsolete records and undrained work
fail closed; no compatibility layer invents missing historical signatures.

Committed moves invalidate all old QR/share codes, including personal codes. Warn
before cutover, retain historical revocations, and create new destination codes.
Preparing/reviewing or cancelling a move does not revoke source codes. Retire the
source and preserve exclusive serving authority before destination messaging resumes.

See [custody and transfer behavior](../apps/cli/docs/custody-transitions.md) for
current implementation boundaries and [connection portability](../spec/connection-portability.md)
for the checkpoint and handover design. Unrelated-provider interoperability remains
an independent validation task.

## One connection model

Same-provider and cross-provider connections now use the same signed invitation,
confirmation, admission, coordinator event, per-account projection and terminal
tombstones. Same-provider control calls stay in-process; they do not make loopback
HTTP requests or require the inviter to approve again. Both placements use the
existing durable worker and expose `connecting` until their projections converge.
The lexicographically smaller DID remains coordinator regardless of placement.

The historical `federated_connection_*` table/class names remain to avoid a
cosmetic schema/protocol rename. They hold **all new connections**, not a second
remote-only implementation. Migration 70 scopes consent-attempt IDs by account so
both local participants can retain the same request independently. SQL permission
checks honor either local participant's disconnect immediately, before replication.

`account_connections` is retired: no new writes or message authority. Existing
rows remain unchanged, and their DID pairs cannot be reused in the unified model
until an explicitly scoped cleanup is approved. They are not converted into
invented federation receipts. Historical snapshot validation preserves original
bytes only; it cannot reactivate those records. See the
[cleanup boundary](../spec/connection-portability.md#unified-model-upgrade-boundary).

## Forwarding received messages

The client offers Forward beside Reply for both connection and subscription
messages. Forwarding opens the connection recipient picker with an optional note
and a preview. The server reloads the original from the authenticated inbox and
sends through the existing connection batch endpoint; subscription publication
and reply capabilities are never copied. Trashed sources cannot be forwarded.

The original subject, rich blocks, links, lists and bundled header image are
preserved. Literal attribution includes the sender's available hail address, DID,
message ID and recorded delivery timestamp (labeled “Originally received”, not
sent time). This is quoted content supplied by the forwarder, not independently
verified authorship. The normal message size limits still apply, including the
extra attribution and note.

`MessageReference` identifies a source by sender DID and message ID. It is separate
from send authorization and can be reused when adding reply composition. This
change does not introduce a wire-level relationship or thread identifier:
threaded replies use the version-3 design below, rather than inferring
relationships from forwarded text or repurposing subscription reply authority.

### Threaded and quoted replies

Both inbox message types now use the inline reply composer. Connection replies
send one message through `POST /api/v1/account/messages`, with the original
`connectionId`, `connectionEpoch`, and `recipientDid`. Subscription replies
retain `replyTo` and optional `replyUntil`. Both pass
`inReplyTo: {sender, messageId}`, producing the signed version-3 parent reference
specified in [envelopes](../spec/envelopes.md#threaded-replies-version-3).

The response is followed by a collapsible quoted excerpt of at most 4096 Unicode
characters from the immediate parent. Prior quoted replies are omitted using a
presentation convention; text recognition is never used for thread identity.
Images remain accessible on the original message. Request identity and any
continuation deadline survive failed submissions; the sent detail page supports
retrying the exact retained envelope.

`GET /api/v1/account/threads/:sender/:messageId` requires `messages:read` and a
visible root belonging to the account. It returns up to 50 chronological message
summaries, each with its parent and local availability, plus a `truncated` flag.
Inbox and sent detail pages show these summaries and links to messages/parents.
Trashed or purged inbox content is excluded without deleting surviving replies.

Apply migration 0082 before running the new server. The derived parent lookup
columns travel with account exports and are checked against signed envelope
bytes during import. Old rows need no rewrite: legacy Subscription parent
references are derived from existing authorization columns. Migration rollback
refuses once threaded envelopes have been retained. Deploy version-3 readers
to both peers before sending threaded replies; there is no capability discovery
or silent downgrade in this change.

## Shared conversations implementation checklist

Status: shared compose defaults, provider admission/delivery, Reply all, recipient
leases/leave, creator revival, and versioned portable state are implemented.
The earlier private-copy behavior remains available as an explicit compose choice.
See [protocol and rollout details](../spec/shared-conversations.md).
Conversation membership grants scoped delivery permission; it does not create
connections or infer transitive trust between participants.

### Compose, replies and audience

- [x] Make shared conversation the default when composing to multiple connections.
  Retain **Send private copies** as an explicit alternative.
- [x] Add **Reply** and **Reply all**, clearly showing the audience before sending.
  Reply all reaches authorized conversation participants even when they are not
  direct connections of the replying sender.
- [x] Keep private replies under direct-message authority. A conversation grant
  alone does not authorize a separate private exchange between non-connections.
  Do not automatically quote private replies into later shared messages.
- [x] Preserve existing private-copy batches and replies as private history; do
  not retroactively turn their local conversation grouping into shared membership.
- [x] Start with a fixed participant roster. Adding a participant creates a new
  conversation subject to normal admission rules, not an expansion of old grants.
  Do not automatically disclose prior history to newly introduced participants.

### Automatic admission and provider authorization

- [x] Add a disclosed global preference allowing connections to introduce shared
  conversations, with per-connection overrides. The agreed product default is on
  for accounts without a saved choice; preserve all explicit global and individual
  opt-outs. Explain this introduction policy to existing and new users at rollout.
  Settings → Shared conversations saves explicit global and per-connection choices;
  the default is on. Overrides bind to the exact connection ID/epoch, with null
  meaning inherit. Reconnection uses the global policy until a new override is set.
- [x] Admit recipients automatically according to those settings, without a manual
  Join/Accept step in the normal flow. A disallowed introduction must not authorize
  messages from the other participants.
- [x] Define signed fixed-roster conversation descriptors and creator-only revival
  requests in both codecs, with shared vectors and cross-object binding validation.
  See [shared conversation control objects](../spec/shared-conversations.md).
  Version 1 fixes roster policy, permits 3–101 members, bounds initial admission to
  7 days and revival requests to 24 hours; these windows are separate from leases.
- [x] Bind the descriptor to each initial signed message. Existing connections
  authorize the creator's initial deliveries; the creator's signature alone does
  not grant other participants access to a recipient.
- [x] Store a recipient-controlled grant scoped to the conversation and roster,
  with active/expired/left state and lease timestamps. Creating the conversation
  supplies the creator's own consent to receive participant replies.
- [x] Introduce versioned conversation envelope authorization and shared logical
  message identity while retaining single-recipient envelopes, unique delivery
  IDs, per-recipient body tokens and the existing durable delivery machinery.
  Keep reply-parent references separate from delivery authority.
- [x] On each delivery, verify the sender signature, participant membership,
  conversation/revision binding, current recipient grant, expiry and local policy.
  Conversation IDs are lookup keys, never bearer capabilities. Persist permission
  rather than requiring a new grant exchange or user approval for every reply.
- [x] Define authenticated admission acknowledgments and bounded pending delivery
  when a reply races the original introduction. Missing authority must not count
  as acceptance; preserve honest per-recipient delivery outcomes.
- [x] Define federation freshness, revocation barriers and retry semantics before
  body retrieval and final delivery. Carry grants, descriptors and relevant
  revocation/replay state through supported account migration.
- [x] Distinguish disconnecting a connection from leaving a conversation in
  authorization and UI. Existing conversation consent survives disconnect; Leave
  revokes it. There is no global sender-blocking feature yet.
- [ ] When global sender blocking is introduced, make its denial override shared
  permissions at admission, revival, body retrieval and final delivery.

### Recipient inactivity, leave and revival

- [x] Implement independent recipient leases rather than a single global
  conversation expiry. Use 24 calendar months from admission or the recipient's last
  qualifying activity as the personal-conversation default; keep the
  duration a stated policy rather than a hard-coded protocol constant.
- [x] Renew a recipient's lease when they open the conversation or send to everyone.
  Incoming messages, background fetching and bulk mark-read actions do not renew
  it. Coalesce activity writes where practical without weakening expiry rules.
- [x] Keep archive, content retention and delivery permission independent. Archiving
  does not revoke permission, and expired permission need not erase saved history.
- [x] Add **Leave conversation** to revoke local permission immediately while
  retaining readable history. Keep a compact left/revocation record rather than
  deleting all evidence and permitting replay-based readmission.
- [x] Allow only the original creator to **Revive conversation** after inactivity
  expiry. Send a fresh signed, short-lived, replay-protected revival request for
  the same conversation and fixed roster; an old descriptor cannot revive grants.
- [x] Automatically renew an expired recipient's grant only when the creator still
  has a qualifying active connection and that recipient's current global and
  per-connection settings permit the introduction. No manual acceptance is needed.
- [x] Never let creator revival re-add someone who manually left. Rejoining that
  conversation requires the recipient's explicit action.
- [x] Make repeated revival requests idempotent: replay must not repeatedly extend
  a lease. Revival must not reset still-active participants' inactivity clocks.
- [x] Show the creator a revival action with per-recipient status. It is available
  from retained shared history; only expired grants renew. Explain creator-only
  revival without revealing recipients' last-opened timestamps.
- [x] Report partial delivery honestly when some participants remain expired,
  have left or cannot be readmitted. If the creator is unavailable or no longer
  authorized, retain expiry; another participant may start a new conversation
  under normal admission rules, not take over revival authority.

### Storage, compatibility and verification

- [x] Add local introduction-preference storage and browser-session-only GET/POST
  `/api/v1/account/connections/conversation-preferences`, with Origin checks,
  account isolation, live-session and migration-fence checks, and strict inputs.
  Migration 0092 is additive; rollback refuses once choices have been retained.
  Apply it before deploying the new settings page. Migrations 0093–0096 supply shared authority and delivery; the settings page
  now describes live admission behavior.
- [x] Include introduction preferences and exact-epoch overrides in authenticated
  portable v7 / managed v8 snapshots, alongside grants, leave/replay state and
  terminal outboxes. Older snapshot formats remain readable.
- [x] Verify default allowance, preserved explicit allow/deny and inheritance, account isolation,
  stale/disconnected/reconnected overrides, session/Origin restrictions, persistence,
  migration fences, stale serving generations and empty/populated rollback behavior.
- [x] Separate immutable descriptors, compact per-recipient permission state and
  message history. Deduplicate descriptors within a provider where practical.
- [x] Define safe garbage collection after grant expiry and bounded retry/retention
  windows, including cleanup of unused descriptors. Replay receipts expire after request expiry plus five minutes. Leave/expired
  rows remain while retained protocol history references them; unused descriptors
  can be collected after the admission window. Total history retention remains
  a separate storage policy.
- [x] Require fresh authorized admission/revival after cleanup. Neither retained
  messages nor replayed signed descriptors may reconstruct active permission.
- [x] Specify schema and wire-version rollout, unsupported-peer behavior, migration
  and rollback boundaries. Do not silently downgrade shared sends to private
  copies or broaden existing connection/subscription authority.
- [ ] Complete the rollout adversarial matrix: verify same-provider and federated automatic admission, policy denial,
  non-connection reply-all, forged/replayed descriptors, roster substitution,
  admission races, expiry boundaries, recipient-only lease renewal, immediate
  leave, creator-only revival, replay-safe cleanup and portable revocation state.
- [x] Verify shared/private thread isolation and historical private copies; browser
  checks cover multi-recipient defaults, preserved private selection, Reply all
  without a connection (including own sent messages), leave/rejoin, expired-state
  controls, creator revival and mobile layout. Existing per-recipient status
  reporting remains intact; archive/read state does not revoke consent.

Implemented regression evidence: independent-provider Reply all between
non-connections; creator revival with renewed/left outcomes; same-provider policy
denial and admission races; expired Rejoin rejection; replay-stable leases;
private/shared thread separation; post-acceptance leave checks; cleanup without
readmission; atomic initial queueing; exact checkpoint validation; fresh and returning
provider consent reconstruction; empty rollback and populated rollback refusal.
The full 55-suite database regression run and focused reruns cover these changes;
codec, server/client unit tests, type checks, CLI tests and browser checks also run.
Follow-up hardening remains tracked in the broader adversarial matrix and future
global sender-blocking policy; organization authority is a separate future slice.

### Future organization and contractor authority

- [ ] Extend explicit scoped authority to organization relationships without
  treating trust as transitive. Define directional organization permissions;
  accepting messages from a partner does not imply reciprocal acceptance.
- [ ] Bind organizational authority to organization identity and current verified
  membership/delegation evidence. A domain address alone is not employment or
  delivery authorization.
- [ ] Define whether opting into a managed work account delegates communication
  policy to its organization, and disclose that scope. Personal accounts retain
  their own consent boundary.
- [ ] Support explicit contractor-DID guest permissions scoped to projects, teams
  or selected employees, optionally with a stated expiry. Require the contractor's
  corresponding consent; do not imply employment or organization-wide access.
