# Hail browser client (alpha)

Svelte 5/SvelteKit 2 inbox and safe `spt-1`/`spt-2`/`spt-3` reader for
accounts at `haili.app`. Everyday use relies on provider passkey sessions and does
not store API credentials or Hail keys in browser JavaScript. The opt-in local
signup recovery preview below temporarily handles owner recovery material.

The [browser-client roadmap](../../docs/browser-client-roadmap.md) tracks its
incremental productization. The responsive teal client now covers the feed,
composer, message readers, Sent, sender permissions and security. The public home
does not show private folders. Private links consistently lead to passkey sign-in
and return to the requested screen; QR fragments remain browser-local and do not
authorize anything automatically. Connection and organization semantics are not
implemented.

New subscriptions select explicit categories, including General when offered,
through the normal passkey approval. Uncategorized subscription creation is no
longer supported; no migration command or conversion UI is needed. See
[the staged relationship changes](../../docs/subscriptions-and-connections.md).

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
  bun run --cwd apps/gui-poc dev --open
```

The HTTP commands above support GUI development after an account already has a
passkey. Initial owner-authorized enrollment requires an HTTPS provider/GUI origin;
use the enrollment link issued by account creation or `hailp account
passkey-recover` in that environment, then sign in at `/auth/login`. The legacy
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
the local “Show headers” preference can hide them without contacting senders.
The directory remains `apps/gui-poc` during the incremental migration; no package
or deployment path rename is required for this presentation work.
