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

# Serialize release mutations so another build cannot replace the public tag
# between image inspection, retention and rollback-record publication.
case "${1:-}" in
  deploy|rollback)
    exec 9>/var/lib/hail-provider-deploy.lock
    flock -n 9 || { echo "another provider deployment or rollback is running" >&2; exit 1; }
    ;;
esac

verify_image() {
  actual=$(docker image inspect "$1" --format '{{.Id}}') || {
    echo "rollback image unavailable; release unchanged" >&2; return 1;
  }
  [ "$actual" = "$2" ] || { echo "rollback image identity mismatch; release unchanged" >&2; return 1; }
}

restore_release() {
  # Verify before changing either Git or the public tag. Never rebuild/pull here.
  verify_image "$2" "$3"
  git -C "$root" cat-file -e "$1^{commit}"
  git -C "$root" checkout --quiet --detach "$1"
  docker tag "$2" hail-server-ts:public
  $compose up -d --no-build --pull never --force-recreate gui provider
  curl --fail --retry 12 --retry-delay 5 --retry-all-errors --silent --show-error https://haili.app/health/ready
}

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
    # A saved ID alone does not retain an image in Docker's containerd store.
    # Use its full digest so rebuilding the same commit cannot overwrite it.
    printf '%s' "$old_image" | grep -Eq '^sha256:[0-9a-f]{64}$' || exit 1
    retained_image="hail-server-ts:rollback-${old_image#sha256:}"
    docker tag "$old_image" "$retained_image"
    verify_image "$retained_image" "$old_image"
    git -C "$root" checkout --quiet --detach "$commit"
    if $compose config --quiet && $compose build provider && $compose up -d db provider &&
      curl --fail --retry 12 --retry-delay 5 --retry-all-errors --silent --show-error https://haili.app/health/ready; then
      umask 077
      record=$(mktemp /var/lib/hail-provider-previous.XXXXXX)
      printf '%s %s %s\n' "$old_commit" "$retained_image" "$old_image" > "$record"
      mv "$record" /var/lib/hail-provider-previous
    else
      restore_release "$old_commit" "$retained_image" "$old_image"
      exit 1
    fi
    ;;
  rollback)
    read -r commit image expected extra < /var/lib/hail-provider-previous
    # Old two-field records never retained the image. Fail before checkout.
    [ -z "$extra" ] && printf '%s' "$commit" | grep -Eq '^[0-9a-f]{40}$' || exit 1
    printf '%s' "$expected" | grep -Eq '^sha256:[0-9a-f]{64}$' || {
      echo "rollback record lacks a verified retained image; use a reviewed deployment" >&2; exit 1;
    }
    [ "$image" = "hail-server-ts:rollback-${expected#sha256:}" ] || exit 1
    restore_release "$commit" "$image" "$expected"
    ;;
  *)
    echo "usage: $0 status|restart|logs|backup|signup-monitor-configure|deploy|rollback" >&2
    exit 2
    ;;
esac
