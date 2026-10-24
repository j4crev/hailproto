#!/bin/sh
set -eu

root=/opt/hailproto
deploy=$root/apps/server/deploy/public
compose="docker compose --env-file $deploy/.env -f $deploy/compose.yaml"
postgres=/etc/hail-provider-postgres/compose.yaml
# Database storage/major version survives application release rollbacks.
if [ -f "$postgres" ]; then
  compose="$compose -f $postgres"
fi

case "${1:-}" in
  status)
    $compose ps
    curl --fail --silent --show-error https://haili.app/health/ready
    ;;
  restart)
    $compose restart provider
    curl --fail --retry 12 --retry-delay 5 --retry-all-errors --silent --show-error https://haili.app/health/ready
    ;;
  logs)
    case "${2:-}" in provider|db|caddy) service=$2;; *) echo "usage: $0 logs provider|db|caddy" >&2; exit 2;; esac
    case "${3:-200}" in *[!0-9]*|'') exit 2;; esac
    [ "${3:-200}" -le 2000 ] || exit 2
    $compose logs --no-color --tail "${3:-200}" "$service"
    ;;
  backup)
    exec /usr/local/sbin/hail-provider-backup
    ;;
  signup-monitor-configure)
    [ "$#" -eq 1 ] || exit 2
    exec python3 "$root/apps/server/deploy/public/configure-signup-monitor.py"
    ;;
  deploy)
    commit=${2:-}
    printf '%s' "$commit" | grep -Eq '^[0-9a-f]{40}$' || { echo "deploy requires a full commit SHA" >&2; exit 2; }
    [ -z "$(git -C "$root" status --porcelain)" ] || { echo "deployment checkout is not clean" >&2; exit 1; }
    /usr/local/sbin/hail-provider-backup
    git -C "$root" fetch --quiet origin "$commit"
    git -C "$root" cat-file -e "$commit^{commit}"
    old_commit=$(git -C "$root" rev-parse HEAD)
    old_image=$(docker inspect hail-public-provider-provider-1 --format '{{.Image}}')
    git -C "$root" checkout --quiet --detach "$commit"
    if $compose config --quiet && $compose build provider && $compose up -d db provider &&
      curl --fail --retry 12 --retry-delay 5 --retry-all-errors --silent --show-error https://haili.app/health/ready; then
      printf '%s %s\n' "$old_commit" "$old_image" > /var/lib/hail-provider-previous
    else
      git -C "$root" checkout --quiet --detach "$old_commit"
      docker tag "$old_image" hail-server-ts:public
      $compose up -d --force-recreate provider
      exit 1
    fi
    ;;
  rollback)
    read -r commit image < /var/lib/hail-provider-previous
    git -C "$root" checkout --quiet --detach "$commit"
    docker tag "$image" hail-server-ts:public
    $compose up -d --force-recreate provider
    curl --fail --retry 12 --retry-delay 5 --retry-all-errors --silent --show-error https://haili.app/health/ready
    ;;
  *)
    echo "usage: $0 status|restart|logs|backup|signup-monitor-configure|deploy|rollback" >&2
    exit 2
    ;;
esac
