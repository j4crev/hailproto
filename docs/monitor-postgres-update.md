# Production PostgreSQL updates

## Current checkpoint — both production databases verified on PostgreSQL 18.6

The monitor and Haili provider both completed their direct 14→18 upgrades on
October 24. SQL version 180006 and healthy application/database containers are
verified on both. The separate POC VPS was untouched. Completed-update history
remains below; **do not rerun any migration capsule**.

| Host | Live report | New PG18 volume | Retained PG14 volume |
| --- | --- | --- | --- |
| Monitor | `/var/lib/hail-pg18-report-a5pamif4/report.json` | `hail-monitor-pg18-8ehg21so` | `hail-public-monitor_monitor_db` |
| Haili | `/var/lib/hail-pg18-report-5gdr8c_1/report.json` | `hail-provider-pg18-1d2lcdel` | `hail-public-provider_provider_db` |

Haili's report confirms exact retained data, preserved database credentials and
permissions, the same application image, 59 matching migration checksums and
successful SQL/key checks before production writers resumed. All **14 account
keys plus 6 prepared-transfer keys** decrypted and matched their public keys.
The backup timer is active/enabled; its new R2 backup was upload/download verified.
GUI/Caddy remained running. The provider's public readiness, WebFinger discovery
and PLC-resolved address-binding signature for `j4@haili.app` pass off-host.
The cutover's existing-token monitor probe passed 401/400; a fresh provider-host
unauthenticated probe returns 401. Manual browser passkey sign-in remains the
operator's final check; it is not claimed as automated proof.

Actual post-cutover Haili recovery point, downloaded from R2, checksum-verified,
authenticated/decrypted, restored into a fresh isolated 18.6 volume and checked
with application SQL plus all 20 private/public key pairs:

```text
provider/haili-20261024T030451Z.tar.gpg
SHA-256: a7d5b978718471ad86b45ae10eff9618fba12f4dc26b9a0a303ba383d7f39f19
```

Its encrypted manifest records SQL 180006 and the approved image digest; the
database overlay is included and verified. The restored copy has 64 tables /
13,725 rows, including normal progress accepted after cutover. The probe leaves
retained data unchanged. Ciphertext and checksum are owner-only in the local ops
directory; safe proof is `ops/pg18-rehearsal/provider-post-cutover-backup-proof.json`.
Live-report and public-signature proofs are retained alongside it. Off-host
temporary plaintext environments/dumps/GPG homes and labeled containers/volumes
were removed; root-only maintenance artifacts remain retained on the VPSs as
documented below.

The monitor's live report `/var/lib/hail-pg18-report-a5pamif4/report.json`
confirms SQL 180006, exact retained data, an unchanged application image and a new
encrypted backup. The run took 34.594 seconds, with backend maintenance roughly
18 seconds. New volume: `hail-monitor-pg18-8ehg21so`; retained original:
`hail-public-monitor_monitor_db`. Database/monitor are healthy, heartbeat
supervision is active, and public enrollment from Haili returns 401 without a
token. The monitor's own live verification also passed polling/API/signing/mail-peer
checks. No identity, application environment, signing key, public ingress or POC service changed.

Monitor post-cutover backup, copied off-host, checksum-verified, authenticated/decrypted,
restored into a fresh isolated PostgreSQL 18.6 volume and application-checked:

```text
/var/lib/hail-monitor-enrollment/monitor-20261024T022048Z-b1fac249.tar.gpg
SHA-256: 95e9e5862a26d0fc70db6bd5c3205dada7c2696fc3ff4d246d0629ee15359803
```

The local owner-only ciphertext and `.sha256` sibling are in the ops directory;
safe proof is `ops/pg18-rehearsal/monitor-post-cutover-backup-proof.json`. Temporary
plaintext/GPG homes/containers/volumes were removed. Old volumes and encrypted
recovery points remain retained. No automatic database downgrade is safe now that
both applications have resumed writes. Preserve the current PG18 volumes and
fix forward; never select an old PG14 volume or restore a pre-cutover dump over
accepted writes. No old production volume or recovery point was deleted.

## Completed checkpoint — October 24, 2026, 00:30 UTC

