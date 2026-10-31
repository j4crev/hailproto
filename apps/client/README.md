# Hail browser client (alpha)

Svelte 5/SvelteKit 2 inbox and safe `spt-1`/`spt-2`/`spt-3` reader for
accounts at `haili.app`. Everyday use relies on provider passkey sessions and does
not store API credentials or Hail keys in browser JavaScript. The opt-in local
signup recovery preview below temporarily handles owner recovery material.

The [browser-client roadmap](../../docs/browser-client-roadmap.md) tracks its
incremental productization. The responsive teal client now covers the feed,
composer, message readers, Sent, sender permissions, Account, Settings and security. The public home
does not show private folders. Private links consistently lead to passkey sign-in
and return to the requested screen. The homepage is the shared passkey sign-in screen, including fresh sign-in
for existing sessions. Validated `next` destinations return users to the requested
screen. QR fragments remain browser-local and do not
authorize anything automatically. Connection codes and existing connections live at `/connections`, separate from
passkey security. Organization semantics are not implemented.

New subscriptions select explicit categories, including General when offered,
through the normal passkey approval. Uncategorized subscription creation is no
longer supported; no migration command or conversion UI is needed. See
[the staged relationship changes](../../docs/subscriptions-and-connections.md).

## Account profile photo

Account supports uploading, replacing, and removing a public sender avatar with
fresh passkey verification. JPEG, PNG, and WebP files up to 10 MiB are decoded
locally, center-cropped, and re-encoded as PNG without original metadata. The
client reduces dimensions until the image fits the protocol's 32 KiB limit;
original photos are not uploaded. HEIC is not supported; export it as JPEG first.

The existing account profile API validates the image and saves it in the signed
v2 sender profile in PostgreSQL. No object storage credentials or database
migration are required. Profile revision checks prevent overwriting concurrent
edits. Removing a photo publishes a new profile without an avatar; historical
signed revisions and copies previously retrieved by other providers can remain.

## Invited signup

`/signup` presents one screen at a time: address and security email, protection
terms, recovery save/verification, email verification, explicit publication, and
passkey creation/sign-in. Progress checks run automatically while activation is
pending, respecting retry delays and pausing after twelve attempts or a terminal
error. The user can resume with the same identity; retries never create new keys.

New signups download **one** address-prefixed recovery package, such as
`j4_j4crev_com-hail-recovery-package.json`, and keep its random
secret separately. The package contains a DID-bound v1 vault, its exact signed
genesis, and encrypted temporary setup authority. Reopening the actual saved
package and entering the separately saved secret verifies it before publication.
Verification sends only a hash commitment; the publishable signature stays local
until the user confirms account creation. It remains the recovery backup after signup; no final replacement download is
needed. The browser never sends the secret or private keys to the provider.

Install provider migration 73 and the updated backend before deploying this UI.
Unverified preparations live in a separate draft table; only explicit backup
verification promotes them to registerable preparations. A database gate also
blocks older writers from promoting unverified new-format ceremonies. Existing
v1 pending setup files and legacy API signup remain supported. Resume retrieves
any exact operation already retained by the server before attempting to sign.

Encrypted browser state is a convenience, not the independent backup. A reload
before verification reopens at file verification; a cleared/new browser can use
the downloaded package. Before the first download, loss of both browser state
and secret requires provider assistance for the provisional reservation. Setup
capabilities still expire after 24 hours, and issued passkey enrollment after ten
minutes; these time limits do not expire the recovery keys. No automatic deletion
or reuse of expired reservations is introduced. Browser recovery of an already
completed account remains outside this signup flow.

The updated CLI can verify the package and extract its existing v1 vault offline
with `hailp vault import --file <package> --vault <output> --expected-did <did>`.
See the CLI README for private-file permissions. Recovery does not depend on
valid setup tokens or a reachable provider. During rollback, retain schema 73
and use compatible code; its down migration refuses to discard any new-format
ceremony or provisional draft.

`test:wizard` checks a single download, wrong-secret refusal, reload before
verification, clean-browser package resume, monitoring interruption, real virtual
WebAuthn enrollment/sign-in, and setup retirement. Run with
`HAIL_WIZARD_MOBILE=true` for mobile-width Chromium coverage.

## Local signup recovery preview

After building, run `HAIL_GUI_SIGNUP_PREVIEW=true` with the normal GUI environment
and open `/signup/recovery`. The preview generates the existing v1 encrypted
backup locally, asks users to save its random secret separately, and verifies
the actual saved file and secret. It creates no account, submits no PLC operation
and performs no post-signup account recovery import. It is disabled by default.
Clearing or closing the preview releases its references; JavaScript does not
guarantee secure erasure of strings, buffers or browser history snapshots.

