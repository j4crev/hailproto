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
tests use real envelope/body/status handlers for mixed native/federated multi-send,
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

The local implementation embeds the shared version-1 connection-history checkpoint
in portable v5 / managed v6 snapshots, retains it inertly on import, and verifies
source/destination/peer handover preparations. Live handover commit and historical
authority verification remain gated; see [portability progress](../spec/connection-portability.md).
Connection-bearing account cutover is still blocked.
