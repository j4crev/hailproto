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

### “Deploy app to production” shorthand

When the user says **“deploy app to production”** (or equivalent), treat it as
authorization to complete this entire provider/web-client rollout for the current
task, without asking for confirmation again at each step:

1. Review the task's changes, run relevant local checks, and commit them on a
   feature branch. Preserve unrelated edits; include all current changes only
   when the user explicitly requests that scope.
2. Push the branch and create or update its PR targeting `main`.
3. Watch PR CI to completion. Diagnose and fix failures, push the fixes, and
   repeat until all applicable checks pass. Respect required reviews and branch
   protection; do not skip checks or bypass protections to release.
4. Merge the verified PR, then wait for successful main verification of the exact
   merged revision. If the work is already merged, start from this verification.
5. Manually dispatch `publish-provider.yml` on `main`, verify its exact `headSha`,
   and wait for the whole run to succeed. If `main` advances, review the additional
   changes rather than silently deploying a different revision.
6. Download `provider-release`, verify its commit and both immutable image
   digests, complete the production preflight, and deploy through the installed
   `hail-provider-ops` wrapper as specified in the rollout procedure.
7. Verify running image references, service health, public homepage/readiness,
   registration policy, database/Caddy uptime and rollback retention. Report the
   PR, publication run and deployed commit, or the precise blocker if unfinished.

The shorthand covers the application only, not the separately deployed monitor
or installation of privileged operations tooling. The constraints below and the
linked rollout procedure still apply.

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
