#!/bin/sh
set -eu
[ "$(id -u)" -eq 0 ] || { echo 'Use the Hostinger monitor root console.' >&2; exit 1; }
[ "$(tailscale ip -4)" = 100.102.184.47 ] || { echo 'Wrong VPS.' >&2; exit 1; }
stage=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
sha256sum --check "$stage/SHA256SUMS"
echo 'Starting guarded minor update under systemd; enrollment/monitoring will pause briefly.'
echo 'No database volume is deleted or restored. No recovery key is needed on this VPS.'
started=$(date +%s)
if systemd-run --unit=hail-monitor-pg14-upgrade --collect --wait --property=Type=exec \
  /usr/bin/python3 -B "$stage/upgrade.py"; then
  exit 0
else
  result=$?
  echo 'Maintenance did not finish successfully. Recent operator log:' >&2
  journalctl -u hail-monitor-pg14-upgrade.service --since "@$started" --no-pager -n 35 -o cat || true
  exit "$result"
fi
