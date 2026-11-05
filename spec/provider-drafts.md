# Reference-provider saved drafts

Drafts are authenticated, provider-local compose state. They are not envelopes,
are not delivered or signed, and confer no sending authority. The current alpha
JSON format below is distinct from body profiles: it preserves incomplete editor
input rather than a publishable document. No federation format changes.

## Account API

All paths are below `/api/v1/account`. Reads require `messages:read`; mutations
require `messages:write`. Both require a passkey-backed session. Standard account
session authentication, no-store responses and mutation same-origin checks apply.
Mutations require an active unfenced account with no migration in progress and
serialize on the owning account. IDs are lowercase UUIDv7. Other accounts cannot
read or mutate a draft using its ID.

| Method/path | Request | Response |
| --- | --- | --- |
| `GET /drafts` | Optional `after=UUIDv7`, `trash=true` | `{drafts: Draft[], next: UUIDv7 \| null}` |
| `GET /drafts/:id` | No query | One active `Draft`, or `404` |
| `POST /drafts/:id/save` | `{revision: integer, content: DraftContent}` | Saved `Draft` |
| `POST /drafts/:id/delete` | `{}` | `{state: "trashed" \| "deleted"}` |
| `POST /drafts/:id/restore` | `{}` | `{restored: 0 \| 1}` |

Lists contain up to 50 items in descending ID order (creation order). `after` is
an exclusive ID cursor. `trash=true` selects only live Trash; the default selects
only active drafts. Unknown or repeated query parameters and any other `trash`
value are invalid. Mutations require `application/json`, no Content-Encoding,
no duplicate or unknown object members, and at most 400,000 UTF-8 request bytes.
Invalid input is `400`, oversized input `413`, unsupported media `415`, and
unsupported methods `405`. Conflicting revisions, Trash state, accepted send IDs,
or migration return `409`; normal account authentication/scope failures apply.

`Draft` is `{id, revision, content, updatedAt, trashedAt}`. Dates are ISO 8601 UTC
strings; `trashedAt` is null for active drafts. A new draft requires revision 0
and is stored at revision 1. An update requires its current positive revision
and increments it. Delete and restore also increment the revision when changing
state. Saving a trashed draft is forbidden. A stale or ambiguously acknowledged
save requires refetching the draft; clients must retain local edits on failure.

`DraftContent` has these required fields (see the accompanying
[schema](schemas/provider-draft.json)):

- `audience`: `category` or `connections`.
- `category`: empty or `[a-z0-9][a-z0-9._-]{0,63}`.
- `connections`: up to 100 distinct UUIDv7 connection IDs.
- `title`, `text`, `alt`, `caption`: strings, bounded respectively to 128,
  65,536, 1,024 and 1,024 **UTF-8 bytes**. Empty strings are allowed.
- `allowReply`: boolean.
- `header`: null or unpadded base64url PNG data, at most 262,144 characters
  (192 KiB decoded); saving checks its PNG signature prefix. Full image/body
  validation remains mandatory at publication.
- `forward`: null or exactly `{sender: PLC DID, messageId: UUIDv7}`.

Category drafts require empty connections and null forward. Connection drafts
require empty category, false allowReply and null header. Saving does not require
active recipients, subscribers, nonempty text, or image alt text. Those are send
requirements. Forward drafts retain a reference to the account's original inbox
message; resuming/sending requires that source still be available. A draft does
not create a portable copy of the original message or its authority.

## Sending and Trash

Publication and connection-message creation accept optional `draftRevision`, a
positive integer. The publication ID is also the draft ID. For a new send whose
ID names a draft, the current revision and a passkey-backed session are required.
Acceptance checks and removes that active draft inside the publication transaction;
a failed transaction preserves it. A stale, deleted or trashed draft cannot be
sent by supplying an old revision. Accepted same-intent send retries use the
existing immutable publication record and do not require the consumed draft.
The send body contains the current editor input, which may include unsaved edits.
Saving a new draft using an already accepted send ID is rejected.

