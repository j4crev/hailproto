# Shared conversation control objects

Status: Draft implementation. Both codecs, provider admission and durable grants,
version 4 delivery, the Reply all client, leave/expiry/revival, and authenticated
portable conversation checkpoints are implemented. A signed descriptor alone
never authorizes delivery. Existing envelope versions retain their meaning.

## Fixed roster descriptor

`hail.conversation` version 1 is an immutable proposal signed by the original
creator's `#hail-messaging` key. It uses deterministic Hail CBOR, tagged COSE_Sign1
and content type `application/hail-conversation+cbor`. Maximum signed size is
16384 bytes. The closed payload contains:

- `type`: `hail.conversation`.
- `version`: integer 1.
- `conversation_id`: fresh random UUIDv7, scoped to the creator DID.
- `from`: original creator DID and expected signer.
- `membership_revision`: integer 1. This profile supports a fixed roster only.
- `participants`: 3–101 distinct canonical DIDs, including `from`, sorted in
  ascending ASCII order. The limit allows a creator plus 100 recipients.
- `created_at`: nonnegative integer UTC Unix seconds.
- `admission_until`: UTC Unix seconds, strictly after `created_at` and at most
  604800 seconds (7 days) later.

The descriptor's version fixes the membership policy: adding anyone requires a
new conversation, and admission does not authorize disclosure of prior history.
Recipients control their own inactivity leases; the creator cannot prescribe or
extend those leases through this descriptor.

`admission_until` bounds initial introduction processing and replay retention. It
does **not** expire an admitted recipient's conversation grant. That grant has its
own local lease, with a provider policy of 24 calendar months from admission or qualifying
recipient activity. Codec validation is clock-independent so archived descriptors
remain decodable after their initial admission window.

The descriptor is bound to each initial delivery through envelope version 4. Before admission, a recipient provider must verify that binding,
the creator's signature and current authority, a qualifying active creator-to-
recipient connection, recipient membership and current introduction preferences.
The product default is enabled for an unset preference; explicit global and
per-connection opt-outs override it. A provider must not infer authority merely
from a valid descriptor signature, membership or knowledge of the conversation ID.

The immutable descriptor identity is `(from, conversation_id)`. Reusing that pair
with different signed bytes is a conflict, not an update. Retrying the exact
descriptor must not extend leases, recreate deleted grants, or override a leave.

## Creator-only revival request

`hail.conversation-revival` version 1 requests readmission of **one** expired
recipient. It uses the creator's `#hail-messaging` key, deterministic Hail CBOR,
tagged COSE_Sign1, content type `application/hail-conversation-revival+cbor` and a
16384-byte signed-size limit. Its closed payload contains:

- `type`: `hail.conversation-revival`.
- `version`: integer 1.
- `conversation_id`: the original descriptor's UUIDv7.
- `descriptor_hash`: a SHA-256 digest of the **complete original signed descriptor
  representation**, including its COSE wrapper, not just the payload bytes.
- `from`: original creator DID and expected signer.
- `to`: a distinct recipient DID from the original roster.
- `request_id`: fresh random UUIDv7 for this recipient's revival operation.
- `issued_at`: nonnegative integer UTC Unix seconds, no earlier than the original
  descriptor's `created_at`.
- `expires_at`: UTC Unix seconds, strictly after `issued_at` and at most 86400
  seconds (24 hours) later.

After verifying both signatures, receivers must check that the request binds the
creator, conversation ID, exact descriptor hash and recipient roster. Both codecs
provide a revival-binding validator for these cross-object checks. It does not
evaluate wall-clock freshness, replay state or delivery permission. A valid
signature by another roster member is insufficient. Historical descriptor
verification and current creator signing authority must remain distinct, so key
rotation does not require rewriting the original descriptor.

Provider revival behavior:

- Require a currently qualifying creator-to-recipient connection and current
  introduction preferences. Automatic policy admission needs no Join prompt.
- Renew only inactivity-expired participation. Active leases keep their existing
  clock; manually left participation requires explicit recipient rejoining.
- Check request validity against the receiver's clock. Allow at most 300 seconds of clock tolerance, as for initial admission.
- Persist `(from, request_id)` and the exact signed request digest with the outcome
  atomically. An exact retry returns that outcome without extending the lease
  again; conflicting bytes under that key are rejected.
- Retain replay evidence through request expiry plus 300 seconds. Retain compact
  leave evidence while saved envelopes or outbox history refer to it. Unknown or
  cleaned-up state cannot be recreated from an old descriptor or revival request.

Creator unavailability cannot transfer revival authority to another participant.
They can propose a new conversation under ordinary introduction policy instead.

## Envelope version 4 and delivery

Each recipient still gets a separately signed envelope, unique delivery ID and
body token. `authorization` has type `conversation`, creator DID, conversation
ID, membership revision 1 and the SHA-256 hash of the complete signed descriptor.
`conversation_message_id` identifies one logical message across its recipient
copies. The root logical ID equals the conversation ID. Reply parents refer to
logical IDs; they never confer delivery authority.

