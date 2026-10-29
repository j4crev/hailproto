# Category Publishing — Controlled Alpha

## User Flow

`/compose` now publishes an update to a category, not individually selected
subscription recipients. General is selected by default when it has active
subscribers; otherwise the sender must choose a category explicitly. Categories
are derived from current received Grants, including collocated subscribers and
all eligible rows rather than the first account-API page. Legacy uncategorized
permissions are excluded.

The browser posts a stable publication ID, category, one plain/rich body and an
explicit reply-permission choice. It never sends a recipient selection. The
provider snapshots all currently authorized subscribers for that category in one
transaction. Later subscribers do not join a retry's audience; revoked or expired
permissions are not replaced with another Grant or category during fan-out.

The publication panel separates pending/submitted/blocked/cancelled/expired work
from actual accepted/delivered/failed/indeterminate delivery status. Finished
means fan-out work ended, not that everyone received or read the message.
Per-subscriber outcomes are private to the sender's account; signed federation
envelopes still contain exactly one recipient and an individual body capability.

Connection messaging uses a separate audience choice in the same composer.
The account message API and CLI also support explicit Grant/reply workflows;
category publishing does not expose individual subscription recipients.

## Account API

Existing account authentication, cookie Origin protection, rate limits and serving
generation admission apply. No new session scopes or credentials are issued.

| Operation | Required scope | Contract |
| --- | --- | --- |
| `GET /api/v1/account/publications/audiences` | `grants:read` | Category IDs, subscriber counts and alpha recipient limit; no recipient picker. |
| `POST /api/v1/account/publications` | `messages:write` | `{publicationId, category, text OR body, allowReplies}`; `202` means durable queue acceptance only. Unknown fields, including recipient/Grant selections, are rejected. |
| `GET /api/v1/account/publications` | `messages:read` | Up to 20 account-private publication links, unfinished work first, so a closed tab does not lose access to queued work. |
| `GET /api/v1/account/publications/:id` | `messages:read` | Frozen audience size, work/delivery counts and per-target outcomes; another account gets 404. |
| `POST /api/v1/account/publications/:id/cancel` | `messages:write` | Empty object; stop messages that have not yet been created. A busy worker returns 409 for safe retry. |

An ID is account-scoped and binds canonical body bytes, category and reply choice.
Exact retries reuse the stored audience and message IDs. Different content under
that ID returns 409. A lost browser acceptance response retains the original ID
and a status link rather than silently creating another publication. Replies
remain the existing one-time, seven-day capabilities, independently issued for
each subscriber; their deadline is fixed at publication admission, not retry time.

The publisher page also lists unfinished/recent publications. This is a bounded
alpha recovery view, not full archive search; older finished publications remain
available by their original IDs and their individual messages remain in Sent.

## Queue And Limits

Migration 61 adds `account_publications` and `publication_targets`. Immutable
intent, sealed audience membership and terminal target outcomes are retained.
The worker uses the existing body validation, envelope signing, submission,
receipt verification and recipient-side authorization paths. It retries transient
errors with the same message ID and bounded backoff, not a new envelope.

Current alpha ceilings are 100 recipients per publication, five unfinished
publications per account and a 24-hour creation/submission-attempt window. A
provider-wide advisory lock serializes one worker attempt and cancellation;
the runtime checks for work every five seconds. These are deliberate small-pilot
limits, not a bulk-publisher throughput claim. Higher volume needs measured worker
capacity/fenced leases and a reviewed retention policy, not merely raising the cap.

Cancellation cannot recall messages. A target with an already-created envelope
retains its exact submission retry, even when the response was lost; other pending
targets are cancelled. At the attempt deadline, never-created targets expire and
unconfirmed created targets become indeterminate. Existing Sent retry/status
interfaces remain available for those retained envelopes.

## Transfer, Upgrade And Rollback

Pending publication targets block provider migration fences and serving-generation
advances at the same account-row serialization point used by existing writers.
Finish or cancel work first; already-created retries must finish or reach their
deadline too. The existing transfer format then preserves signed envelopes,
bodies, capabilities and delivery status through its normal snapshot domain.
Publication grouping/history itself is provider-local and is not exported. It
must not be mistaken for portable authorization or permission to keep signing
after cutover.

The publication worker requires its schema and cutover guards. Coordinate code
and schema versions during deployment; enabling publishing does not enable
signup, custody or transfer gates.

Schema rollback is permitted only while publication tables are empty and no
later migration exists. Once intent is retained, preserve the tables/triggers
and finish/cancel pending work before an application-code rollback; older code
does not run this worker. Do not drop the cutover guard to force a transfer or
erase publication intent to allow replay under a new audience. No automatic
history pruning is introduced.
