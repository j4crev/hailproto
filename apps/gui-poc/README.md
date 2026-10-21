# Hail GUI proof of concept

Disposable Svelte 5/SvelteKit 2 inbox and safe `spt-1`/`spt-2` reader for
`canary@haili.app`. It reuses the reference CLI's account client and does not
store credentials or keys in the browser.

```bash
bun install
HAIL_GUI_CREDENTIAL_FILE=/secure/canary/api.credential.json \
  bun run --cwd apps/gui-poc dev --open
```

The credential must belong to `canary@haili.app` at `https://haili.app` and
include `account:read` and `messages:read`. `grants:read` adds verified sender
addresses; without it the inbox safely falls back to DIDs. Nothing private belongs in this
directory or in `.env` files committed to Git.

The reader supports the first bounded rich-text slice: headings, blockquotes,
captions, lists, basic decorators, and declared HTTPS links. This slice still
excludes sending UI, onboarding, vault operations, managed custody, and assets.
Delete `apps/gui-poc` and reinstall dependencies
to remove it.
