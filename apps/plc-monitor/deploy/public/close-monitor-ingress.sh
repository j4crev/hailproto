#!/bin/sh
# Console-approved monitor contraction; public enrollment continues via its tunnel.
set -eu
[ "$(id -u)" -eq 0 ] || { echo 'Use the monitor root console.' >&2; exit 1; }
[ "$(tailscale ip -4)" = 100.102.184.47 ] || { echo 'This is not the approved monitor.' >&2; exit 1; }
stage=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
config=/etc/hail-monitor-enrollment
legacy=/opt/hail/hail-plc-monitor-ts/deploy/public
unit=hail-monitor-ingress-rollback
if systemctl is-active --quiet "$unit.timer"; then
  echo 'A rollback timer is already active; inspect it before retrying.' >&2
  exit 1
fi
compose() {
  docker compose --env-file "$legacy/.env" --env-file "$config/enrollment.env" \
    -f "$legacy/compose.yaml" -f "$config/compose.override.json" "$@"
}
origin_check() {
  status=$(curl --silent --show-error --max-time 10 --output /dev/null --write-out '%{http_code}' \
    http://127.0.0.1:8080/api/v1/onboarding -H 'Host: enroll.plcmonitor.us' \
    -H 'CF-Connecting-IP: 5.161.254.78' -H 'Content-Type: application/json' --data '{}')
  [ "$status" = 401 ] || { printf 'Unexpected local origin status: %s\n' "$status" >&2; exit 1; }
}
sha256sum --check "$stage/SHA256SUMS"
echo '0ac3f369d3a1298bd3b8b215887a45d6931cb6ac697e1b22b9acbe98ce86cf99  /etc/hail-monitor-enrollment/Caddyfile' | sha256sum --check
ufw status | grep -q '^Status: active$'
systemctl is-active --quiet hail-monitor-tunnel.service
curl --fail --silent --show-error --max-time 10 http://127.0.0.1:20241/ready
origin_check
compose config --quiet
docker run --rm --network none \
  --mount "type=bind,src=$stage/Caddyfile,dst=/etc/caddy/Caddyfile,readonly" \
  caddy:2.10.2-alpine caddy validate --config /etc/caddy/Caddyfile

umask 077
backup=$(mktemp -d /var/lib/hail-monitor-ingress-before.XXXXXX)
cp -p "$config/Caddyfile" "$backup/"
cp -p /etc/ufw/user.rules /etc/ufw/user6.rules "$backup/"
cat > "$backup/rollback.sh" <<EOF
#!/bin/sh
set -eu
cp -p '$backup/Caddyfile' '$config/Caddyfile'
cp -p '$backup/user.rules' /etc/ufw/user.rules
cp -p '$backup/user6.rules' /etc/ufw/user6.rules
ufw reload
docker compose --env-file '$legacy/.env' --env-file '$config/enrollment.env' \\
  -f '$legacy/compose.yaml' -f '$config/compose.override.json' \\
  up -d --no-deps --force-recreate enrollment-edge
EOF
chmod 0700 "$backup/rollback.sh"
printf '\nRollback: sh %s/rollback.sh\n' "$backup"
systemd-run --unit="$unit" --on-active=15m --collect /bin/sh "$backup/rollback.sh"
echo 'Automatic rollback is armed for 15 minutes. Do not change provider-panel firewalls yet.'

install -o root -g root -m 0600 "$stage/Caddyfile" "$config/Caddyfile"
compose up -d --no-deps --force-recreate enrollment-edge
ufw allow in on tailscale0 to any port 22 proto tcp
ufw --force delete allow OpenSSH
ufw --force delete allow 80/tcp
ufw --force delete allow 443/tcp
origin_check
docker exec hail-public-monitor-monitor-1 bun --eval '
const token=process.env.MONITOR_ENROLLMENT_TOKEN;
if(!token)throw new Error("Missing monitor token");
for(const [authenticated,expected] of [[false,401],[true,400]]){
  const headers=new Headers({"Content-Type":"application/json"});
  if(authenticated)headers.set("Authorization","Bearer "+token);
  const response=await fetch("http://127.0.0.1:3001/api/v1/onboarding",{
    method:"POST",headers,body:"{}",redirect:"error",signal:AbortSignal.timeout(15000)
  });
  await response.body?.cancel();
  console.log((authenticated?"Local API with token: ":"Local API without token: ")+response.status);
  if(response.status!==expected)process.exit(1);
}'
sh "$stage/audit-vps-firewall.sh"
printf '\nRollback remains armed. Report completion for fresh SSH, tunnel, enrollment and direct-port checks.\n'
printf 'Only after verification, confirm with: systemctl stop %s.timer\n' "$unit"
