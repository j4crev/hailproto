# Subscriptions, connections and publishing

## Product model

- **Publish an update:** select General or a custom category. The provider snapshots
  authorized subscribers and delivers private copies through the durable outbox.
- **Send a message:** select explicit connections. Reciprocal subscriptions do not
  create a connection, and disconnecting does not revoke a separate subscription.
- Receivers classify messages from verified authorization, not sender-supplied labels.
  A category delivery does not prove every other subscriber received it.
- Campaign grouping may narrow an authorized audience; it cannot grant permission.

## General and custom categories

The browser profile editor always includes category ID `general`, label General,
with no editable description. It cannot be renamed or removed; up to 99 custom
categories can accompany it. Existing profiles normalize General on their next
explicit browser save, never on read. General reaches only its own subscribers.
This is a Haili product rule: credential-authorized profile APIs may omit General.

New subscriptions require named, offered categories and explicit recipient consent.
CLI, browser and shared provider services reject new uncategorized permissions.
Retained signed history remains readable/revocable; no connection is inferred from it.

See [browser permissions](browser-permissions.md) and [category publishing](category-publishing.md)
for approval, immutable audiences, retries, limits and cancellation.

## Connections

Connections begin through a shared QR/link and explicit scanner confirmation.
The creator's code supplies standing consent; there is no unsolicited invitation
folder or second creator approval. A personal code has no automatic expiry;
additional sharing codes may expire. Code expiry/revocation stops new admission,
not existing relationships. Publicly sharing a code allows authenticated holders
to connect. Code management and relationships live at `/connections`.

Managed and owner-controlled consent, local and remote admission, crossed-scan
convergence, signed disconnect, messaging and supported history transfers use the
shared coordinator model. A connection is not a category or two subscription Grants.
Pending synchronization is shown explicitly; old results cannot revive a disconnected
relationship. Reconnection requires fresh consent.

A committed provider move invalidates old share links and personal codes. Warn
before cutover and create fresh destination codes. Preparing or cancelling a move
does not revoke source codes. Preserve established connections, immutable consent,
messages and terminal/replay history. Unsupported records and undrained work block
transfer; cleanup must identify the affected records and preserve unrelated state.
See [connection messaging](connection-messaging.md) for current implementation behavior.

## Remaining product work

Persistent blocking, organization membership/delegation and organization-to-person
relationships require explicit authority rules. Corporate subscription publishing
does not depend on organization connections.

Forwarding and signed threaded replies exist. Subscription recommendations still
need recipient opt-in, and multiple replies under a fixed subscription permission
window need a separate protocol design; neither follows from connection admission.

Attachments remain deferred: the proposed starting formats are PDF, TXT and LOG,
download-only, with a proposed 25 MiB aggregate baseline and explicit advertised
limits. Authorization, digest binding, quotas, retention and rejection-before-upload
must be specified first. DOCX/XLSX are separate; macro-enabled files are not implicit.
See [attachment direction](content-storage-and-attachments.md#attachment-design-direction-not-implemented).

Publisher pilots should exercise real category needs such as receipts, order
updates and newsletters before expanding format or campaign features.
