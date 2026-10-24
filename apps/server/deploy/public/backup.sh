#!/bin/sh
set -eu
umask 077

exec 9>/run/hail-provider-backup.lock
flock -n 9 || exit 0
. /etc/hail-provider-backup

name="haili-$(date -u +%Y%m%dT%H%M%SZ).tar.gpg"
work=$(mktemp -d /var/tmp/hail-backup.XXXXXX)
trap 'rm -rf "$work"' EXIT
cd /opt/hailproto/apps/server/deploy/public
compose="docker compose --env-file .env -f compose.yaml"
postgres=/etc/hail-provider-postgres/compose.yaml
if [ -f "$postgres" ]; then compose="$compose -f $postgres"; fi

$compose exec -T db pg_dump -U hail -d hail -Fc > "$work/hail.dump"
cp .env "$work/provider.env"
commit=$(git -C /opt/hailproto rev-parse HEAD)
image=$(docker inspect hail-public-provider-provider-1 --format '{{.Config.Image}}')
database_image=$(docker inspect hail-public-provider-db-1 --format '{{.Config.Image}}')
database_version=$($compose exec -T db psql -X -U hail -d hail -Atq -c 'SHOW server_version_num')
printf '{"createdAt":"%s","host":"haili.app","commit":"%s","image":"%s","databaseImage":"%s","databaseVersion":"%s"}\n' \
  "$(date -u +%FT%TZ)" "$commit" "$image" "$database_image" "$database_version" > "$work/manifest.json"
$compose exec -T db pg_restore --list < "$work/hail.dump" >/dev/null
set -- hail.dump provider.env manifest.json
if [ -f "$postgres" ]; then cp "$postgres" "$work/database-compose.yaml"; set -- "$@" database-compose.yaml; fi
tar -C "$work" -cf "$work/backup.tar" "$@"
gpg --homedir /etc/hail-backup-gnupg --batch --trust-model always \
  --recipient "$BACKUP_RECIPIENT" --encrypt --output "$work/$name" "$work/backup.tar"
digest=$(sha256sum "$work/$name" | cut -d' ' -f1)
export RCLONE_CONFIG_R2_TYPE=s3 RCLONE_CONFIG_R2_PROVIDER=Cloudflare
export RCLONE_CONFIG_R2_ACCESS_KEY_ID=$AWS_ACCESS_KEY_ID RCLONE_CONFIG_R2_SECRET_ACCESS_KEY=$AWS_SECRET_ACCESS_KEY
export RCLONE_CONFIG_R2_ENDPOINT="https://$R2_ACCOUNT_ID.r2.cloudflarestorage.com" RCLONE_CONFIG_R2_NO_CHECK_BUCKET=true
remote="r2:haili-production-backups/provider/$name"
rclone copyto "$work/$name" "$remote"
test "$(rclone cat "$remote" | sha256sum | cut -d' ' -f1)" = "$digest"
curl --fail --silent --show-error --max-time 15 -X POST \
  -H "Authorization: Bearer $BACKUP_HEARTBEAT_TOKEN" https://alerts.plcmonitor.us/backup-heartbeat
logger -t hail-provider-backup "$name verified sha256=$digest"
printf '{"object":"provider/%s","sha256":"%s","bucket":"haili-production-backups","endpoint":"https://%s.r2.cloudflarestorage.com"}\n' \
  "$name" "$digest" "$R2_ACCOUNT_ID"