Deletion honors the current account Trash setting. With Trash enabled, the draft
is restorable for 30 days from its original removal; retrying deletion does not
extend retention. Restoring returns it to Drafts, not Inbox or Sent. Expired or
absent drafts restore zero items. Empty Trash, disabling Trash, and the existing
retention collector permanently remove applicable draft rows. With Trash disabled,
delete is permanent. Draft deletion does not touch delivered messages.

## Client and storage policy

The web client explicitly saves using **Save as Draft**; there is no automatic
background save. It restores fields, recipients, forwarding references and cover
images across signed-in devices. Unavailable recipients must not silently vanish
from a saved audience. Sending still validates current recipient authority.

Apply migration **0101_message_drafts** before this application release. It adds
`account_message_drafts` with account ownership and migration-fence protection.
Rollback drops saved drafts; back them up before a deliberate schema rollback.
Provider-to-provider draft transfer is unresolved: drafts are outside the current
account-history profile, like local mailbox preferences/dispositions. This API
synchronizes devices using the same account provider, not different providers.
No new envelope, body, or account-history version is implied.

Content conformance examples are in [provider-drafts vectors](vectors/provider-drafts.json).
Database and route tests additionally cover account isolation, concurrent saves,
atomic consume/rollback, Trash retention and authorization.

Optional `attachments` is an array of at most 20 metadata entries using the
[attachment declaration](attachments.md), in diagnostic JSON (base64url digest).
An empty draft array is permitted; omit it in a published body. The 25 MiB
aggregate limit applies to drafts too. File bytes are separately uploaded by the
owning account; draft metadata protects those editable upload references from
expiry until the draft is deleted. Full ownership and file validation is required
before send acceptance. Drafts themselves remain provider-local; migration
exports carry retained upload bytes but do not promise draft-editor migration.

## Structured builder drafts (current alpha)

Optional `builder` is exactly `{version: 1, body: Body}`; its draft version is
independent of `body.version` and its `spt-2`/`spt-3` profile. See the
[builder draft schema](schemas/content-builder-draft.json). `Body` MUST pass the
current body codec, including resource and bundled asset checks, with draft-only
exceptions: each `spt.image` block MAY have an empty `alt` string. All other
image description constraints remain unchanged. Publication MUST validate the
complete body, including a nonempty description for every image. A `cta` block
MAY retain a blank label (empty or ASCII whitespace) and a destination string of
up to 2048 UTF-8 bytes that is not yet a valid HTTPS URL. Every other CTA structural
and resource constraint still applies. These draft-only allowances MUST NOT
permit preview links, handoff or publication until the normal body validator
accepts them. Its diagnostic
JSON encoding MUST be at most 360,000 UTF-8 bytes. Attachments MUST remain in the
host's `attachments` field, not inside the builder body. An empty text block array
is permitted for an unfinished draft; sending still requires meaningful text under
reference-provider/client policy.

When `builder` is present, `title`, `text`, `alt`, and `caption` MUST be empty;
`header` and `forward` MUST be null. This prevents competing representations or
accidental Markdown conversion. Connection drafts permit only `spt-2` builder
bodies; category drafts permit `spt-2` and `spt-3`. Titles and image descriptions
live within the structured body. Unknown builder versions or fields are rejected.
Block/span editor keys are absent from the stored body; annotation keys remain
required and block-local under the body profile. Publication uses the validated
body directly with the existing audience, attachment, authorization and atomic
draft-consumption flow. No new signed body version or federation format is added.

Both compose editors save explicitly through **Save as Draft** into the account's
Drafts folder. The reusable builder does not autosave, read or write recovery
copies, offer bundle file import/export, or warn on navigation with unsaved edits.
New subscriber and connection messages use the structured builder. The client
converts supported simple-compose drafts on load using the existing formatting
semantics and retains their title, image bytes, caption and unfinished alt text.
Loading MUST NOT write a new revision. Only an explicit save replaces the simple
fields with `builder`, retaining the draft identity, audience and attachments.
Content that cannot pass draft validation remains in the original editor rather
than being silently dropped. Inline replies and forwards keep their existing flows.
These are client UI choices, not changes to the signed message formats. Existing
browser recovery records are ignored. The standalone demo's explicit save uses
its host's device-local store; it has no account Drafts folder.
