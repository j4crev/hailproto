# Same-VPS private PLC monitor

This is a working monitor deployment for the existing Hail POC VPS. It is
**non-independent**: provider, private PLC, monitor and webhook receiver share
one operator and host. It uses `MONITOR_DEPLOYMENT_PROFILE=private-poc` and
leaves `MONITOR_ORIGIN` unset; no production coverage attestation is configured.
Do not register this key as a user-controlled independent monitor at a provider.

## Layout and services

Keep the sibling `hailproto`, `did-method-plc`, `hail-server-ts` and
`hail-plc-monitor-ts` checkouts under `/opt/hail-poc`. The monitor image follows
the provider's pinned Bun/PLC/codec build pattern. Build from the sibling
workspace root via this Compose file.

- `monitor-db`: dedicated PostgreSQL 14.4 database and volume, reachable only
  through the monitor's internal storage network; no published port.
- `plc-monitor`: polls `http://plc:2582` over the existing private network,
  retains its sequence cursor in its own database, and holds only its own
  Ed25519 alert-signing key. No provider database credentials or user vault
  material are mounted.
- `poc-alert-receiver`: verifies the configured monitor key and domain-separated
  signature before storing an alert in a dedicated SQLite volume. It accepts
  exact retries and rejects conflicting IDs, bad signatures and oversized
  requests. It holds the monitor **public** key only.
- Existing Caddy routes only `/poc/monitor-alerts` on `hailproto.app` to this
  receiver; all other app/dev requests continue to the providers. Webhook
  delivery uses real public DNS, certificate verification and pinned HTTPS.

The receiver is a POC receipt sink, not a user-facing alert inbox.

## Initial setup

From `/opt/hail-poc/hail-plc-monitor-ts/deploy/poc`:

```bash
# Build uses only placeholders; do not run services with the example secrets.
docker compose --env-file .env.example -f compose.yaml build plc-monitor
mkdir -m 0700 secrets
docker run --rm --network none --user root \
  --mount "type=bind,src=$(pwd)/secrets,dst=/keys" \
  hail-plc-monitor-ts:poc bun src/cli/generate-key.ts /keys/monitor.pkcs8
chown -R 1000:1000 secrets
cp .env.example .env
chmod 0600 .env
```

Set `MONITOR_PUBLIC_DID_KEY` to the printed public key. Generate a fresh
base64url database password and set `MONITOR_DB_PASSWORD` in `.env`; never
reuse a provider/PLC password. The signing key is mode `0600`, and the secret
directory is mode `0700`, owned by the image's UID 1000. Neither secret file
belongs in Git. Do not regenerate the key on restart.

```bash
docker compose --env-file .env -f compose.yaml config --quiet
docker compose --env-file .env -f compose.yaml up -d --wait
```

Back up the existing Caddyfile, add the `/poc/monitor-alerts` route from
`hail-server-ts/deploy/poc/Caddyfile`, and validate the candidate with
`caddy validate --adapter caddyfile` before replacement. The POC has Caddy's
admin API disabled, so restart its container after changing the configuration.
Check both providers' HTTPS readiness after the restart. An unsigned POST to
the webhook must return `401`, not a successful acknowledgement.

## Enroll, operate and recover

Use the reviewed **current** CID from the private PLC's complete validated log:

```bash
docker compose --env-file .env -f compose.yaml exec plc-monitor \
  bun src/cli/enroll.ts "$did" "$current_cid" https://hailproto.app/poc/monitor-alerts
docker compose --env-file .env -f compose.yaml exec plc-monitor bun src/cli/poll.ts
docker compose --env-file .env -f compose.yaml exec plc-monitor bun src/cli/notify.ts
docker compose --env-file .env -f compose.yaml logs plc-monitor
docker compose --env-file .env -f compose.yaml exec monitor-db \
  psql -U monitor -d monitor -c 'SELECT last_seq,last_healthy_at FROM monitor_cursor;'
docker compose --env-file .env -f compose.yaml exec monitor-db \
  psql -U monitor -d monitor -c 'SELECT id,did,category,attempt_count,sent_at FROM monitor_alerts;'
```