`bun run test:browser` uses installed Chromium (`CHROMIUM` may override its path)
to exercise browser crypto, encrypted export verification and managed genesis
signing with network connections blocked by CSP. It is not a claim that Safari,
Firefox or mobile-device checks have passed. See the
[consumer signup plan](../../docs/public-authentication.md) for remaining gates.

After `bun run build`, `bun run test:wizard` exercises the built client through the
real provider GUI proxy using local API fixtures and virtual WebAuthn. Set
`HAIL_WIZARD_MOBILE=true` for the mobile-width run. It covers anonymous redirects,
safe return paths, expired-session QR continuity, messaging, permissions and fresh
passkey verification; it is not a real-device or production-federation claim.

## Run the messaging GUI

Styles use Tailwind CSS 4 through `@tailwindcss/vite`. Semantic color tokens,
global theme/base styles and shared `hail-card`/button utilities live in
`src/app.css`; route and reader styles use utilities in the Svelte markup.
Preflight is intentionally omitted to preserve existing heading and list behavior;
native controls have shared base styles. No PostCSS or separate Tailwind config
is needed.

```bash
bun install
PASSKEY_AUTH=true PASSKEY_ORIGIN=http://localhost:5173 PASSKEY_RP_ID=localhost \
  bun run --cwd apps/server dev
HAIL_GUI_API_ORIGIN=http://localhost:3000 HAIL_GUI_ORIGIN=http://localhost:5173 \
  bun run --cwd apps/client dev --open
```

The HTTP commands above support GUI development after an account already has a
passkey. Initial owner-authorized enrollment requires an HTTPS provider/GUI origin;
use the enrollment link issued by account creation or `hailp account
passkey-recover` in that environment, then sign in from the homepage. The legacy
`/auth/enroll/*` bootstrap credential proxy is disabled; setting
`HAIL_GUI_CREDENTIAL_FILE` does not enable passkey enrollment.
Production serves the GUI and reverse-proxies `/api` on one HTTPS origin, normally
`https://haili.app`, with RP ID `haili.app`. Set
`HAIL_GUI_CREDENTIAL_FALLBACK=true` only to restore the old fixed-account mode
during rollback. Nothing private belongs in this directory or committed `.env`
files.

The reader supports headings, blockquotes, captions, lists, basic decorators,
declared HTTPS links, and one bundled PNG header. Invited managed signup is
supported separately; post-signup browser recovery import, custody transitions
and general attachments remain unavailable.
Sender Profile v2 avatars appear in the inbox and message reader with initials
as the fallback. Photos load separately from the provider's authenticated
`/api/v1/account/senders/:did/avatar/image` endpoint after the page renders.
The current local profile takes precedence, including photo removal;
other senders use the last retained verified profile. This lookup performs no
external profile fetch or PLC verification, so identity-reader timeouts cannot
hold up navigation just to display a photo. Remote photos reflect the last
profile retained by normal verification flows; unknown photos show initials.
The browser fetches these PNGs only from its own provider, never from senders.
Deploy the provider and GUI together for this endpoint; an older provider yields
initials. No database migration is needed. Fresh profile verification remains
available for protocol operations that require it.
The compose route publishes plain or structured updates to all active subscribers
in a selected category, optionally with one bundled PNG header. General defaults
when available; there is no individual subscription-recipient picker. The provider
durably snapshots the audience and exposes refreshable work and delivery status.
See [category publishing](../../docs/category-publishing.md) for alpha limits,
cancellation and transfer/rollback boundaries. Rich mode provides selection-based bold, italic,
code and HTTPS-link controls, plus line-based headings, flat bullet/numbered lists
and quotes. Formatting shortcuts are documented in the composer; HTML remains
literal text. The preview uses the same safe body projection and renderer as
received/sent messages. Senders can invite one reply for seven days;
Inbox detail exposes a plain-text reply form only while that signed capability
is locally unused. It requires `grants:read` and `messages:write`.
The Sent view reads retained outbound messages and authenticated delivery status
with `messages:read`; authenticated accepted and delivered states are shown
without implying a read receipt, while missing receipts remain indeterminate.
Inbox and Sent use five-message batch pages instead of one body request per row.
Address labels come only from retained signed Grant consent evidence. Sent detail
explains hold and terminal failure reasons; only indeterminate submissions expose
an idempotent retry control.
The inbox presents messages as feed cards and shows bundled headers by default;
the “Show header images” switch in Settings can hide them without contacting
senders. The preference syncs to the account; browser storage is only a cache.
The maintained browser client lives in `apps/client` (workspace package `hail-client`).

## Navigation performance

