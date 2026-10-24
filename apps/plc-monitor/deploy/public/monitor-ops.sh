#!/bin/sh
set -eu

root=/opt/hail/hail-plc-monitor-ts
deploy=/opt/hail/hail-plc-monitor-ts/deploy/public
compose="docker compose --env-file $deploy/.env -f $deploy/compose.yaml"
enrollment=/etc/hail-monitor-enrollment
if [ -f "$enrollment/active" ]; then
  root=/opt/hailproto
  compose="docker compose --env-file $deploy/.env --env-file $enrollment/enrollment.env -f $deploy/compose.yaml -f $enrollment/compose.override.json"
fi
postgres=$enrollment/compose.postgres.yaml
if [ -f "$postgres" ]; then
  [ -f "$enrollment/active" ] || { echo 'Database overlay requires the active monitor bridge' >&2; exit 1; }
  compose="$compose -f $postgres"
fi
setup=$root/apps/plc-monitor/deploy/public/enrollment-setup.py
# Installed with the DB overlay; backups/verification survive app-release rollback.
if [ -f "$enrollment/operations.py" ]; then setup=$enrollment/operations.py; fi

case "${1:-}" in
  status)
    $compose ps
    systemctl --no-pager status hail-monitor-heartbeat.timer
    if [ -f "$enrollment/active" ]; then
      python3 -c 'import json; s=json.load(open("/etc/hail-monitor-enrollment/rollout.json")); print(json.dumps({k:s.get(k) for k in ("apiOrigin","monitorPublicKey","commit","backup")}))'
    fi
    ;;
  restart)
    $compose restart monitor
    $compose ps monitor
    ;;
  logs)
    case "${2:-}" in monitor|db|enrollment-edge) service=$2;; *) echo "usage: $0 logs monitor|db|enrollment-edge" >&2; exit 2;; esac
    case "${3:-200}" in *[!0-9]*|'') exit 2;; esac
    [ "${3:-200}" -le 2000 ] || exit 2
    $compose logs --no-color --tail "${3:-200}" "$service"
    ;;
  backup)
    [ -f "$enrollment/active" ] || { echo "enrollment backup configuration is not installed" >&2; exit 1; }
    exec python3 "$setup" --backup
    ;;
  deploy)
    commit=${2:-}
    printf '%s' "$commit" | grep -Eq '^[0-9a-f]{40}$' || { echo "deploy requires a full commit SHA" >&2; exit 2; }
    [ -z "$(git -C "$root" status --porcelain)" ] || { echo "deployment checkout is not clean" >&2; exit 1; }
    [ ! -f "$enrollment/active" ] || python3 "$setup" --backup
    git -C "$root" fetch --quiet origin "$commit"
    git -C "$root" cat-file -e "$commit^{commit}"
    old_commit=$(git -C "$root" rev-parse HEAD)
    old_image=$(docker inspect hail-public-monitor-monitor-1 --format '{{.Image}}')
    git -C "$root" checkout --quiet --detach "$commit"
    if $compose config --quiet && $compose build monitor && $compose up -d --no-deps monitor &&
      { [ ! -f "$enrollment/active" ] || python3 "$setup" --verify; }; then
      if [ -f "$enrollment/active" ]; then
        printf '%s %s\n' "$old_commit" "$old_image" > /var/lib/hail-monitor-enrollment/previous-release
      fi
    else
      git -C "$root" checkout --quiet --detach "$old_commit"
      docker tag "$old_image" hail-plc-monitor-ts:public
      $compose up -d --no-deps --force-recreate monitor
      exit 1
    fi
    $compose ps monitor
    ;;
  rollback)
    [ -f "$enrollment/active" ] || { echo "legacy rollback requires console review" >&2; exit 1; }
    if [ ! -f /var/lib/hail-monitor-enrollment/previous-release ]; then
      [ ! -f "$postgres" ] || { echo 'Legacy runtime rollback requires review after the database migration' >&2; exit 1; }
      exec python3 "$setup" --rollback-legacy
    fi
    [ -z "$(git -C "$root" status --porcelain)" ] || exit 1
    read -r commit image < /var/lib/hail-monitor-enrollment/previous-release
    git -C "$root" checkout --quiet --detach "$commit"
    docker tag "$image" hail-plc-monitor-ts:public
    $compose up -d --no-deps --force-recreate monitor
    python3 "$setup" --verify
    ;;
  *) echo "usage: $0 status|restart|logs|backup|deploy|rollback" >&2; exit 2;;
esac
