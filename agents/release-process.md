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
bun scripts/export-account-history-schema.ts --check
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
python3 apps/cli/scripts/check-release.py --binary apps/cli/target/debug/racr
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
4. Validate the packaged Linux binary on every promised distribution. The release
   job builds on Ubuntu 22.04 and runs the exact archive on clean Ubuntu 22.04
   and 24.04 containers before attesting it. Record
   architecture, OS/glibc, CLI version and basic login/read results. Test the
   actual archive/checksum, not only a source checkout.
5. Review upgrade and recovery evidence. Confirm that incompatible migrations
   have an explicit roll-forward or restore procedure; image rollback preserves
   the database and cannot reverse its schema.
6. Confirm required branch/tag protections and who can publish releases. Active
   rules require PRs, resolved review threads and up-to-date GitHub Actions
   `verify` checks for `main`, with no bypass actors. No second-person approval is
   required while there is only one collaborator. `v*` tags cannot be updated,
   force-pushed or deleted; repository writers can create them. These are host
   settings, not established by workflow YAML alone. Inspect the current rules
   before release rather than assuming this record is still current.

## Publication

Only after the release gates pass, create/push the reviewed `vX.Y.Z` tag matching
both manifests. The release workflow publishes the archive and SHA-256 checksum
and signed provenance bundle through GitHub Releases, marked as a prerelease
while the pre-launch policy remains active. A manual workflow dispatch verifies
and builds artifacts but does not publish a release from a branch. Inspect the resulting release and amend
its notes with the reviewed compatibility and upgrade information.

Follow the [download instructions](../apps/cli/docs/cli-installation.md) from a
clean machine, verify checksum and provenance before execution, check the version,
then exercise the
[read-only quickstart](../apps/cli/docs/cli-quickstart.md) with a dedicated account.
Update the first-release availability note in the installation guide only after
that download succeeds. Save the run, commit, archive digest, attestation result,
OS/glibc and quickstart results. The workflow verifies the attestation's repository,
signer workflow, source ref and exact commit before uploading or publishing assets.
An attested manual-dispatch artifact is not a tagged release: consumers must
require the selected `refs/tags/vX.Y.Z`. Hosted qualification and first downloaded
release acceptance remain separate evidence gates.

## Stable-release policy decision

Before external users depend on stability, replace the pre-launch reset policy
in [Haili operations](haili-operations.md). The decision must state which versions are supported,
what API/file-format changes are compatible, how users learn about breaking
changes, and how their accounts, keys and accepted messages survive upgrades.
This document does not silently change the current pre-launch policy or promise
an untested migration/rollback path.

## Provider and GUI images

The **Publish provider and web-client images** workflow (`publish-provider.yml`)
requires a successful `verify-main` handoff for the exact reviewed commit on
`main`. Full verification is required on the PR; the main push check reuses that
successful run only when the merged PR head has the identical Git tree. It
publishes separate `ghcr.io/j4crev/hail/provider` and
`ghcr.io/j4crev/hail/provider-web-client` images. The `provider-release`
artifact records the full commit and both immutable digest references. Initial
platform support is Linux amd64. A push alone neither publishes nor deploys.

Provider builds contain no reference web-client source, Vite build or client
runtime. Both images currently share a release revision; this does not promise
cross-version API compatibility. Other operators can deploy just the provider.
See the [standalone guide](../apps/server/deploy/standalone/README.md).

### Routine production rollout — operators and agents

The Haili host has the split-image operations wrapper installed. It is root-owned
and independent of this checkout; any future wrapper or backup-tool source changes
require separate reviewed installation through existing privileged access. Preserve
prior copies and verify their SHA-256; do not broaden sudo/SSH policy. Keep the
existing Compose project/service names, `.env`, database/image overlays, volumes,
rollback record and retained images. `deploy/public` remains Haili's site profile;
do not replace it with the new fresh-install profile.