The public Compose deployment uses `HAIL_GUI_API_ORIGIN=http://provider:3000`
for GUI-to-provider requests on the private Docker network. Public provider and
passkey origins stay HTTPS. The account client permits this exact internal
transport, in addition to HTTPS and local development; it never follows redirects.
No additional ports are published. Revert the transport to the public HTTPS
origin before rolling back to a client that does not support it.

Concurrent layout/page account reads share a promise within one GET request.
Nothing is cached across requests or during POST actions. Sender photos load
independently, and message readers use a sender-filtered subscription query.
Marking a message read invalidates mailbox data instead of reloading the reader
and its layout. Account and compose screens fetch independent data in parallel.

## Navigation and visual checks

The desktop sidebar and mobile modal drawer share their navigation. Feed shows
subscription updates; Inbox shows connection messages. Both have their own
navigation entry and no tabs. Desktop uses Compose in navigation. On mobile, Feed and Inbox also have a floating
compose button for subscribers and connections respectively; selection hides it. The circular account avatar
opens a native popover as the sole navigation to Account, Settings and
Sign out; those pages have no cross-link cards. Both the
popover and drawer support outside-click and Escape dismissal; the drawer locks
background scrolling and restores focus when closed. Account details live at
`/account`, including Sign-in & security for passkeys and active sessions. Old
`/settings/security` links redirect to `/account#security`; reading preferences
live at `/settings`.

The browser wizard checks those interactions at desktop and mobile widths,
including direct homepage login, protected new routes, account-menu logout,
account preference persistence and blocked browser storage. To save screenshots outside
the repository, set `HAIL_WIZARD_SCREENSHOTS=/tmp/hail-ui-review` when running
`test:wizard` (combine with `HAIL_WIZARD_MOBILE=true` for the mobile set).

Appearance in Settings offers System (default), Light and Dark. The cached
choice applies before hydration; System follows live OS changes through CSS.
Shared semantic colors cover icons, text, controls and charts, while QR codes
retain black-on-white rendering. Appearance and header-image preferences sync to
account storage on navigation and window focus, and save even if browser storage
is blocked. The first browser seeds unset account preferences from its existing
choices; later browsers use account values. Failed saves retain the last confirmed
selection and show an error. The local cache records its account owner so another
account cannot inherit those choices during initialization.

Deploy migration 85 and the provider runtime before the client. The additive
columns preserve Trash and allow older clients to continue updating it. Roll back
the client and provider first; export display preferences before using the schema
rollback if those values need to be restored. Preferences remain provider-local,
like Trash, rather than transferring between providers.
After building, run `HAIL_WIZARD_THEME_ONLY=true bun run test:wizard` for focused
appearance checks (add `HAIL_WIZARD_MOBILE=true` for mobile). Unit preference and
contrast checks run with `bun run test src/lib/theme.test.ts`.

## Subscriptions and publishing categories

Subscriptions retains `/permissions` so existing sender links and QR codes keep
working. It manages incoming subscriptions only. `/categories` is the publishing
home: create a Sender Profile, edit its public name and description, add or remove
categories, and share a sender QR or subscription link after the profile exists.
General is built-in and fixed (ID `general`, label `General`, no description).
Browser saves add or normalize it without changing existing subscriptions; up to
99 custom categories remain editable. API clients retain optional General.
Published category IDs stay fixed; category removal does not revoke old Grants.
Existing profile versions, avatars, and legacy uncategorized settings are retained.

Every browser save verifies a passkey and sends the revision the editor loaded.
Conflicts retain the draft and require loading the latest profile; uncertain saves
can retry the same definition through the provider's existing idempotent save.
The provider allows this specific write for same-origin passkey sessions verified
within five minutes, without adding `account:write` to browser sessions. Deploy
both the GUI and provider change for browser publishing; older providers reject
browser profile writes with 403. No schema migration is needed.

## Trash and deletion

Feed and Inbox cards and readers offer **Delete message**. Trash is enabled
by default and retains a message for 30 days from its first deletion, regardless
of its original age. Repeated deletion does not extend retention. In **Trash**,
select one or more messages (or the current page) and choose **Restore selected**;
the original subscription/connection classification sends each back to Inbox or
Messages. Expired messages cannot be restored.

**Settings → Use Trash** is saved to the provider account, alongside appearance
and header-image preferences. Disabling it requires confirmation, immediately purges existing
Trash, and makes subsequent deletions permanent. This removes the recipient's
message and unreferenced recipient body bytes, not another account's Sent copy.
Delivery receipts and replay protection remain. Encrypted operational backups
follow the provider's separate backup retention policy.

