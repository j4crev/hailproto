# CLI provider rollout — October 9, 2026

Both public POC providers now run migration **33** and the candidate verified in
the [migration rehearsal](cli-release-rehearsal.md). Disposable owner-controlled
and managed accounts completed CLI signup and account/credential smoke checks
on **each** real HTTPS endpoint, with TLS verification enabled.

## Deployment

- Provider source: `19a931349cd13f5171f9c303a87b0cc55c532de7`.
- CLI checkout: `ded820c9c9489d465d053156a20776db1781f183` (uncommitted changes
  during this release were documentation only).
- Image tag: `hail-server-ts:poc-cli-19a9313-20261009`.
- Image ID: `sha256:9ac3bb63b233b16e221a4b74570fdd7d3ba09e54f03bbd40eef1355a35e47d07`.
- Fresh pre-rollout backups/configuration:
  `/var/backups/hail-poc/pre-cli-rollout-20261009/` on the VPS.
- Previous image retained as `hail-server-ts:pre-cli-rollout-20261009`.
- Executed rollout script/log:
  `/opt/hail-cli-rehearsal-20261009/roll-cli.sh` and `rollout.log`.

The provider/PLC dumps were nonempty, passed `pg_restore --list` and have retained
SHA-256 hashes. The backup directory is mode `0700`; dumps and provider secret
configuration are mode `0600`. Retain these and the previous image through the
release milestone/recovery review. These sequential same-VPS backups do not
establish coordinated post-cutover or off-host recovery.

The VPS uses an explicit overlay at
`/opt/hail-poc/hail-server-ts/deploy/poc/compose.cli-release.yaml` to pin the
rehearsed image, point future builds at its retained source snapshot, and enable
`POC_SELF_SERVICE_ONBOARDING=true` for both providers. Include it for live stack
operations, from the deployment directory:

```bash
docker compose --env-file .env -f compose.yaml -f compose.cli-release.yaml config --quiet
docker compose --env-file .env -f compose.yaml -f compose.cli-release.yaml ps
```

The rollout used `up -d --no-deps --wait --no-build hail-app`, verified external
HTTPS readiness and database version 33, then repeated that sequence for
`hail-dev`. Both containers use the same image ID and report healthy. Startup
logs contain no worker errors during the smoke checks. PLC, Caddy, database and
monitor containers were not recreated; existing monitor services remain healthy.
Image downgrade alone is not data rollback after new account API writes.

## HTTPS CLI proof

| Provider | Custody | Disposable DID |
| --- | --- | --- |
| `https://hailproto.app` | owner-controlled | `did:plc:6zexa3fpfmfpcwlsrtp6cqu2` |
| `https://hailproto.app` | managed | `did:plc:evaewtveayxkk4ltjbmuxc5z` |
| `https://hailproto.dev` | owner-controlled | `did:plc:ossu6qqku7zztx3avw5uea3p` |
| `https://hailproto.dev` | managed | `did:plc:wzjke6mnxrvyu63yycckkj5k` |

Addresses use `cli-release-20261009-<custody>@hailproto.<app|dev>`. For all four:

1. `hailp vault create` saved private local vault/recovery files. A copied vault
   and copied recovery secret passed `vault:verify` before `--backup-verified`.
2. `hailp account create` completed through HTTPS with explicit custody and
   retained local signup state. No vault or recovery secret was copied to the VPS.
3. `hailp account show` matched provider, address, DID and custody; owner recovery
   matched the local vault in both profiles. Owner-controlled identity matched
   the vault; managed identity differed from the unused local identity key.
   Both reported `poc-local` verification, no migration fence and six scopes.
4. `hailp grant list` and `hailp inbox list` returned empty account-scoped lists
   with null pagination cursors.
5. `hailp credential create` issued a second private credential; account reads
   with it matched the original credential's account/scopes. Revocation succeeded
   and subsequent authentication returned `HTTP_401`.
6. Assertions verified these results and mode `0700` account directories /
   mode `0600` files.

Executed local scripts are `/tmp/opencode/smoke-cli-release.sh` and
`/tmp/opencode/check-cli-release.ts`. Private disposable account artifacts remain
under `/tmp/opencode/cli-release-20261009/`; they are temporary local material,
not durable identity backups. Only the public result summary and scripts were
copied to the VPS backup directory; no signup tokens/credentials/vaults/recovery
secrets were included in that evidence copy.

Client gates: `bun run typecheck` passed; `bun --bun vitest run` passed all three
tests. `bun run test` uses Vitest's Node runtime and failed the existing
`Bun.spawn` ceremony test (`Bun is not defined`); the explicit Bun-runner command
is the successful gate used here. Product code and test scripts were unchanged.

## Remaining release acceptance

The next roadmap item covers interrupted signup, cross-account credential
isolation, exact Grant retries, send/inbox/reply and source fencing across process
restarts. Empty-list reads here do not establish messaging or Grant lifecycle
proof. Authorization/validation/error review and target-host limit calibration
also remain pending. This release is private-PLC POC evidence, not production
readiness, public PLC onboarding or independent monitoring.
