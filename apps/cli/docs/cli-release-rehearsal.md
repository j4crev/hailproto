# CLI release rehearsal — October 9, 2026

The first release-roadmap item passed against restored copies of **both live
provider databases** on `2.25.253.153`. At the end of this rehearsal, the live
providers remained at migration **31**. The subsequent [rollout record](cli-release-rollout.md)
documents migration 33 and fresh CLI HTTPS signup/account/credential smoke checks.

## Inputs and retained artifacts

The candidate was built in a separate source directory from clean Git archives:

| Repository | Revision |
| --- | --- |
| `hail-server-ts` | `19a931349cd13f5171f9c303a87b0cc55c532de7` |
| `hailproto` | `4c8af6d9d3435c15859a05b684f6f6ed562c523f` |
| `did-method-plc` | `996e23b5ced9c15b32bcc612dd304880342ca4ab` |

VPS paths:

- Extracted source snapshots, executed checks and log:
  `/opt/hail-cli-rehearsal-20261009/` (`rehearse-cli.sh`,
  `check-credentials.ts`, `rehearsal-pass2.log`).
- Successful rehearsal backup/evidence directory:
  `/var/backups/hail-poc/pre-cli-rehearsal-20261009-pass2/`.
- Retained candidate tag: `hail-server-ts:cli-rehearsal-19a9313`, image
  `sha256:9ac3bb63b233b16e221a4b74570fdd7d3ba09e54f03bbd40eef1355a35e47d07`.
- Retained running-image tag: `hail-server-ts:pre-cli-rehearsal-20261009`, image
  `sha256:35e2da4770f5b514829efd0554386790090289c10f17220fe3744852b5a8552d`.

The backup directory is mode `0700`; `app.dump`, `dev.dump`, `plc.dump` and the
copied provider `.env` are mode `0600`. Deployment Compose/Caddy configuration,
dump SHA-256 hashes, restore listings, table-data comparisons, migration versions,
startup logs and credential-check results are retained there. Temporary clone
environment files were removed after the checks. Retain these backups, source
snapshots and both image tags through the release milestone and its recovery
review; no automatic pruning was configured or exercised.

These are same-VPS backups. Sequential provider/PLC dumps are not a proven
coordinated post-cutover recovery point or an off-host restoration proof.

## Executed proof

1. Built the candidate with the provider Dockerfile and archived sibling layout:

   ```bash
   docker build -t hail-server-ts:cli-rehearsal-19a9313 \
     -f /opt/hail-cli-rehearsal-20261009/hail-server-ts/Dockerfile \
     /opt/hail-cli-rehearsal-20261009
   ```

2. Took custom-format `pg_dump` backups of app, dev and PLC. Every dump was
   nonempty and passed `pg_restore --list`; both provider dumps were fully
   restored with `pg_restore --exit-on-error` into disposable PostgreSQL
   `14.4-alpine` containers.
3. Each clone used its own `hail_private_stage` database and temporary container
   on the existing internal network, with no published ports. Existing staging
   databases were not used. Provider containers used `POC_SCHEMA_REHEARSAL=true`,
   read-only filesystems, dropped capabilities and the internal PLC health path.
   This existing mode disables background workers and mutation APIs.
4. Both copies started at version 31. Candidate startup applied migrations
   32–33 and passed readiness. Running `bun src/cli/migrate.ts` again passed.
5. The retained migration-31 image also started and passed readiness against
   **each migrated copy**. This proves additive schema/startup compatibility
   only: it does not prove old code can serve new account API state, or make an
   image downgrade a data rollback.
6. Sorted row hashes and counts for every pre-existing public table matched
   before/after migration, excluding the migration ledger and the three added
   onboarding fields. Both copies reported version 33.
7. Repository-level credential checks ran against the two copies, using randomly
   generated secrets kept inside the rehearsal process. They proved:
   - Exact issuance retries retain the same credential ID.
   - All six migration-33 scopes can be issued and authenticated.
   - Storage contains the expected SHA-256 token hash.
   - An app token cannot authenticate against dev or be reused by another app
     account.
   - A different account cannot revoke the credential.
   - Revocation and expiry prevent authentication and token reuse.
   - Existing active migration-fenced accounts reject issuance.
8. Removed the temporary provider/database containers and their anonymous
   volumes. Both live provider images were unchanged and both live database
   versions remained 31. External, TLS-verified readiness passed for
   `https://hailproto.app/health/ready` and
   `https://hailproto.dev/health/ready`.

The first harness attempt completed schema/readiness/data checks but failed the
credential check because it concatenated duplicate database environment values.
The harness was corrected and the entire rehearsal rerun against fresh backups
and copies. The successful run is `rehearsal-pass2.log`; the failed attempt's
separate backups/log remain retained. No provider product-code fix was needed.

Executed script SHA-256 hashes:

```text
df8d65c0876e219b500d6923421f9acf06308e153277cb38e042c2c9bcf6d2c1  rehearse-cli.sh
dac89d0c2a3fc4a42f023eba8191a1ac578a636c0debd9cb63e2a337e77d5b52  check-credentials.ts
```

The retained script has fixed candidate, source, container and backup names for
this run. For another rehearsal, review it and choose fresh paths/tags before
execution; it deliberately fails if its backup directory already exists.

## Work following this rehearsal

Individual provider rollout with fresh pre-rollout backups, readiness checks,
explicit private-PLC signup enablement and disposable signup/account/credential
smoke checks is recorded separately in the [rollout evidence](cli-release-rollout.md).
Remaining release checks include interruption,
credential isolation, Grant retries, send/inbox/reply and process-restart fences.
The milestone's authorization/validation/error review and host-limit calibration
also remain unchecked. This rehearsal does not establish those acceptance results.
