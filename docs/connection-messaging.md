# Connection Messaging — Deployed Preview

Deployed on Haili October 25, 2026 as `3391d82`; see
[deployment receipts](haili-launch.md) for backup and verification boundaries.

This slice reuses the signed Envelope, immutable detached bodies, body-token
retrieval, delivery/status pipeline, rich composer, reader and bounded outbound
worker. No alternative messaging protocol or new dependency was added.

## Authorization And Delivery

Envelope **version 2** carries only
`{"type":"connection","connection_id":"<UUIDv7>","epoch":<positive integer>}`.
Version 1 subscriptions/replies and every existing signed v0 vector are unchanged.
No category is sent, General is not overloaded, and no independent reply capability
is minted. Normal provider-held messaging keys sign messages for both custody modes;
an owner does not need to unlock the identity/recovery key for each ordinary message.

One shared local permission predicate binds both DIDs, ID, epoch, serving generation,
fences and disconnect tombstones. Native connections use epoch 1 and new IDs on
reconnect; federation uses the existing canonical epoch. Sender creation and every
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
  existing inbox/reader for connection messages. A received connection message offers
  **Message this connection**, not a single-use reply form. Disconnected history is
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

## Portable Export — Approved Next Slice

Portable export remains blocked, not silently enabled by messaging. It will extend
the existing account-transfer snapshots, checkpoint verification and fenced cutover,
not add a separate backup/download scheme. Preserve original signed envelopes,
connections, receipts, canonical IDs/epochs and terminal history. Version-one cutover
should settle unfinished network work before moving ownership, then prove that only
the destination can continue it. A coordinator move must continue its checkpointed
epoch; a local connection becoming remote must retain its identity.

**Approved QR policy:** old shareable links and QR codes stop working when the move
is committed, including the personal never-expiring code. Warn explicitly before
cutover. Preserve revoked invitation history but do not port active share tokens or
promise forwarding/old-link continuity. The user creates fresh identity-authorized
codes at the destination after activation. Preparing/reviewing a move alone should
not invalidate codes. Existing connections and disconnect/replay protection remain
intact; no guard is removed until snapshot/import and peer handover prove that.

The local implementation embeds the shared version-3 connection-history checkpoint
in portable v5 / managed v6 snapshots, retains it inertly on import, and verifies
source/destination/peer handover preparations. Import/handover staging verifies
historical consent and control signatures against retained canonical PLC history.
Unsupported pre-launch records should be explicitly cleaned up rather than given
a legacy reconciliation layer; see the [development policy](../README.md#pre-launch-development-policy--developers-and-agents).
Both deployed completion paths orchestrate supported connection-bearing moves;
missing orchestration, obsolete records and undrained work fail closed. Public
rollout verification remains; see [portability progress](../spec/connection-portability.md).

## One Connection Model (Deployed October 26, 2026)

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
