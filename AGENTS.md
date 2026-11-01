# Repository agent guidance

## Production provider/GUI releases

Read [the routine rollout procedure](docs/release-process.md#routine-production-rollout--operators-and-agents)
and [production operations](docs/haili-operations.md) before deployment work.

- Never build Docker images, run Vite, or package adapter-node on the live provider.
  Publish with `.github/workflows/publish-provider.yml` on GitHub Actions.
- Deploy only the exact commit and both image digests from a successful publication run,
  using the installed `hail-provider-ops deploy COMMIT PROVIDER@sha256:DIGEST CLIENT@sha256:DIGEST` wrapper.
  The split requires reviewed installation of the updated operations/backup wrappers
  before deployment; the old single-image wrapper cannot deploy it correctly.
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
in [production operations](docs/haili-operations.md#pre-launch-development-policy--developers-and-agents).