1. Review/commit only the intended changes, preserving other agents' edits. Push
   and require successful main verification for that exact `main` revision. The
   quick main check proves the merged PR passed full CI for the identical tree.
2. Dispatch publication and identify its run by the exact `headSha`:

   ```bash
   gh workflow run publish-provider.yml --ref main
   gh run list --workflow publish-provider.yml --limit 5
   gh run view RUN_ID --json headSha,status,conclusion,url
   ```

   Require `completed`/`success` for the whole run. If `main` advanced before the
   dispatch resolved, review that commit rather than silently substituting it.
3. Download the artifact into a fresh directory:

   ```bash
   gh run download RUN_ID --name provider-release --dir /tmp/hail-provider-RUN_ID
   cat /tmp/hail-provider-RUN_ID/provider-release.txt
   ```

   Verify the commit and both repository/digest references against the successful
   run. Never substitute a mutable tag or publish/build on the provider host.
4. Connect to `haili-provider` as `hailops` using the Tailscale and host-key
   procedure in [operations](haili-operations.md#connect-to-the-provider). Verify
   the installed wrapper, clean checkout, backups, free disk and memory.
5. Execute the artifact's **three-argument** deploy command:

   ```bash
   sudo -n /usr/local/sbin/hail-provider-ops status
   sudo -n /usr/local/sbin/hail-provider-ops deploy FULL_COMMIT_SHA ghcr.io/j4crev/hail/provider@sha256:PROVIDER_DIGEST ghcr.io/j4crev/hail/provider-web-client@sha256:CLIENT_DIGEST
   ```

   Both candidates are pulled and checked against the commit before backup or
   service replacement. The wrapper retains and verifies both running image IDs,
   writes independent selections in `/etc/hail-provider-release/compose.json`,
   and recreates only `gui` and `provider` with builds/pulls disabled. PostgreSQL
   and Caddy are not recreated. Failed startup/readiness restores both retained
   images and the old checkout, and still reports failure.
6. Verify the two expected image references, healthy services, public homepage and
   readiness, unchanged database/Caddy uptime, and absence of new OOM/database
   recovery events. Preserve the operator's public registration policy. Do not
   issue real signup/message writes merely to smoke-test deployment.

### Rollback and retained state

A successful split deployment records five fields in
`/var/lib/hail-provider-previous`: commit, retained provider reference, provider
image ID, retained client reference, client image ID. Tags retain images locally,
so rollback does not depend on a registry pull. Both identities are verified
before changing checkout/selection. Never prune retained recovery images.

The wrapper can read a verified three-field combined-image record from a pre-split
deployment, restoring that image for both services. It rejects unverified two-field
records. New split deployments record both previous image references and IDs.

Run `sudo -n /usr/local/sbin/hail-provider-ops rollback` only after checking schema
compatibility. Keep database overlays, existing volumes and key material; image
rollback does not roll back schema or accepted data. The old checkout supplies its
matching Compose variable names. Any custom private environment overrides must
also match the selected revision.

Backups record both application references, database version/image, `.env`,
`release-compose.json` and the database overlay. Restore these together on the
recorded PostgreSQL major. Never select an older database volume as image rollback.

### Build limits and verification

CI and publication use an isolated BuildKit container with 4 GiB memory, no extra
swap and at most two concurrent steps. The client build additionally limits V8
old space to 512 MiB. Never run these builds on the live provider. Publication
emits provenance and SBOM metadata; digest selection plus the trusted workflow
remains the deployment trust model, not cryptographic attestation enforcement.

CI builds each image separately and checks that the provider has no client tree
and includes the supported administration CLIs. Regression tests in
`apps/server/test/provider-ops.test.ts` cover candidate validation, two-image
retention, failure recovery, manual rollback and the prior combined-image record.
Local tests are not proof of a completed hosted rollout.

The monitor remains a separate deployment and is not covered by this workflow.
