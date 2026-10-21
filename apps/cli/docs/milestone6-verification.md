# Milestone 6 — local developer/agent verification

Verified October 11, 2026, with CLI package **0.1.0**, contract **v1**, Bun
**1.4.0**, Node **26.7.0**, pnpm **11.11.0**, on Linux x64. This is local candidate
evidence; no provider deployment was required. The package version remains
0.1.0. Existing API v1, file versions and signed-object versions are preserved.

## Delivered interface

- One command table owns contextual help, required inputs and strict allowlists.
  Unknown/misplaced options, extra arguments, repeated single-value flags,
  invalid read bounds and conflicting authorization/expiry options fail before
  credential access, prompts or side effects.
- Source and compiled `--version` print only `0.1.0` plus newline. Normal JSON
  retains command fields and adds `cliContractVersion: 1`. Errors retain HTTP
  codes and add actionable status/retry metadata; untrusted HTTP bodies are not
  echoed. Hidden prompts now use stderr, protected stdin still works.
- Explicit credential selection retains private modes and original HTTPS origin.
  `--provider`/`--account-id` are assertions, not bearer-token destinations.
- Bounded status reads share an overall request/sleep deadline, preserve the
  last observed state and retry only read-only 429/503 failures within that
  deadline. Lists retain continuation cursors and reject cycles/oversized data.
- `bun run build` produces `dist/hailp`; frozen installation uses committed
  lockfiles and exact sibling source pins. The lockfile now includes both
  previously missing root dependency declarations from `package.json`.

## Recorded gates

| Command / environment | Result |
| --- | --- |
| Client `bun run typecheck` | Passed, including source/scripts/tests |
| Client `bun run test` | 6 files, 10 tests passed |
| Client `bun run build` | CLI typecheck plus native binary compilation passed |
| Client `bun run smoke -- dist/hailp` | Version/help/strict errors, missing credentials, offline vault create/verify, private modes and secret nondisclosure passed |
| Client `bun run verify:install` | Empty temporary sibling layout, exact library archives, frozen installs, CLI typecheck/build, Bun source and standalone binary smoke passed |
| Provider `bun --bun vitest run test/account-api.integration.test.ts` with disposable PostgreSQL 14.4 | 7 tests passed over actual HTTPS with a trusted temporary CA; verification was never disabled |
| Provider `bun run typecheck` | Passed, including the updated HTTPS integration checks |

The TLS integration now also proves multi-page inventory with exact account/
origin selection, provider mismatch rejection and inbox pagination convenience.
Its message fixture delivers the body but does not retain authenticated status
at the sender: `message status --wait 1` correctly returns indeterminate/null
revision with timedOut=true, rather than inferring acceptance from the submission
result. Existing scope/isolation, terminal credential, exact retry, private-key,
redirect and fence checks still pass.

Focused client checks cover malformed responses, same-ID read-only polling,
terminal/accepted/on-hold/indeterminate states, bounded throttling, cursor cycles,
aggregate size and selection before transport. Offline smoke verifies the
compiled executable's cryptographic vault operations, not only its help text.

The disposable local PostgreSQL container and fresh-install trees were removed.
No live database, credentials, PLC state or deployment was changed.

## Evidence boundaries

Fresh installation copies only candidate source and archives the exact codec/PLC
revisions listed in [installation](cli-installation.md); it carries over no built
libraries or installed dependencies. Registry caches may be used. A first attempt
exposed legacy tests importing provider fixtures, so the install/build typecheck
uses `tsconfig.cli.json`; full development typecheck/tests still cover those
fixtures in the sibling development layout. A strict vault-output test was updated
to assert the new additive contract field; the full suite then passed.

This is not a public registry publication, cross-platform binary proof,
byte-identical build claim, live release, independent production recovery proof
or managed/custody migration execution. The existing signing, consent, generation
and fence boundaries remain authoritative for humans and agents alike.