A legitimate change is still unexpected until local review approves its exact
CID and complete document-data state. Copy only that reviewed public JSON to
the monitor, then invoke `bun src/cli/approve.ts "$did" "$cid" reviewed.json`.
The observation must already be in the sequenced export. Approval never
silently follows an unexpected operation; delivery acknowledgement is recorded
separately. The POC receiver verifies alert authenticity before returning `204`.

For a disposable exercise, run `bun deploy/poc/create-proof.ts <new-artifact-file>`
from the monitor checkout **on the user device**. It creates a genesis, a planned
app → dev endpoint/messaging-key change and a further unexpected alias change,
and validates the complete operation chain. Its ephemeral private keys stay in
process memory and are never exported. The output contains only signed public
operations and the reviewed planned state. Submit the operations one at a time
to the private PLC: enroll after genesis, wait for each sequenced observation,
verify signed alert delivery, approve only the planned change, then assert that
the second change leaves the approved CID unchanged. This PLC-only DID has no
provider account and must not replace a real user's DID.

Restart with `docker compose --env-file .env -f compose.yaml restart`; retain
both volumes, `.env` and the existing signing key. Monitor health requires a
successful poll within five minutes. A downtime exceeding 24 hours records
lost coverage; never reset the cursor to hide a gap. Back up `monitor-db` with
`pg_dump -Fc` and verify with `pg_restore --list`; retain the encrypted/secure
key backup and receiver SQLite backup too. Restore the cursor consistently
with the private PLC history. Removing the monitor stack does not undo PLC
operations or reset alert history.

To stop the monitor, use Compose `stop`; to withdraw the POC endpoint, restore
the previous validated Caddyfile and restart Caddy. Do not use `down -v` for
routine stop/restart.

## Live verification: October 6, 2026

- Deployed all three services on the existing VPS with image
  `sha256:b6f2c14cbbf2a9814fcfe576ff406921a9073494d78345bca91eeceff10d10cb`.
- Public monitor key:
  `did:key:z6MkohEnAtNDRXp1Rf4BXm6eM472mqSn5gU2bay3RYyidXWs`.
- Ingested the private PLC export from sequence zero through its existing six
  entries; enrolled all four existing POC DIDs at their reviewed current CIDs.
- Disposable proof DID: `did:plc:bckxabzar6s35y3csrx46rav`. Genesis, planned
  endpoint/key change and unexpected alias change advanced the export to 9.
  Observed three operations and delivered two signed HTTPS alerts. The planned
  change first produced an alert, then explicit approval retained CID
  `bafyreigkxqpfcueggy3ngvixkcc7jnijyimhwuh7z3htz3n2dw7g4gvnfi`.
  Unexpected CID
  `bafyreifz45iagkqksufpjgdxrxepuztycrkzpjoh7fumyzl7runodmtdpi` did not
  overwrite it. Repeated polls produced no duplicate alerts.
- Receiver persisted the two authenticated alert IDs
  `69276834-632f-4d62-80a0-9f9faaea844d` and
  `805e3716-eea5-400e-871c-dcef328f9d3d`. Restarted monitor and receiver:
  cursor 9, two acknowledged alerts and two receipts persisted. No production
  attestation origin was configured.
- Both providers remained ready; unsigned webhook requests returned `401`.
  Local typecheck/build and all nine tests passed, including PostgreSQL
  integration tests on a disposable local database. This proves functionality
  and same-host restart durability, not independence or cross-host alerting.
- Same-host post-proof backup directory:
  `/var/backups/hail-poc/post-monitor-proof-20261006` (mode `0700`). It retains
  verified custom-format monitor/PLC dumps, a consistent serialized receipt
  database, and mode-`0600` monitor environment/signing-key copies. It is not an
  independent or host-loss backup.
