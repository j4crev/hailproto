# Hail GUI proof of concept

Disposable Svelte 5/SvelteKit 2 inbox and safe `spt-1`/`spt-2`/`spt-3` reader for
accounts at `haili.app`. It uses provider passkey sessions and does not store API
credentials or Hail keys in browser JavaScript.

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
declared HTTPS links, and one bundled PNG header. This slice still excludes
onboarding, vault operations, custody transitions, and general attachments.
Verified Sender Profile v2 avatars appear in the inbox and message reader with
initials as the fallback; avatar bytes are bundled and never loaded remotely.
The compose route sends plain or structured heading/body messages through an
active categorized Grant, optionally with one bundled PNG header, and displays
refreshable delivery status. Rich mode provides selection-based bold, italic,
code, and HTTPS-link controls. Senders can invite one reply for seven days;
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
Delete `apps/gui-poc` and reinstall dependencies
to remove it.
