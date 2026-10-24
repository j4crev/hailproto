#!/bin/sh
set -eu
[ "$(id -u)" = 0 ] || { echo 'Use the monitor root console' >&2; exit 1; }
[ "$(tailscale ip -4)" = 100.102.184.47 ] || { echo 'Wrong VPS; POC is outside scope' >&2; exit 1; }
umask 077
source=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
cd "$source"
sha256sum --check --strict SHA256SUMS
# Never execute operator-writable code later from a privileged background unit.
stage=$(mktemp -d /var/lib/hail-pg18-stage.XXXXXX)
for file in run.sh upgrade-pg18-monitor.py pg14_checks.py monitor-ops.sh enrollment-setup.py plan.json SHA256SUMS; do
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
wrapper=Path('/usr/local/sbin/hail-monitor-ops')
if hashlib.sha256(wrapper.read_bytes()).hexdigest()!='bf27f41a62f32e093fb9f1693913e9d49be0842718b95038af00cc25ba62dc00':
    raise SystemExit('Installed operations wrapper changed; review instead of overwriting')
config=Path('/etc/hail-monitor-enrollment');legacy=Path('/opt/hail/hail-plc-monitor-ts/deploy/public')
files=[wrapper,config/'active',config/'compose.override.json',config/'enrollment.env',legacy/'.env',legacy/'compose.yaml']
plan['protected_files']={str(file):hashlib.sha256(file.read_bytes()).hexdigest() for file in files}
plan['protected_files'][str(wrapper)]='bf27f41a62f32e093fb9f1693913e9d49be0842718b95038af00cc25ba62dc00'
path.write_text(json.dumps(plan,indent=2)+'\n')
PY
unit="hail-monitor-pg18-$(date +%s)"
if systemd-run --unit "$unit" --wait --collect --property=Type=exec \
    --property=KillMode=control-group --property=StandardOutput=journal --property=StandardError=journal \
    env PYTHONDONTWRITEBYTECODE=1 python3 "$stage/upgrade-pg18-monitor.py"; then
  journalctl -u "$unit" --no-pager -n 40
  echo 'Monitor migration completed; retrieve the sanitized report before proceeding to Haili.'
else
  result=$?
  journalctl -u "$unit" --no-pager -n 50
  echo 'STOP: inspect report and retained volumes; do not rerun or restore old data.' >&2
  exit "$result"
fi
