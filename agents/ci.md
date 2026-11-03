# Affected-component CI

PR verification is selected by `scripts/ci/plan.py` from the entire three-dot
base/head diff, not only the newest push. Renames include both paths; deletions
and unusual filenames are preserved. The `changes` job runs the selector/gate
regression tests on every PR and explains each selection in its job summary.

## Selection boundaries

| Change | Jobs |
| --- | --- |
| `apps/client/` | `web`, `images` |
| `apps/server/` | `server`, `database-server`, `web`, `monitor`, `database-monitor`, `images` |
| `apps/cli/` | `cli`, `database-server` |
| `apps/plc-monitor/` | `monitor`, `database-monitor`, `database-server`, `monitor-image` |
| `packages/hail-codec-go/` | `codec-go` |
| Shared libraries, specs, vectors, vendor code, CI, root configuration, unknown paths | All jobs |
| Any workspace `package.json` | All jobs: Docker images copy sibling manifests |
| Root `README.md`/`AGENTS.md`, Markdown under `agents/` and `drafts/` | Selector/gate checks only |

Selections are combined for mixed PRs. Empty diffs run everything. Protocol
prose and CLI reference docs are not covered by the prose-only exception.

These boundaries include **test dependencies**. Browser fixtures import the
server; provider database tests execute the real native CLI; provider signup
tests import the monitor; monitor tests import provider attestation code. The
provider/client deployment test uses both images. Broad component groups keep
those checks intact without maintaining fragile lists of individual tests.
When adding a cross-component import or fixture, update the map and its tests in
the same PR. If the dependency is unclear, select the broader group.

## Job ownership and preservation

- `codec-ts`: codec build/typecheck/tests and client-support typecheck.
- `codec-go`: the Go codec test suite with the pinned mise toolchain.
- `web`: Svelte checks, unit tests, one build, then signup cryptography, wizard,
  compose, and both conversation browser modes against that build.
- `server` and `monitor`: their existing typecheck, unit-test, and build commands.
- `cli`: fmt, clippy, unit tests, one release/package build, compatibility,
  vault/transfer/terminal checks, smoke, installer, generated reference and release
  metadata verification.
- `database-server`: explicit debug CLI build, account-history schema check, and
  every server integration suite in fresh databases.
- `database-monitor`: every monitor integration suite in fresh databases.
- `images`: cached provider/client image builds, image-boundary assertions, and
  the independent provider/optional web-client deployment smoke test.
- `monitor-image`: cached PLC monitor image build.

The database runner continues to fail if no suites match or any test skips.
Jobs run independently: database tests do not depend on the CLI test job having
left a binary behind. Shared TypeScript setup builds the codec prerequisite in
each consuming job; jobs do not share mutable workspaces or databases.

## Required gate and release handoff

The existing ruleset requires `verify`. This job runs with `always()` and checks
that detection succeeded, the job inventory is complete, every selected job
succeeded, and every excluded job was skipped. Failures, cancellations, missing
outputs and unexpected skips fail the gate. Do not add workflow-level path
filters or `continue-on-error` to required checks.

Main pushes retain `verify-main`: it verifies the exact merged tree and requires
a successful pre-merge PR run with a successful `verify` gate. Image publication
still requires this handoff for the exact commit. Application deployment and
publication workflows are otherwise unchanged.

Reusable calls default to full verification. A nightly run at 06:23 UTC and
manual `workflow_dispatch` runs also execute every job and populate main-branch
caches. To run all checks manually:

```sh
gh workflow run ci.yml --ref main
```

Only superseded PR runs are cancelled. Scheduled, manual, release and main
handoff runs have independent concurrency groups. Caches speed up builds but
never replace tests; Cargo and package managers still validate their inputs.

## Maintaining and validating the map

```sh
python3 -B -m unittest discover -s scripts/ci -p 'test_*.py' -v
GITHUB_EVENT_NAME=pull_request BASE_SHA=origin/main HEAD_SHA=HEAD python3 scripts/ci/plan.py select
```

Unknown paths deliberately select all jobs. Add a new narrow mapping only with
regression coverage and an audit of its runtime, test, fixture and image inputs.
The CI implementation PR itself runs all jobs because workflow/selector changes
fall into the full-verification category. Validate a subsequent narrow PR in
Actions before relying on its latency target; use nightly full-suite failures to
investigate missing edges rather than accepting them as unrelated failures.

To temporarily disable selectivity, set `FORCE_FULL: 'true'` on the selection
step. Keep the aggregate gate and all job inventory entries in place.
