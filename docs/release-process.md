# Release verification and publication

Use [production readiness](production-readiness.md) to track outstanding gates.
A green build is necessary, but does not replace browser/device or operator
recovery evidence. Preserve the operator-selected registration policy during
application releases; the current production policy is public (confirmed 2026-10-31).

## Local database integration

Install the pinned workspace dependencies, build the codec and native CLI, and
provide a **disposable** PostgreSQL 18 instance with CREATE DATABASE privileges:

```bash
bun run --cwd packages/hail-codec-ts build
(cd apps/cli && cargo build --locked)
export DATABASE_TEST_ADMIN_URL='postgresql://postgres:TEST_PASSWORD@127.0.0.1:5432/postgres'
bun run test:integration
```

The runner creates randomly named source and target databases per test file and
drops only those databases afterward. The monitor receives its own fresh database.
Do not use a production PostgreSQL instance. No hosted accounts are needed.
Optional arguments select file-path substrings, for example:

```bash
bun run test:integration account-api.integration monitor.integration
```

Missing configuration, no matching suites, failing tests and skipped/todo tests
are failures. CI executes the whole inventory against the current schema, including authority,
retention, restart and provider-transfer fixtures. Unreleased historical schemas
are not supported upgrade baselines. Ordinary workspace tests may still omit database integration locally;
the explicit integration command is the mandatory release gate.

If the runner is forcibly killed, its `hail_test_<random>_*` databases can remain
on that disposable instance. Destroy the test instance after use. Failed suites
must be investigated; do not replace assertions with skips to publish a release.

## CLI documentation and version checks

```bash
python3 apps/cli/scripts/generate-reference.py
python3 apps/cli/scripts/generate-reference.py --check
python3 apps/cli/scripts/check-release.py --binary apps/cli/target/debug/hailp
```

The reference generator reads commands and parser-required flags from Rust source.
Edit option explanations in the generator and task recipes in `apps/cli/docs`.
Both ordinary CI and the release workflow check freshness and version agreement.

## Release candidate

1. Select the exact commit and update both `apps/cli/Cargo.toml` and
   `apps/cli/package.json`. Refresh Cargo.lock if Cargo changes the package record.
2. Record user-visible changes, compatibility boundaries, migration steps and
   known limitations in reviewed release notes. Automatically generated commit
   lists alone do not explain data-format or operator changes.
3. Run the complete CI workflow, including database integration. The release
   workflow calls the same CI workflow on the release revision before packaging.
4. Validate the packaged Linux binary on every promised distribution. Record
   architecture, OS/glibc, CLI version and basic login/read results. Test the
   actual archive/checksum, not only a source checkout.
5. Review upgrade and recovery evidence. Confirm that incompatible migrations
   have an explicit roll-forward or restore procedure; image rollback preserves
   the database and cannot reverse its schema.
6. Confirm required branch/tag protections and who can publish releases. These
   are repository-host settings, not established by workflow YAML alone.

## Publication

Only after the release gates pass, create/push the reviewed `vX.Y.Z` tag matching
both manifests. The release workflow publishes the archive and SHA-256 checksum
through GitHub Releases. A manual workflow dispatch verifies/builds artifacts but
does not publish a release from a branch. Inspect the resulting release and amend
its notes with the reviewed compatibility and upgrade information.

Follow the [download instructions](../apps/cli/docs/cli-installation.md) from a
clean machine, verify the checksum and reported version, then exercise the
[read-only quickstart](../apps/cli/docs/cli-quickstart.md) with a dedicated account.
Update the first-release availability note in the installation guide only after
that download succeeds. Signed provenance and a qualified Linux baseline remain
separate checklist items.

## Stable-release policy decision

Before external users depend on stability, replace the pre-launch reset policy
in `haili-operations.md`. The decision must state which versions are supported,
what API/file-format changes are compatible, how users learn about breaking
changes, and how their accounts, keys and accepted messages survive upgrades.
This document does not silently change the current pre-launch policy or promise
an untested migration/rollback path.

## Provider and GUI images

Run the **Publish provider image** GitHub Actions workflow against `main` at the
reviewed commit. It runs the complete reusable CI gate first, then builds and
pushes `ghcr.io/j4crev/hailproto/provider:sha-<commit>`. Publication is manual;
ordinary pushes and pull requests do not deploy or publish an application image.
The publish job produces a `provider-release` artifact and job summary with the
full commit and **digest reference**. Use that digest, never resolve the mutable
commit tag during deployment. The initial target is Linux amd64 only.

Both CI image verification and publication use an isolated BuildKit container
with a 4 GiB memory limit, no additional swap, and at most two concurrent build
steps. Node's 512 MiB old-space setting is not a total build memory limit. These
limits belong on a CI runner with adequate headroom, not on the 2 GiB production
host. BuildKit driver limits are documented by
[Docker](https://docs.docker.com/build/builders/drivers/docker-container/).

Before the first rollout:

1. Confirm the workflow passed for the exact revision. Review its source and
   published digest. GHCR publication needs Actions `packages: write`; if the
   package already exists, grant this repository Actions access to it.
2. Ensure the production Docker client can pull that package. Use public package
   access or an operator-provisioned, read-only registry credential. Do not put
   credentials in Git, command arguments or the release artifact.
3. Install the reviewed `apps/server/deploy/public/provider-ops.sh` as
   `/usr/local/sbin/hail-provider-ops` and `backup.sh` as
   `/usr/local/sbin/hail-provider-backup` through the operator's privileged
   session, retaining the previous copies. Updating the checkout does not update
   these installed scripts. Do this **before** invoking deploy; the old wrapper
   still builds on production. Confirm checksums against the reviewed files.
4. Keep the existing `.env`, PostgreSQL overlay and data volumes. Confirm the
   backup/restore prerequisite and migration rollback compatibility for this
   release. Install no new database or volume as part of the image transition.

Run the command recorded in the workflow summary, for example:

```bash
sudo /usr/local/sbin/hail-provider-ops deploy FULL_COMMIT_SHA ghcr.io/j4crev/hailproto/provider@sha256:FULL_IMAGE_DIGEST
```

The wrapper rejects tags, pulls the digest before changing the running release,
and requires its OCI revision label to match the requested commit. Digest
selection plus the trusted workflow is the current trust model; the revision
label alone is not signature verification. CI emits provenance/SBOM metadata,
but cryptographic deployment-policy enforcement is not implemented here.

The wrapper retains and verifies the previous running image, selects the new
image for **both** GUI and provider in `/etc/hail-provider-release/compose.json`,
and runs Compose with `--no-build --pull never --no-deps`. It waits for both
services and public readiness. PostgreSQL/Caddy are not recreated. On failure it
restores the prior checkout and retained image without a build or registry pull.
The command still exits unsuccessfully so failure remains visible. Manual
`hail-provider-ops rollback` uses the same retained-image path. Application
rollback never reverses database migrations or restores older database contents.

Preserve `compose.json` with the deployment configuration; encrypted provider
backups include it as `release-compose.json`. Restore it to that path alongside
the database overlay, and retain/pull the recorded image before starting services.
Inspect service health, container restart/OOM counters, PostgreSQL logs and host
memory after rollout. Record that no build process ran on production. This
removes build-induced contention; it does not claim zero restart downtime or
prove adequate memory for every runtime load.
