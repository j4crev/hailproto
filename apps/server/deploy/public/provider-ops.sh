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

release=/etc/hail-provider-release/compose.json
if [ -f "$release" ]; then compose="$compose -f $release"; fi

# Serialize image selection, replacement and rollback-record publication.
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

select_image() {
  # Persist outside Git so checkout/rollback cannot lose the selected image.
  # Values originate from the validated digest or our retained rollback tag.
  mkdir -p "$(dirname "$release")" || return 1
  staged=$(mktemp "$release.XXXXXX") || return 1
  printf '{"services":{"provider":{"image":"%s"},"gui":{"image":"%s"}}}\n' "$1" "$2" > "$staged" || return 1
  if [ ! -f "$release" ]; then compose="$compose -f $release"; fi
  mv "$staged" "$release"
}

restore_release() {
  # Verify before changing Git or image selection. Never rebuild/pull here.
  verify_image "$2" "$3"
  verify_image "$4" "$5"
  git -C "$root" cat-file -e "$1^{commit}"
  git -C "$root" checkout --quiet --detach "$1"
  select_image "$2" "$4"
  $compose up -d --no-deps --no-build --pull never --force-recreate --wait --wait-timeout 180 gui provider
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
    image=${3:-}
    client_image=${4:-}
    [ "$#" -eq 4 ] || { echo "usage: $0 deploy COMMIT PROVIDER_IMAGE@sha256:DIGEST WEB_CLIENT_IMAGE@sha256:DIGEST" >&2; exit 2; }
    printf '%s' "$commit" | grep -Eq '^[0-9a-f]{40}$' || { echo "deploy requires a full commit SHA" >&2; exit 2; }
    for selected in "$image" "$client_image"; do
      printf '%s' "$selected" | grep -Eq '^ghcr\.io/[a-z0-9._/-]+@sha256:[0-9a-f]{64}$' || { echo "deploy requires GHCR image digests, not tags" >&2; exit 2; }
    done
    [ -z "$(git -C "$root" status --porcelain)" ] || { echo "deployment checkout is not clean" >&2; exit 1; }
    # Verify both candidates before changing the running release. Never build here.
    for selected in "$image" "$client_image"; do
      docker pull "$selected"
      revision=$(docker image inspect "$selected" --format '{{index .Config.Labels "org.opencontainers.image.revision"}}')
      [ "$revision" = "$commit" ] || { echo "image revision does not match requested commit" >&2; exit 1; }
    done
    /usr/local/sbin/hail-provider-backup
    git -C "$root" fetch --quiet origin "$commit"
    git -C "$root" cat-file -e "$commit^{commit}"
    old_commit=$(git -C "$root" rev-parse HEAD)
    old_image=$(docker inspect hail-public-provider-provider-1 --format '{{.Image}}')
    gui_image=$(docker inspect hail-public-provider-gui-1 --format '{{.Image}}')
    # A saved ID alone does not retain an image in Docker's containerd store.
    # Use its full digest so rebuilding the same commit cannot overwrite it.
    printf '%s' "$old_image" | grep -Eq '^sha256:[0-9a-f]{64}$' || exit 1
    printf '%s' "$gui_image" | grep -Eq '^sha256:[0-9a-f]{64}$' || exit 1
    retained_image="hail-server-ts:rollback-${old_image#sha256:}"
    retained_client="hail-web-client:rollback-${gui_image#sha256:}"
    docker tag "$old_image" "$retained_image"
    verify_image "$retained_image" "$old_image"
    docker tag "$gui_image" "$retained_client"
    verify_image "$retained_client" "$gui_image"
    git -C "$root" checkout --quiet --detach "$commit"
    if select_image "$image" "$client_image" && $compose config --quiet &&
      $compose up -d --no-deps --no-build --pull never --force-recreate --wait --wait-timeout 180 gui provider &&
      curl --fail --retry 12 --retry-delay 5 --retry-all-errors --silent --show-error https://haili.app/health/ready; then
      umask 077
      record=$(mktemp /var/lib/hail-provider-previous.XXXXXX)
      printf '%s %s %s %s %s\n' "$old_commit" "$retained_image" "$old_image" "$retained_client" "$gui_image" > "$record"
      mv "$record" /var/lib/hail-provider-previous
    else
      restore_release "$old_commit" "$retained_image" "$old_image" "$retained_client" "$gui_image"
      exit 1
    fi
    ;;
  rollback)
    read -r commit image expected client_image client_expected extra < /var/lib/hail-provider-previous
    # Old two-field records never retained the image. Fail before checkout.
    [ -z "$extra" ] && printf '%s' "$commit" | grep -Eq '^[0-9a-f]{40}$' || exit 1
    printf '%s' "$expected" | grep -Eq '^sha256:[0-9a-f]{64}$' || {
      echo "rollback record lacks a verified retained image; use a reviewed deployment" >&2; exit 1;
    }
    [ "$image" = "hail-server-ts:rollback-${expected#sha256:}" ] || exit 1
    # A pre-split verified record identifies the same retained image for both services.
    if [ -z "$client_image" ] && [ -z "$client_expected" ]; then
      client_image=$image
      client_expected=$expected
    else
      printf '%s' "$client_expected" | grep -Eq '^sha256:[0-9a-f]{64}$' || exit 1
      [ "$client_image" = "hail-web-client:rollback-${client_expected#sha256:}" ] || exit 1
    fi
    restore_release "$commit" "$image" "$expected" "$client_image" "$client_expected"
    ;;
  *)
    echo "usage: $0 status|restart|logs|backup|signup-monitor-configure|deploy|rollback" >&2
    exit 2
    ;;
esac
