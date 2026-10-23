#!/bin/sh
# Inspect networking/firewalls only. Writes one root-owned, hailops-readable report.
set -eu
if [ "$(id -u)" -ne 0 ]; then
  echo 'Run this audit from the VPS root console.' >&2
  exit 1
fi
umask 077
directory=$(mktemp -d /var/lib/hail-fw-audit.XXXXXX)
report=$directory/report.txt

run() {
  printf '\nCommand:'
  printf ' %s' "$@"
  printf '\n'
  if "$@"; then :; else printf 'Command exit status: %s\n' "$?"; fi
}

{
  run date -u
  run hostname
  run ip -brief address
  run ip -4 route show
  run ip -6 route show
  run ss -lntup
  run tailscale ip
  run systemctl show ufw.service nftables.service firewalld.service docker.service tailscaled.service \
    -p Id -p LoadState -p ActiveState -p UnitFileState -p FragmentPath -p DropInPaths
  run ufw status verbose
  run grep -E '^(IPV6|DEFAULT_(INPUT|OUTPUT|FORWARD)_POLICY)=' /etc/default/ufw
  run iptables --version
  run iptables-save
  run ip6tables-save
  run nft list ruleset
  run sysctl net.ipv4.ip_forward net.ipv6.conf.all.forwarding
  run docker version --format '{{.Server.Version}}'
  run docker ps --format '{{.Names}}\t{{.Image}}\t{{.Ports}}'
  # Never dump the Docker config or application environment: inspect only network flags.
  run python3 -c '
import json
from pathlib import Path
path=Path("/etc/docker/daemon.json")
if path.exists():
    data=json.loads(path.read_text())
    keys=("iptables","ip6tables","firewall-backend","ip-forward","ipv6","fixed-cidr-v6","allow-direct-routing","userland-proxy")
    print(json.dumps({key:data[key] for key in keys if key in data},indent=2))
else:
    print("No /etc/docker/daemon.json")
'
} > "$report" 2>&1

chown root:hailops "$directory" "$report"
chmod 0750 "$directory"
chmod 0640 "$report"
printf 'Audit saved: %s\nNo active network or firewall settings changed.\n' "$report"
