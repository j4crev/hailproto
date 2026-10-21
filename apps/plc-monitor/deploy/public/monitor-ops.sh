#!/bin/sh
set -eu

root=/opt/hail/hail-plc-monitor-ts
deploy=/opt/hail/hail-plc-monitor-ts/deploy/public
compose="docker compose --env-file $deploy/.env -f $deploy/compose.yaml"

case "${1:-}" in
  status)
    $compose ps
    systemctl --no-pager status hail-monitor-heartbeat.timer
    ;;
  restart)
    $compose restart monitor
    $compose ps monitor
    ;;
  logs)
    case "${2:-}" in monitor|db) service=$2;; *) echo "usage: $0 logs monitor|db" >&2; exit 2;; esac
    case "${3:-200}" in *[!0-9]*|'') exit 2;; esac
    [ "${3:-200}" -le 2000 ] || exit 2
    $compose logs --no-color --tail "${3:-200}" "$service"
    ;;
  deploy)
    commit=${2:-}
    printf '%s' "$commit" | grep -Eq '^[0-9a-f]{40}$' || { echo "deploy requires a full commit SHA" >&2; exit 2; }
    [ -z "$(git -C "$root" status --porcelain)" ] || { echo "deployment checkout is not clean" >&2; exit 1; }
    git -C "$root" fetch --quiet origin "$commit"
    git -C "$root" cat-file -e "$commit^{commit}"
    git -C "$root" checkout --quiet --detach "$commit"
    $compose config --quiet
    $compose build monitor
    $compose up -d monitor
    $compose ps monitor
    ;;
  *) echo "usage: $0 status|restart|logs|deploy" >&2; exit 2;;
esac
