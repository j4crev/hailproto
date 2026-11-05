# Repository agent guidance

## Local UI previews

For a local appearance review, use `bun run --cwd apps/client preview:design`
from the repository root and open `http://localhost:4173`. This builds the current
client and starts the loopback-only fictional provider/account fixture, with no
login or production credentials. Set `HAIL_DESIGN_PORT` for a different port.
See [appearance review instructions](apps/client/README.md#appearance-review-with-fictional-data).

Do not use bare `bun run --cwd apps/client dev --port 4173` for this workflow.
Vite can report ready while every page fails with
`Set HAIL_WEB_CLIENT_PROVIDER to the provider HTTPS origin`. Normal dev mode
requires a deliberately configured provider and matching origin/auth settings;
setting a placeholder provider alone does not create a usable mailbox preview.

Before reporting a preview ready, wait for the build and app startup, then verify
an HTTP request to the requested page succeeds and renders the expected UI, not
an error page. Stop only the previous preview process you own if the port is
occupied. Keep the fixture loopback-only. Its in-memory changes reset on restart;
rerun `preview:design` after code changes because it serves a built client without
hot reload. Reading, selection and Trash/restore work; sending and account/passkey
changes are intentionally unavailable.

## Keep the protocol specification current

Prioritize keeping `spec/` synchronized with protocol additions, removals and
modifications in the same change. Update affected schemas, wire formats,
authorization/state-transition rules, version inventories and conformance vectors;
do not leave server code as the only definition of interoperable behavior.
Distinguish protocol requirements from reference-provider policy and client/UI
behavior. Specify the latest intended alpha formats without promising backward
compatibility; retain a format only when it serves a current, distinct purpose.
Record unresolved interoperability decisions explicitly rather than implying that
implementation notes constitute a complete standard. See [the spec index](spec/README.md).

## Production provider/GUI releases

Read [the routine rollout procedure](agents/release-process.md#routine-production-rollout--operators-and-agents)
and [production operations](agents/haili-operations.md) before deployment work.

- Never build Docker images, run Vite, or package adapter-node on the live provider.
  Publish with `.github/workflows/publish-provider.yml` on GitHub Actions.
- Deploy only the exact commit and both image digests from a successful publication run,
  using the installed `hail-provider-ops deploy COMMIT PROVIDER@sha256:DIGEST CLIENT@sha256:DIGEST` wrapper.
  A Git push alone neither publishes an image nor deploys production.
- Preserve the image-selection and PostgreSQL overlays, existing database volumes,
  retained rollback images and rollback record. Application rollback is not database rollback.
- Installed root-owned wrappers are independent of the Git checkout. Updating their
  source requires separate reviewed installation through existing privileged access;
  do not broaden sudo or SSH policy to perform it.
- Public registration is intentional (confirmed 2026-10-31). Preserve the operator's
  current registration policy during application releases.
- The monitor is a separate deployment and is not covered by the provider image workflow.
- Preserve other agents' uncommitted edits; stage only your task's files or hunks.

The project remains pre-launch. Follow the current-design/data compatibility policy
in [production operations](agents/haili-operations.md#pre-launch-development-policy--developers-and-agents).
