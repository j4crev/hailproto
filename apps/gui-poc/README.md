# Hail GUI proof of concept

Disposable Svelte 5/SvelteKit 2 inbox and safe `spt-1`/`spt-2`/`spt-3` reader for
an account at `haili.app`. It reuses the reference CLI's account client and does not
store credentials or keys in the browser.

```bash
bun install
HAIL_GUI_CREDENTIAL_FILE=/secure/canary/api.credential.json \
  bun run --cwd apps/gui-poc dev --open
```

The credential must belong to an account at `https://haili.app` and
include `account:read` and `messages:read`. `grants:read` adds verified sender
addresses; without it the inbox safely falls back to DIDs. Nothing private belongs in this
directory or in `.env` files committed to Git.

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
