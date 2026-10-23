#!/bin/sh
# Console-approved provider contraction, with a timed configuration-only rollback.
set -eu
[ "$(id -u)" -eq 0 ] || { echo 'Use the provider root console.' >&2; exit 1; }
[ "$(tailscale ip -4)" = 100.89.223.70 ] || { echo 'This is not the approved provider.' >&2; exit 1; }
stage=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
deploy=/opt/hailproto/apps/server/deploy/public
unit=hail-provider-ingress-rollback
if systemctl is-active --quiet "$unit.timer"; then
  echo 'A rollback timer is already active; inspect it before retrying.' >&2
  exit 1
fi
sha256sum --check "$stage/SHA256SUMS"
echo '9d8fb4a9cb541de298b2f109a3181cb70b1efd18833044ab300e24fa7f8ccb4f  /opt/hailproto/apps/server/deploy/public/Caddyfile' | sha256sum --check
echo '1abb3f8a40a35513adfce41503f8464cac783401f5df586c617b405723b7d85d  /opt/hailproto/apps/server/deploy/public/compose.yaml' | sha256sum --check
ufw status | grep -q '^Status: active$'
systemctl is-active --quiet haili-tunnel.service
curl --fail --silent --show-error --max-time 10 http://127.0.0.1:20241/ready
sh "$stage/check-monitor-api.sh"
docker compose --project-directory "$deploy" --env-file "$deploy/.env" \
  -f "$stage/compose.yaml" config --quiet
docker run --rm --network none -e PROVIDER_DOMAIN=haili.app \
  --mount "type=bind,src=$stage/Caddyfile,dst=/etc/caddy/Caddyfile,readonly" \
  caddy:2.10.2-alpine caddy validate --config /etc/caddy/Caddyfile

umask 077
backup=$(mktemp -d /var/lib/hail-provider-ingress-before.XXXXXX)
cp -p "$deploy/Caddyfile" "$deploy/compose.yaml" "$backup/"
cp -p /etc/ufw/user.rules /etc/ufw/user6.rules "$backup/"
cat > "$backup/rollback.sh" <<EOF
#!/bin/sh
set -eu
cp -p '$backup/Caddyfile' '$deploy/Caddyfile'
cp -p '$backup/compose.yaml' '$deploy/compose.yaml'
cp -p '$backup/user.rules' /etc/ufw/user.rules
cp -p '$backup/user6.rules' /etc/ufw/user6.rules
ufw reload
cd '$deploy'
docker compose --env-file .env config --quiet
docker compose --env-file .env up -d --no-deps --force-recreate caddy
EOF
chmod 0700 "$backup/rollback.sh"
printf '\nRollback: sh %s/rollback.sh\n' "$backup"
systemd-run --unit="$unit" --on-active=15m --collect /bin/sh "$backup/rollback.sh"
echo 'Automatic rollback is armed for 15 minutes. Do not change provider-panel firewalls yet.'

install -o root -g root -m 0644 "$stage/Caddyfile" "$deploy/Caddyfile"
install -o root -g root -m 0644 "$stage/compose.yaml" "$deploy/compose.yaml"
cd "$deploy"
docker compose --env-file .env up -d --no-deps --force-recreate caddy
ufw allow in on tailscale0 to any port 22 proto tcp
ufw --force delete allow OpenSSH
ufw --force delete allow 80/tcp
ufw --force delete allow 443/tcp
ufw --force delete allow 443/udp

curl --fail --retry 12 --retry-delay 5 --retry-all-errors --max-time 10 \
  --silent --show-error https://haili.app/health/ready
sh "$stage/check-monitor-api.sh"
sh "$stage/audit-vps-firewall.sh"
printf '\nRollback remains armed. Report completion so fresh Tailscale SSH and public-port checks can run.\n'
printf 'Only after verification, confirm with: systemctl stop %s.timer\n' "$unit"