An initial envelope additionally carries `conversation_introduction`, containing
the signed descriptor and the exact creator-to-recipient connection ID and epoch.
Only the creator may send this form; it cannot carry a reply parent. Admission
verifies current creator authority, descriptor signature/hash/roster, recipient
service authority, exact live connection (including coordinator freshness), and
recipient introduction preferences under the account/connection write barriers.
Absent preferences default on. A repeated introduction never renews a lease or
undoes a leave. The creator stores its own permission when proposing the group.

Reply all uses the fixed roster. Both the sender provider and recipient provider
require their local active membership. The receiver rechecks permission before
body retrieval and atomically before final delivery. It verifies every sender's
current messaging signature independently. No B–C connection is created by an
A–B–C conversation. Disconnecting A does not itself revoke a conversation grant;
**Leave conversation** does. A global sender-blocking feature is not implemented;
when added, its denial must take precedence over all conversation permissions.

Authenticated existing delivery-status responses acknowledge admission/delivery.
A generic HTTP 202 is not acceptance. Shared outboxes retry the same immutable
signed envelope for up to the existing 24-hour batch deadline, including when a
reply arrives before another recipient's introduction. Verified asynchronous
status receipts also settle pending outboxes. Unconfirmed delivery remains
indeterminate at the deadline; there is no downgrade to private copies.

## Recipient lease and controls

The current provider policy grants 24 calendar months from admission. Opening
an active conversation or sending Reply all renews the local participant's lease;
activity writes coalesce within one hour. Incoming delivery, background work,
bulk mark-read, archiving and reading expired history do not renew it.

Leave immediately revokes incoming and outgoing shared authority while retaining
readable history. Explicit Rejoin applies only to a manually left conversation.
Inactivity-expired participation requires the original creator's signed revival;
another participant cannot revive it. The creator can renew its own expired
participation as part of that action. A creator who left must explicitly rejoin.

`/hail/connections/conversation-revival` carries the signed request and the exact
current connection ID/epoch over the existing safe provider transport. The
recipient verifies current signer/provider/coordinator authority and applies its
current introduction preferences. Outcomes are renewed, active, left or denied.
Only renewed extends a lease. Receipts bind request ID to exact signed bytes and
outcome atomically; replay cannot extend a lease again. The creator's durable
outbox retries for 24 hours and reports each outcome separately. One new revival
batch per conversation per 24 hours prevents unbounded repeated requests; the
same operation ID always retrieves the retained result. A fresh UI operation
within that window returns the existing batch so a page reload can recover status. Provider responses do
not themselves grant the sender any new authority.

The exact revival HTTP request, response and error shapes are defined in
[connection-wire.md](connection-wire.md#conversation-revival).

## Storage and account portability

Migrations 0092–0096 store preferences, immutable deduplicated descriptors,
compact memberships, replay receipts, v4 envelope metadata and immutable outboxes.
The maintenance loop removes expired replay receipts in bounded batches. It may
remove left/expired permission only after the descriptor admission window plus
clock tolerance and when no envelopes, outbox or replay records reference it.
Unreferenced descriptors can then be deleted. Saved protocol history retains its
small permission record even when body content has been deleted; this preserves
leave and revival semantics for long-lived threads. This is not a claim of
bounded total account storage: history/outbox archival limits remain separate.

Portable snapshots version 7 and managed snapshots version 8 include a separately
versioned `hail.conversation-history` checkpoint and digest. It carries explicit
default/connection overrides, descriptors and historical signing evidence,
active/expired/left membership, replay records, and terminal shared/revival
outboxes. Connection history uses its separate v3 checkpoint domain. Pending
revival must drain before fencing; pending sends retain the existing drain rule.
Imports validate exact ownership, signed descriptor linkage, roster and intent
hashes, current canonical PLC history and historical signing keys before activation.
Imports preserve expiry timestamps rather than issuing fresh leases. On return,
current source preferences and membership replace stale mutable destination
state; absent source membership cannot restore an old active grant. Same-provider
custody checkpoints also include conversation state and require drained work.

## Current profile and verification

Apply migrations before deploying the server/client. Providers and transfer CLIs
must understand envelope v4 and snapshot v7/v8 respectively. Earlier snapshot versions are outside the current alpha contract. Unsupported peers cannot accept shared delivery; recipients remain
unconfirmed and the sender sees bounded per-recipient results. Never silently
broaden connection/subscription permissions or reinterpret historical private
copies as shared messages. Rollback scripts refuse once the corresponding
conversation data exists; rollback runs in descending migration order, inside an explicit transaction.

Reply all also accepts an account’s own sent shared message as its source.
Private replies still require a direct connection. Shared and private threads
remain separate, and Reply all is offered only on shared source messages; private
history is never automatically quoted into the group.

`packages/hail-codec-ts/vectors/conversations-v1.json` contains immutable fixtures
for TypeScript and Go, including descriptors, revivals and v4 envelopes. Test keys
are public fixtures and must never be used by an account. Database tests exercise
same-provider and independent-provider messaging, policy denial, introduction
races, leave/expiry/revival, portable consent and rollback guards. The remaining
rollout checks and future organization work live in the
[implementation checklist](../docs/connection-messaging.md#shared-conversations-implementation-checklist).