The operator's refreshed attempt succeeded. Sanitized live report
`/var/lib/hail-db-update-report-93973723/report.json` confirms SQL version 140024,
exact application-data preservation, the same data volume, catalog security repair
across all databases/templates, reindexing, and an unchanged monitor application
image. The active override pins the approved digest. Monitor/database are healthy,
heartbeat supervision was restored, four tunnel connections remain ready,
provider-host public enrollment reaches 401, and Haili readiness returns 200.
Public TCP 5432 is unavailable on the monitor's IPv4 and IPv6 addresses.

Post-upgrade encrypted recovery point, copied off-host and SHA-256 verified:

```text
Server: /var/lib/hail-monitor-enrollment/monitor-20261024T003308Z-afd4ff29.tar.gpg
Off-host: ~/.local/share/hailproto/ops/monitor-20261024T003308Z-afd4ff29.tar.gpg
SHA-256: 9342a107797acb0034559320287fffa6ca1faaf091f51bb8af31766859a4bfb0
```

The `.sha256` sibling and ciphertext are owner-only. Pre-upgrade recovery points
and the old image were retained. No data restore/deletion, application schema
migration, key rotation, firewall change or POC deployment occurred. There is no
upgrade rollback timer to cancel. No reboot was performed. The apply sections
below are historical; **do not rerun the 14.4-only controller on 14.24**.

## Verified preparation

Before the update, the monitor server, its container binary and its immutable image all reported
14.4 (`server_version_num=140004`). Its authoritative legacy Compose specifies
14.4, despite the monorepo's newer base already specifying 14.24. The upgrade
pins the image in the protected active override, so the legacy base cannot
silently select 14.4 on a subsequent deployment.

The original backup recovery material was found, not replaced:

- Private key: `~/.local/share/hailproto/ops/haili-backup-private.asc`
- GPG passphrase file: `~/.local/share/hailproto/ops/r2-backup-passphrase.txt`
- Fingerprint: `870DECF2F98318BCDE17D4B8333035D2650B0400`

The owner-only file permissions and fingerprint were verified. Despite its name,
the passphrase file unlocks the GPG recovery key, not a Cloudflare account. The
key is also stored in the dedicated `ops/backup-gnupg` home, not the default GPG
keyring. Keep these files off all VPSs; do not print their contents or commit
them. The restore tests used a temporary local GPG home, removed afterward.
Store durable encrypted/off-device recovery material and retain the passphrase
separately; a single laptop should not be the only place that can recover R2.

Fresh encrypted recovery point:

```text
Server: /var/lib/hail-monitor-enrollment/monitor-20261024T001921Z-aa791235.tar.gpg
Off-host: ~/.local/share/hailproto/ops/monitor-20261024T001921Z-aa791235.tar.gpg
SHA-256: 3811553d26fdab852dd55cb7bd9fd2c03fe1802e0e2b3757b77ff010969e84ac
```

The off-host copy and adjacent `.sha256` file are owner-only. The encrypted
19:38 and 22:17 recovery points were retained there too. R2 credentials were not used or
changed; these follow the existing manual off-host monitor-backup workflow.

Each retained encrypted recovery point was authenticated/decrypted locally and only the
`monitor.dump` member was extracted into a private temporary directory. Credential
and signing-key members were not extracted or displayed. Restore proof used a
network-isolated, unpublished disposable PostgreSQL 14.4 instance, then booted
**the same temporary volume** under 14.24 and back under 14.4. The vendor
`fix-CVE-2024-4317.sql` was applied to all databases including both templates,
template0's connection policy was restored, and `REINDEX DATABASE monitor` and
`ANALYZE` succeeded. Full-row SHA-256 manifests matched across the cycle: seven
application tables, 36 rows, including five retained migration records. All
temporary containers, volume, dump and local GPG home were removed. No live
database was changed during rehearsal.

The first live attempt exited early in preflight. At inspection the previous
recovery point was 7,011 seconds old, exceeding the one-hour guard; no maintenance
report had been created, PostgreSQL was still 14.4 with its original uptime, and
monitor/edge/heartbeat/tunnel remained healthy. The fresh October 24 recovery
point above was therefore created, copied off-host, checksum-verified and put
through the full restore/physical upgrade/rollback rehearsal too. The freshness
guard was not weakened. The launcher now shows recent unit journal output on
failure while preserving its nonzero exit status. Regression checks confirm an
expired backup changes no services and its failure reason is visible.

The exact shared SQL helpers used by the live operator were included in the
rehearsal. Additional stdlib-only control tests cover success, pre-resume
image/config rollback, refusal to overwrite concurrent operator changes, and no
automatic rollback after the application can write new data:

```bash
TMPDIR=/tmp/opencode python3 apps/plc-monitor/test/check-pg14-upgrade.py
```

## Apply: monitor root console only

Allow a brief maintenance window of a few minutes for monitoring/enrollment.
The Haili provider application is not restarted. Do not run another deployment,
database maintenance operation or configuration edit concurrently.

```bash
sh /home/hailops/pg.2rVbhs/run.sh
```

The launcher verifies its manifest and runs the guarded controller under systemd,
independently of the browser terminal. It refuses a recovery point over one hour
old; if it has expired, refresh the recovery point and plan rather than bypass
the guard. It checks the expected node/version/image, protected config, active
bridge, catalog-repair scope, absence of replication slots, bounded database size,
actual tunnel readiness and a candidate Compose that changes **only** DB image.
The immutable target is:

```text
postgres:14.24-alpine@sha256:50fce0c9c54c43d8b02ce16cb9daff75eb94c09c4ee3d41c157852ebd9700c80
```

Image download and candidate validation happen before pausing anything. The
controller pauses the heartbeat timer and monitor backend, preserving the Caddy
listener; enrollment may return 502 temporarily. It captures full application
row manifests, stops PostgreSQL cleanly, atomically pins the active override and
recreates only `db`, retaining the **same volume**. It applies the vendor catalog
repair to all databases/templates, reindexes and analyzes, then requires exact
data-manifest equality and unchanged volume mapping before resuming the backend.
It checks the unchanged monitor application image, existing polling/signing/mail
peer verification and local 401 token gate, then restores heartbeat supervision.
No application schema migration, key rotation, environment edit, data restore,
Docker volume deletion, public port or firewall change is part of this operation.

The controller writes root-only preservation/config artifacts under
`/var/lib/hail-pg14-update.*` and a sanitized `hailops`-readable report at
`/var/lib/hail-db-update-report-*/report.json`. Report completion; do not paste
credentials or private diagnostics. Verify SQL 140024, healthy monitor/database/
heartbeat, public enrollment and the existing provider container probe afterward.

## Failure boundaries

Before the backend resumes, an exception attempts only an old-image/config
rollback on the **same volume**, verifies data still matches, then resumes the
existing backend and heartbeat. Concurrent config changes are never overwritten.
No old dump is copied over current data. After the backend can accept new writes,
there is no automatic downgrade/restore; retain current data and inspect/fix
forward. If image-only recovery itself fails, backups and the live volume remain
intact and the report requires operator review. Do not reset/reinitialize the
cluster, delete volumes, blindly rerun the controller or restore stale data.

PostgreSQL 14 support ends November 12, 2026. This minor patch does not replace a
separately rehearsed major-version migration before end of support.

## PostgreSQL 18 follow-up approved

The operator approved direct major upgrades for **both production VPSs**, monitor
first and Haili provider second. The POC VPS remains outside scope. Intermediate
15/16/17 installations are not required. Use logical dump/restore into separate
18 volumes, retaining the original 14 volumes; never mount 14's data directory
as an 18 cluster. Do not switch production until data, schema/application SQL
and (for Haili) retained operational-key decryption pass against restored copies.
Rollback must not discard any writes accepted after cutover.

The initial target is official `postgres:18.6-alpine`, multiarch digest
`sha256:898c60cb390d1085bc97bdd6a1ae968757421df394b071848b52b1c09c89d6a5`.
It was first pulled off-host for rehearsal and is now live on both production hosts. Both servers have
Compose 2.40.3, supporting explicit native volume overrides. PostgreSQL 18's
official image uses `PGDATA=/var/lib/postgresql/18/docker` and the volume parent
`/var/lib/postgresql`, unlike 14's `/var/lib/postgresql/data`; config and backup
ownership must account for this, not just change the image tag.

Read-only root-console inventories completed; they report only
version/locale/extensions/size, roles without passwords, volume/app image shape,
and provider backup endpoint metadata. Rendered credentials are withheld.

Hostinger monitor:

```bash
sh /home/hailops/pg18.WVqilU/run.sh
```

Hetzner provider:

```bash
sh /home/hailops/pg18.Dy2RKp/run.sh
```

Reports are `/var/lib/hail-pg18-inventory-fyvruxfm/report.json` (monitor) and
`/var/lib/hail-pg18-inventory-hh87lhrp/report.json` (provider). Both report SQL
140024, UTF8/en_US.utf8, built-in PL/pgSQL only, one administrator, and no
sequences, partitions or replication slots. Actual data volumes are
`hail-public-monitor_monitor_db` and `hail-public-provider_provider_db`.

