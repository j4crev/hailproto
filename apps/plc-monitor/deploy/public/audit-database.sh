#!/bin/sh
# Read-only version/image audit. Does not print database credentials or app data.
set -eu
[ "$(id -u)" -eq 0 ] || { echo 'Use the monitor root console.' >&2; exit 1; }
[ "$(tailscale ip -4)" = 100.102.184.47 ] || { echo 'This is not the approved monitor.' >&2; exit 1; }
umask 077
directory=$(mktemp -d /var/lib/hail-db-audit.XXXXXX)
report=$directory/report.txt
run() {
  printf '\nCommand:'
  printf ' %s' "$@"
  printf '\n'
  if "$@"; then :; else printf 'Command exit status: %s\n' "$?"; fi
}
{
  run date -u
  run docker exec hail-public-monitor-db-1 postgres --version
  run docker exec -e 'PGOPTIONS=-c default_transaction_read_only=on' \
    hail-public-monitor-db-1 psql -X -v ON_ERROR_STOP=1 -U monitor -d monitor -At \
    -c 'SELECT version(); SHOW server_version_num;'
  run docker inspect hail-public-monitor-db-1 \
    --format 'Image reference: {{.Config.Image}}; image ID: {{.Image}}; health: {{.State.Health.Status}}'
  if image=$(docker inspect hail-public-monitor-db-1 --format '{{.Image}}'); then
    run docker image inspect "$image" --format 'Tags: {{json .RepoTags}}; digests: {{json .RepoDigests}}'
    # Inspect immutable image contents too, without attaching the live data volume.
    run docker run --rm --pull=never --network none --entrypoint postgres "$image" --version
  fi
  # Compose config includes secrets; filter its output before writing the report.
  run python3 -c '
import json,subprocess
result=subprocess.run(["docker","compose",
 "--env-file","/opt/hail/hail-plc-monitor-ts/deploy/public/.env",
 "--env-file","/etc/hail-monitor-enrollment/enrollment.env",
 "-f","/opt/hail/hail-plc-monitor-ts/deploy/public/compose.yaml",
 "-f","/etc/hail-monitor-enrollment/compose.override.json","config","--format","json"],capture_output=True,text=True)
if result.returncode: raise SystemExit("Compose inspection failed; configuration output withheld")
print("Configured database image:",json.loads(result.stdout)["services"]["db"]["image"])
'
} > "$report" 2>&1
chown root:hailops "$directory" "$report"
chmod 0750 "$directory"
chmod 0640 "$report"
printf 'Read-only database audit saved: %s\n' "$report"