Deploy provider migration 76 and its runtime before the client. The server runs
expiration cleanup at startup and every minute, in bounded batches; account
transfer fences defer cleanup until the account is writable. `trashed_at` travels
with delivered-message snapshots between compatible providers. The Use Trash
preference is provider-local and defaults on at a new provider.

Keep schema 76 and compatible application code during rollback. Older runtimes
do not filter trashed messages. Schema rollback refuses while Trash contains
messages or any account has Trash disabled; never silently restore those messages
just to roll back. Permanent deletions cannot be undone by application rollback.

## Connection address changes

After a connection completes a verified provider move, the shared address label
can show a seven-day hover/focus notice: “Their address changed from X to Y”.
This is automatic, with no Settings control or CLI notification command.
Subscription-only relationships do not receive notices. Identity-conflict
warnings take precedence. See [details](../../docs/contact-identity-notices.md).

## Appearance review with fictional data

Run `bun run --cwd apps/client preview:design` from the repository root, then open
`http://localhost:4173`. This builds the real client and starts a loopback-only
fixture provider with subscription artwork, connection messages, a sent message,
subscriptions and a sender profile. It needs no passkey or production credentials.
Use `HAIL_DESIGN_PORT` to choose another port. Stop with Ctrl+C.

Reading, read/unread selection, Trash/restore and appearance preferences work in
memory and reset on restart. Sending, profile changes, account deletion and
passkey operations are intentionally unavailable in this visual fixture. The
normal browser wizard separately tests those supported production workflows
with virtual WebAuthn. Never expose the unauthenticated fixture server publicly.

The client bundles Inter 4.1 from `rsms/inter` (OFL license in `static/fonts`).
Feed keeps bounded, uncropped subscription images; Inbox, Sent and Trash use
compact thumbnails and inline sender, subject/preview, and date columns on desktop
(1024px and up), returning to stacked rows on smaller screens. Sender/recipient
details show selectable DIDs directly beneath the address. The shared
shell uses the existing navigation icons; Account and Settings remain in the avatar menu.
Dark mode uses neutral charcoal surfaces with teal accents.

Connection Inbox groups conversations before pagination and orders them by latest
activity. A row displays the oldest unread message, or the latest message when all
are read. Counts above one include all unread received messages in that conversation.
Selection applies to the conversation's received messages; sent messages are never
marked unread or deleted through Inbox selection.

The conversation reader uses Inbox-style rows, newest first, with one expanded
body. Only opening a received message marks it read. Entry shows two newer rows
above the selected message when available. Scrolling toward the top loads newer
summary rows automatically in batches of 30, preserving the visible position;
bodies load only when opened. A retry button appears if loading fails. Older rows
remain available through the Older messages control. The subject appears once as the page heading, beneath the Inbox link; repeated
subjects are omitted from rows. A genuinely different message subject remains
visible. Expanded headers show the sender, DID, timestamp, and actions above a
left-aligned reading column. Mark unread collapses that message in place, leaving
all messages closed until the reader chooses one again. Replies remain
private to the selected connection; this is not a group messaging protocol.

The provider joins explicit connection reply links and its own recorded
multi-recipient send targets. Copies of the original send appear once with their
recipient list. Subscription Feed and its reply-capability threads are unchanged.
No schema migration is needed; deploy client and provider together. Grouping reads
account-scoped envelope metadata before selecting a page; bodies are loaded only
for the resulting page. For very large mailboxes, a persisted conversation index
would avoid repeating that metadata scan. Grouping relies on retained local batch
records; it does not infer shared sends from body text, subjects, or timestamps.

Run `bun run --cwd apps/client test:conversations` to verify grouped multi-sender
replies, initial expansion, read transitions, and mobile layouts against a separate
loopback fixture. `CHROMIUM` selects the browser executable. The regular browser
wizard also exercises replying from the new reader and grouped Inbox selection.

Account deletion lives below the Account security controls, with the existing
typed-address confirmation and provider-side recent-passkey requirement. Settings
contains appearance, header-image, and Trash preferences.

New header-image uploads are offered only for subscriber publications. Connection
composition supports plain and rich text; switching to Connections clears a draft
header image. The browser form handler also rejects new header uploads for
connections. Existing message images remain readable, and forwarding preserves
the original message content, including its image.

Browser session lifetimes are controlled by the provider, not the GUI. Set
`PASSKEY_SESSION_IDLE_SECONDS` (default `1800`) and
`PASSKEY_SESSION_ABSOLUTE_SECONDS` (default `43200`) in the provider environment;
see [browser session configuration](../server/README.md#browser-session-lifetimes)
for validation and rollout behavior. Fresh-passkey windows remain 5 minutes for
personal account security and 10 minutes for provider-admin changes.
