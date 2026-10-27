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

## Invited signup

`/signup` presents one screen at a time: address and security email, protection
terms, recovery save/verification, email verification, explicit publication, and
passkey creation/sign-in. Progress checks run automatically while activation is
pending, respecting retry delays and pausing after twelve attempts or a terminal
error. The user can resume with the same identity; retries never create new keys.

New signups download **one** `hail-recovery-package.json` and keep its random
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
Verified Sender Profile v2 avatars appear in the inbox and message reader with
initials as the fallback; avatar bytes are bundled and never loaded remotely.
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
senders. The preference stays in this browser, with an in-memory fallback when
storage is blocked.
The maintained browser client lives in `apps/client` (workspace package `hail-client`).

## Navigation and visual checks

The desktop sidebar and mobile modal drawer share their navigation. Inbox shows
subscription updates; Messages shows connection messages. Both have their own
navigation entry and no tabs. Messages has one New message action in its heading. The avatar
opens a native popover as the sole navigation to Account, Settings, Security and
Sign out; those pages have no cross-link cards. Both the
popover and drawer support outside-click and Escape dismissal; the drawer locks
background scrolling and restores focus when closed. Account details live at
`/account`; reading preferences live at `/settings`.

The browser wizard checks those interactions at desktop and mobile widths,
including direct homepage login, protected new routes, account-menu logout,
preference persistence and blocked browser storage. To save screenshots outside
the repository, set `HAIL_WIZARD_SCREENSHOTS=/tmp/hail-ui-review` when running
`test:wizard` (combine with `HAIL_WIZARD_MOBILE=true` for the mobile set).

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
