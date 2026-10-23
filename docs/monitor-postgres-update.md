# Monitor PostgreSQL 14.4 → 14.24

## Verified preparation

The live monitor server, its container binary and its immutable image all report
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
Server: /var/lib/hail-monitor-enrollment/monitor-20261023T221751Z-0f9f3338.tar.gpg
Off-host: ~/.local/share/hailproto/ops/monitor-20261023T221751Z-0f9f3338.tar.gpg
SHA-256: 6b4d5504de014357bc63f101eed5ebcef1bd6e4d5341d82a4a116699ed579fab
```

The off-host copy and adjacent `.sha256` file are owner-only. The encrypted
19:38 recovery point was retained there too. R2 credentials were not used or
changed; these follow the existing manual off-host monitor-backup workflow.

Both exact encrypted backups were authenticated/decrypted locally and only the
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
`/var/lib/hail-db-update-report.*/report.json`. Report completion; do not paste
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
