#!/bin/sh
set -eu
[ "$(id -u)" = 0 ] || { echo 'Use the Hetzner provider root console' >&2; exit 1; }
[ "$(tailscale ip -4)" = 100.89.223.70 ] || { echo 'Wrong VPS; POC is outside scope' >&2; exit 1; }
umask 077
source=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
cd "$source"
sha256sum --check --strict SHA256SUMS
stage=$(mktemp -d /var/lib/hail-pg18-provider-stage.XXXXXX)
for file in run.sh upgrade-pg18-provider.py pg14_checks.py provider-ops.sh backup.sh check-pg18-clone.ts check-monitor-api.sh plan.json backup.gpg SHA256SUMS; do
  cp "$source/$file" "$stage/$file"
done
cd "$stage"
sha256sum --check --strict SHA256SUMS
chmod 600 ./*
python3 - "$stage" <<'PY'
import hashlib
import json
from pathlib import Path
import sys
stage=Path(sys.argv[1]);path=stage/'plan.json';plan=json.loads(path.read_text())
expected={'/usr/local/sbin/hail-provider-ops':'963e376172b6d256ba8d09a92fc26afb5f7400d88633244e0d9668e06ee23fb7',
          '/usr/local/sbin/hail-provider-backup':'2f2f1b0e01427fa8f550bbbdaac4cc00bdc9747184073aea5e12fecc760e4306'}
for file,checksum in expected.items():
    if hashlib.sha256(Path(file).read_bytes()).hexdigest()!=checksum:
        raise SystemExit('Installed operations/backup script changed; review instead of overwriting')
deploy=Path('/opt/hailproto/apps/server/deploy/public')
plan['protected_files']={**expected,**{str(file):hashlib.sha256(file.read_bytes()).hexdigest() for file in [deploy/'.env',deploy/'compose.yaml']}}
path.write_text(json.dumps(plan,indent=2)+'\n')
PY
unit="hail-provider-pg18-$(date +%s)"
if systemd-run --unit "$unit" --wait --collect --property=Type=exec \
    --property=KillMode=control-group --property=StandardOutput=journal --property=StandardError=journal \
    env PYTHONDONTWRITEBYTECODE=1 python3 "$stage/upgrade-pg18-provider.py"; then
  journalctl -u "$unit" --no-pager -n 40
  echo 'Haili migration completed; retrieve the sanitized report and new encrypted backup.'
else
  result=$?
  journalctl -u "$unit" --no-pager -n 50
  echo 'STOP: inspect the report; do not rerun, delete volumes or restore old data.' >&2
  exit "$result"
fi
