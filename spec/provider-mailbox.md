# Reference-provider mailbox cleanup

This is reference-provider application policy and its authenticated account API,
not a federation operation or a new envelope format. Deleting a mailbox copy
never recalls a recipient's copy, revokes reply authority, cancels delivery, or
changes signed protocol evidence.

## Unread totals

`GET /api/v1/account/unread-counts` requires the authenticated account's
`messages:read` scope and accepts no query parameters. It returns JSON
`{ "subscriptions": 0, "connections": 0 }`, with nonnegative integer counts
across the entire mailbox, independent of pagination. Count only received,
unread, non-trashed delivered messages belonging to that account. Connection-
and shared-conversation-authorized messages contribute to `connections`; other
authorization types contribute to `subscriptions`. Count messages, not threads;
sent messages never contribute. Reading, marking unread, trashing, restoring,
and deleting affect subsequent totals. Invalid queries return `400`, unsupported
methods `405`, and missing scope `403`, using normal account authentication rules.

The client displays positive totals beside Feed (`subscriptions`) and Inbox
(`connections`), right-aligned, and hides zero or unavailable totals. This display
is client behavior, not a federation requirement.

## Folder actions

The passkey-authenticated account API requires `messages:write`, the existing
same-origin/CSRF checks, an active unfenced account and no in-progress migration
for every mutation below. Requests use `Content-Type: application/json`, no
content encoding, and exactly the members shown. Mutations serialize on the
owning account and never affect another account's mail.

| POST path under `/api/v1/account` | Body | Result |
| --- | --- | --- |
| `/trash/empty` | `{}` | `{deleted: number}`; permanently removes all received copies and saved drafts in Trash, and makes all sent Trash copies non-restorable |
| `/sent/clear` | `{trashEnabled: boolean, messages?: [{kind: "category" \| "connections" \| "message", messageId: UUIDv7}]}` | `{affected: number, state: "trashed" \| "deleted"}`; clears eligible selected Sent items, or all eligible Sent items across every page when `messages` is omitted |
| `/sent/restore` | `{kind: "category" \| "connections" \| "message", messageId: UUIDv7}` | `{restored: number}`; restores one live sent Trash item to Sent |

`trashEnabled` is the setting the user saw, not permission to override it. A
mismatch with the transaction's current account preference returns `409` without
changing mail. Invalid bodies return `400`; ordinary authentication, scope,
method, media-type and migration errors follow the other mailbox mutations.
Emptying or clearing an already-cleared folder succeeds with a zero count.

When supplied, `messages` must contain 1–100 objects with exactly `kind` and
`messageId`; invalid identities or extra members return `400`. Duplicate identities
count once. Unknown, other-account, already removed and active sends are skipped;
only newly removed items contribute to `affected`. An empty or null selection is
invalid and must never fall back to clearing the folder. The same preference check,
transaction and eligibility rules apply to selected and whole-folder cleanup.

A send is a sealed category publication, a sealed connection/shared-conversation
batch, or a standalone envelope, using the existing `(kind, messageId)` Sent
identity. It must have at least one submitted envelope to appear in Sent. It is
eligible for cleanup only when **every** target has a known terminal result:
submitted envelopes have `delivered`, `failed`, or `cancelled` delivery status;
non-submitted publication targets may be `blocked`, `cancelled`, or `expired`.
Pending targets, accepted/on-hold deliveries, absent delivery status and
indeterminate submissions keep the entire send active. A completed target in an
active batch cannot be cleared separately. Cleanup does not change worker state.

With Trash enabled, Sent copies become restorable for 30 days from the original
removal time. Retrying cleanup cannot extend that deadline. Restore after expiry
or permanent deletion returns zero. Disabling Trash immediately makes existing
received, sent and draft Trash non-restorable; future Sent cleanup deletes the mailbox
copy permanently. Sent copies removed from the mailbox also disappear from its
normal conversation views. Restoring a batch restores its constituent copies.

`GET /sent?include=sends&trash=true` lists live sent Trash using the existing Sent
pagination cursor. `GET /sent/:id?kind=K&trash=true` reads one live sent Trash
item; expired or permanently deleted copies return `404`. Duplicate/unknown
query parameters and `trash` values other than `true` are rejected. The normal
Sent list and message readers omit removed copies. Protocol delivery-status and
submission-retry APIs remain separate from mailbox visibility.

## Storage, transfer and rollout

`account_sent_dispositions` stores local mailbox disposition by account, send
kind and send ID. A row hides the send from normal views; its timestamp bounds
restore, and `deleted` prevents restore immediately. Permanent mailbox deletion
does **not** erase retained immutable publication bodies, signed envelopes,
delivery history or reply evidence. Those records serve distinct protocol
continuity purposes; this action is not a secure-erasure or storage-reclamation
API. Received mailbox copies use the existing received-body reference cleanup.

Like the existing UI-only preferences, these local dispositions are outside the
current [account-history profile](account-history.md). Provider migration is not
a promise to preserve folder cleanup state. A portable mailbox-disposition
representation remains an unresolved interoperability decision; no new history
format or schema is implied by this provider-local table.

Apply database migration 0100 before deploying readers or actions that use it.
It creates presentation state and read views without rewriting signed records.
Old application versions do not honor new dispositions, so enable the new UI
only with the matching provider release. Rollback refuses while disposition
rows exist, rather than resurrecting deleted mail; reconcile/export that state
explicitly before rolling back the schema. Application rollback alone does not
undo database state.

## Client behavior

Desktop folder headers offer an ellipsis menu. Mobile uses the same dimensions,
placement and theme colors as the compose button. Trash uses **Empty Trash**
and a trashcan with an X. Sent uses **Move all to Trash** and a down-arrow
trashcan when Trash is enabled, otherwise **Delete all** and the X icon.
Confirmation states the whole-folder scope, permanence or 30-day restore period,
and that active sends stay in Sent. It uses **Cancel** and **Confirm**. Empty
folders disable the action. Successful cleanup refreshes the folder without a
success banner; failures remain visible and retryable.

[Saved drafts](provider-drafts.md) also participate in Trash. Emptying Trash,
disabling Trash and expiration remove draft content permanently; restoration
returns them to Drafts. Migration 0101 adds this provider-local compose storage.
