# Credential/account lifecycle release — October 9, 2026

Milestone 3 passed its private-POC deployment acceptance. Both providers are now
at migration **34**, with owner access recovery enabled. Both custody profiles on
both real HTTPS origins passed simulated credential expiry, owner recovery, exact
retries, rotation, inventory, narrower issuance and terminal-token/scope checks.

## Release identity and retained artifacts

The release includes the tested working-tree lifecycle changes, not just a Git
commit. Immutable source snapshots were retained so the deployed code is identifiable:

Those runtime changes are now recorded as provider commit `c8ac611` and client
commit `72834ef`. Committing/pushing them does not rebuild or redeploy the image.

| Artifact | Identity |
| --- | --- |
| Provider base | `19a931349cd13f5171f9c303a87b0cc55c532de7` plus tested runtime changes |
| Provider runtime archive SHA-256 | `6b3e3cc64086e42c175a54c5b7ca8248b09772843e559db5b919b879c7515693` |
| Client base | `ded820c9c9489d465d053156a20776db1781f183` plus tested runtime changes |
| Client runtime archive SHA-256 | `d933f72b00b0014d0f70199ca5273fc66616027968f70f89dedbeb65e99facef` |
| Protocol | `4c8af6d9d3435c15859a05b684f6f6ed562c523f` |
| PLC library | `996e23b5ced9c15b32bcc612dd304880342ca4ab` |
| Running image | `hail-server-ts:poc-lifecycle-20261009` |
| Image ID | `sha256:9c6e8997c48349b2dc6d9c742ce0af67abb1858c9b9305ee124d4f450ca83d84` |

VPS source snapshots, archives, executed scripts and logs live under
`/opt/hail-lifecycle-release-20261009/`. Rehearsal backups/evidence are under
`/var/backups/hail-poc/pre-lifecycle-rehearsal-20261009/`; fresh pre-rollout
backups/configuration are under `/var/backups/hail-poc/pre-lifecycle-rollout-20261009/`.
Backup directories are mode `0700`; provider/PLC dumps and secret environment
copies are mode `0600`. Nonempty custom-format dumps passed `pg_restore --list`,
and their SHA-256 hashes were retained.

The previous migration-33 image is retained as
`hail-server-ts:pre-lifecycle-rollout-20261009`, ID
`sha256:9ac3bb63b233b16e221a4b74570fdd7d3ba09e54f03bbd40eef1355a35e47d07`.
Keep backups, source snapshots and both images through release/recovery review.
Sequential same-VPS provider/PLC dumps are not a proven coordinated post-cutover
or off-host recovery point. Image rollback does not undo credentials or data.

## Restored deployment-copy rehearsal

1. Fresh app/dev dumps were fully restored with `pg_restore --exit-on-error` into
   separate temporary PostgreSQL `14.4-alpine` containers, each using
   `hail_private_stage` on the internal network with no published ports.
2. The candidate applied migration 33→34, passed readiness and repeat migration
   on each copy. The retained migration-33 image also passed schema/readiness
   startup against each migrated copy.
3. Every pre-existing public table's sorted row hash/count matched before/after
   on each copy, excluding only the migration ledger. Background workers and
   mutation routes were disabled with the existing schema-rehearsal mode.
4. After that preservation check, administrative expiry was simulated only for
   the four disposable CLI test credentials **inside the copies**. Local owner
   keys signed public challenges; the candidate verified them against the real
   private PLC and issued/retried the same credential in each custody/provider
   combination. Expired originals stayed unauthorized.
5. Removed temporary containers/anonymous volumes and clone environment files.
   Live schemas/images remained at 33 until the subsequent rollout.

Executed checks: `rehearse-lifecycle.sh`, `rehearsal-access.ts`, `rehearsal.log`
on the VPS, and local `/tmp/opencode/check-staged-lifecycle.ts`. Only proof/request
material and API credential secrets entered the provider process; vaults and
their encryption/recovery secrets stayed on the client machine. Worker-disabled
startup is an additive-schema check, not a blanket rollback guarantee.

## Rollout and real HTTPS proof

Fresh backups were taken before either provider changed. The live
`compose.cli-release.yaml` overlay now pins the lifecycle image, points builds at
`/opt/hail-lifecycle-release-20261009`, and sets both
`POC_SELF_SERVICE_ONBOARDING=true` and `POC_ACCOUNT_ACCESS=true`.
Include the overlay for live stack operations:

```bash
docker compose --env-file .env -f compose.yaml -f compose.cli-release.yaml ps
```

App was replaced with `up -d --no-deps --wait --no-build hail-app`, then HTTPS
readiness and migration 34 were verified before dev was replaced the same way.
Both are healthy on the same image ID. Database, PLC, Caddy and monitor services
were not recreated and remain healthy. Provider logs showed no worker errors
during the checks. Executed rollout/log: `roll-lifecycle.sh`, `rollout.log`.

The four disposable accounts from the [initial CLI release](cli-release-rollout.md)
were used. Administrative expiry simulation selected each exact credential ID,
account ID and known disposable address; normal client operations then used only
HTTPS APIs and locally held signing material:

| Provider | Custody | DID |
| --- | --- | --- |
| `https://hailproto.app` | owner-controlled | `did:plc:6zexa3fpfmfpcwlsrtp6cqu2` |
| `https://hailproto.app` | managed | `did:plc:evaewtveayxkk4ltjbmuxc5z` |
| `https://hailproto.dev` | owner-controlled | `did:plc:ossu6qqku7zztx3avw5uea3p` |
| `https://hailproto.dev` | managed | `did:plc:wzjke6mnxrvyu63yycckkj5k` |

For every account, with TLS verification enabled:

- Expired original `account show` returned `HTTP_401`.
- `account login` used identity proof or explicit owner-recovery proof, with
  exactly `account:read` and `credentials:write`. Retry kept the same ID/expiry.
- Account/DID, custody, identity and owner recovery public keys matched the
  pre-release account; current credential metadata matched the issued receipt.
- `credential rotate` retained those scopes, revoked its source, and repeated
  successfully with the original source/output after source revocation.
- Narrower issuance selected only `account:read`; it could not inventory
  credentials (`HTTP_403`). The manager could not issue missing `grants:write`.
- Inventory showed expired originals, revoked recovery credentials and active
  replacements/readers, with no token/hash fields. Replaying the original login
  after its credential was revoked returned `HTTP_401`, not revival.
- State, credential and rotation-sidecar files were mode `0600` beneath private
  client directories. Secrets were absent from CLI stdout/stderr.

All four private PLC logs were read and compared to their original signup
operations. Each still contains **exactly its original signed genesis**: no
identity/top-recovery/custody operation was published by login or rotation.

Local scripts are `/tmp/opencode/verify-live-lifecycle.ts` and
`/tmp/opencode/check-live-plc-unchanged.ts`. Private test artifacts remain under
`/tmp/opencode/lifecycle-live-20261009/`. Only public summaries/scripts and this
record were copied into the VPS rollout evidence directory, not user vaults,
recovery secrets, credential files or login/rotation state. Temporary disposable
artifacts are not durable user identity backups.

The [local regression evidence](account-access-verification.md) additionally
proves response-loss/concurrent completion, changed/historical authority and all
fence states. The real-host checks above do not relabel those local injections
as VPS fault injection. Public PLC, managed migration, independent monitoring
and the remaining milestone-1 messaging/restart/review checks remain separate.