### Completed off-host PostgreSQL 18 proofs

Authenticated encrypted backups were decrypted only in private off-host temporary
directories, restored independently into fresh 14.24 and 18.6 volumes, and
compared with full-row SHA-256/count manifests across every application table:

| Role | Tables / rows | Application proof |
| --- | --- | --- |
| Monitor | 7 / 36 | Five migration checksums, Bun UUID/JSONB/bytea/time round trips, complete monitor integration file |
| Haili | 64 / 13,341 | 59 migration checksums, Bun type round trips, grant-repository integration file, all 14 account and 6 prepared-transfer keys decrypted and private/public pairs verified |

Fixture tests used separate empty databases, never the restored retained-data
copies. The application probes start no delivery/polling workers. Both versions
return the same JSON string transport for the application's existing stringified
bindings; the probe now applies the same JSON normalization as the application.
This required no application/runtime-source change.

The exact monitor controller was also exercised against real disposable Docker
14/18 clusters: native Compose volume replacement, paused logical dump/restore,
original login verifier/role attributes and database ownership/ACL/locale checks,
exact data preservation, and the application clone probe all passed. Only host
identity, service supervision and production application lifecycle were simulated.
Control checks additionally cover restore/data failures, pre-write rollback,
post-write no-rollback, concurrent operator edits, expired backups and candidate
scope. Disposable databases, volumes, plaintext dumps and temporary GPG homes
were removed; safe proof reports and off-host replay scripts are retained in
`~/.local/share/hailproto/ops/pg18-rehearsal/`.

Latest monitor recovery point, copied off-host, checksum-verified and restore-tested:

```text
/var/lib/hail-monitor-enrollment/monitor-20261024T021026Z-0fdc16e6.tar.gpg
SHA-256: 31c4890fb339c06ec035c73e79b10bb737784128ea67f055d85956ddeab0fa66
```

Provider recovery point, generated by the existing backup job, downloaded from
R2 and successfully restored into both majors:

```text
provider/haili-20261024T011222Z.tar.gpg
SHA-256: e3c562ee9e0ec4f01edaf8ded47cf514e681e7ba9d3475ac146de4d9bf7fc05d
```

Both encrypted files and `.sha256` siblings are owner-only in the local ops
directory. The recovery private key/passphrase never left the operator machine.

### Completed PostgreSQL 18: Hostinger monitor root console (historical)

The following capsule completed successfully; **do not rerun it**. Its original
maintenance instructions were: allow a few minutes of enrollment/monitoring maintenance. Do not deploy or edit
configuration concurrently. No Haili application or POC service is restarted.

```bash
sh /home/hailops/pg18m.f0PA4D/run.sh
```

The capsule is checksum-verified and copied to root-only storage before systemd
execution. It refuses the wrong host/version/image, unexpected source storage,
unhealthy services, non-SCRAM credentials, unexpected roles/settings/extensions,
insufficient disk space or an off-host-tested backup older than one hour. If
expired, refresh/copy/restore-test the backup and stage a new plan, not a weaker
guard. It snapshots protected config hashes and checks them again before changes.
Rendered Compose must match live environments and may change only the DB image
and storage mapping. Images are downloaded before maintenance.

The controller pauses heartbeat supervision and the monitor backend, retaining
the tunnel/loopback enrollment listener. It takes a fresh paused logical dump
and exact manifest, creates a separate labeled PostgreSQL 18 volume mounted at
`/var/lib/postgresql`, and restores only into that new cluster. Recreating its
**empty target database** preserves source database metadata; the original 14
volume is never restored over or deleted. Source credentials, database metadata
and every retained row must match before the unchanged backend resumes.

Persistent database routing is installed at
`/etc/hail-monitor-enrollment/compose.postgres.yaml`; the root-owned operations
wrapper and `/etc/hail-monitor-enrollment/operations.py` honor it for deployments,
backups, verification and runtime rollbacks independently of application release.
The old enrollment override stays intact. Legacy-runtime rollback is blocked
while this database overlay exists. Haili's equivalent provider/backup support
has subsequently been installed during its successful cutover.

Before application-start, failure attempts to resume the original 14 volume and
configuration only if no concurrent operator edits would be overwritten. After
the application-start boundary, there is **no automatic database rollback**:
retain both volumes and fix forward so new accepted writes cannot be discarded.
The controller never deletes a volume. Root-only dump/role/config artifacts stay
under `/var/lib/hail-pg18-monitor-*`; sanitized reports are group-readable at
`/var/lib/hail-pg18-report-*/report.json`. Report failure instead of rerunning.

Success requires polling/API/signing/mail-peer verification, restored heartbeat
supervision, an unchanged application image and a new encrypted PG18 backup.
Afterward retrieve the report, copy and restore-test that backup off-host, and
verify public enrollment from Haili before preparing its separate cutover.

Runnable focused checks:

```bash
TMPDIR=/tmp/opencode python3 apps/plc-monitor/test/check-pg18-upgrade.py
TMPDIR=/tmp/opencode python3 apps/plc-monitor/test/check-pg14-upgrade.py
OPENCODE_TMP_DIR=/tmp/opencode bun run --cwd apps/plc-monitor test test/rollout-tools.test.ts
```

### Completed PostgreSQL 18: Hetzner Haili provider root console (historical)

This capsule completed successfully. **Do not rerun it.** Its preparation and
failure boundaries are retained here for recovery context.

Fresh R2 recovery point was downloaded and independently restored into 14.24 and
18.6: 64 tables / 13,589 rows match exactly, 59 migration checksums match, all 14
account plus 6 prepared-transfer keys decrypt and match their public keys, and
the grant-repository integration file passes against a separate empty database.

```text
provider/haili-20261024T022441Z.tar.gpg
SHA-256: f652e84c6923e28dc4b8e8332851676c5734ef3e029d856d491051ee750da878
```

The exact provider controller additionally passed a disposable real-cluster
rehearsal, including source credential/database-ACL preservation and its actual
runtime-image SQL/key probe. Host supervision, public application lifecycle and
R2 upload were simulated in that rehearsal, not executed against production.
Control tests cover restore/key/data/partial-install failures, expired backups,
unexpected Compose changes, concurrent edits and no rollback after writes.

Allow a few minutes of Haili API/sign-in unavailability; the monitor is not paused.
Do not deploy, edit configuration or run concurrent database maintenance.

```bash
sh /home/hailops/pg18p.oIfgg3/run.sh
```

The checksum-verified capsule contains only reviewed code, a non-secret plan and
the already-off-host-tested **encrypted** backup. It is copied into root-only
storage before journal-backed systemd execution. No recovery private key or
passphrase is copied. The one-hour age check uses the R2 backup creation time,
not the newly copied file's modification time. If expired, refresh the backup
and its restore proof; do not bypass or rerun a failed controller.

Preflight pins host/source volume/SQL/app image and installed wrapper/backup
checksums, requires healthy application/database/tunnel and sufficient space,
checks cluster compatibility and live-versus-rendered environments, and probes
public monitor enrollment for both 401 without a token and 400 with the existing
token. It takes the existing backup lock and pauses its timer, not an active
backup. The target image is downloaded before stopping the provider backend.
GUI/Caddy/tunnel and the monitor remain in place.

With writers stopped it captures a fresh logical dump, role verifier, database
metadata and full-row manifest. Restore is confined to a fresh labeled PG18
volume with the new parent mount. Exact data, credentials/ACL/locale, migration
checksums and every retained operational key must pass before production writers
resume. The key probe uses the existing app image with its entrypoint overridden
to the SQL-only check; it starts no delivery workers, prints no secrets, and
removes its root-only temporary environment afterward.

The controller installs the reviewed operations/backup scripts and persistent
`/etc/hail-provider-postgres/compose.yaml`. This DB overlay survives application
release rollback; no app-source deployment or image rebuild occurs. It resumes
the same provider image, requires public readiness and monitor enrollment checks,
uploads/verifies a new encrypted backup in R2, then restores the backup timer.
Before application-start it may resume the untouched original 14 volume/config;
after application-start it never automatically downgrades or restores old data.
No volume is deleted. Failure preserves both volumes and root-only dump/config
artifacts for review; never run Compose without the active database overlay.

The live report, reported R2 backup restore/key check, public discovery/binding
and monitor peer verification have now passed; see the current checkpoint above.
Browser passkey sign-in is the remaining manual operator check.

```bash
TMPDIR=/tmp/opencode python3 apps/server/test/check-pg18-upgrade.py
```
