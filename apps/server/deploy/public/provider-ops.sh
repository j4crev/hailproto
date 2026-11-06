#!/bin/sh
set -eu

root=/opt/hail
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
  deploy|rollback|image-retention)
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

# Check both legacy Docker and containerd stores, plus checkout/backup storage.
check_space() {
  minimum=$1
  docker_root=$(docker info --format '{{.DockerRootDir}}')
  [ -n "$docker_root" ] && [ -d "$docker_root" ] || { echo "cannot locate Docker storage" >&2; return 1; }
  for storage in / /var/lib "$root" "$docker_root" /var/lib/containerd; do
    [ -d "$storage" ] || continue
    available=$(df -Pk "$storage" | awk 'NR==2 {print $4}')
    case "$available" in ''|*[!0-9]*) echo "cannot measure free space: $storage" >&2; return 1;; esac
    echo "storage $storage: $available KiB available (minimum $minimum KiB)"
    [ "$available" -ge "$minimum" ] || { echo "insufficient disk space; clean up reviewed unused images/cache before retrying" >&2; return 1; }
  done
}

# Only wrapper-owned rollback images are candidates. No global Docker pruning.
image_retention() {
  python3 - /var/lib/hail-provider-previous "$1" <<'PY_RETENTION'
import json
import re
import subprocess
import sys
from pathlib import Path

DIGEST = re.compile(r"sha256:[0-9a-f]{64}")
TAG = re.compile(r"(?:hail-server-ts|hail-web-client):rollback-([0-9a-f]{64})")
REPOSITORIES = {
    "ghcr.io/j4crev/hail/provider", "ghcr.io/j4crev/hail/provider-web-client",
    "ghcr.io/j4crev/hailproto/provider", "ghcr.io/j4crev/hailproto/provider-web-client",
}

def docker(*args):
    return subprocess.check_output(["docker", *args], text=True).strip()

def inspect(ref):
    value = json.loads(docker("image", "inspect", ref, "--format", "{{json .}}"))
    if not DIGEST.fullmatch(value["Id"]):
        raise ValueError("invalid image identity")
    return value

def protected_images():
    record = Path(sys.argv[1]).read_text().split()
    if len(record) not in (3, 5) or not re.fullmatch(r"[0-9a-f]{40}", record[0]):
        raise ValueError("missing or invalid verified rollback record")
    protected = set()
    for offset, repository in ((1, "hail-server-ts"), (3, "hail-web-client")):
        if offset >= len(record):
            continue
        ref, identity = record[offset:offset+2]
        if not DIGEST.fullmatch(identity) or ref != repository + ":rollback-" + identity[7:]:
            raise ValueError("invalid rollback reference")
        if inspect(ref)["Id"] != identity:
            raise ValueError("rollback image identity mismatch")
        protected.add(identity)
    # Include stopped containers and non-provider services as well.
    containers = docker("ps", "-aq").splitlines()
    if not containers:
        raise ValueError("no containers found; refusing cleanup")
    for container in containers:
        identity = docker("inspect", container, "--format", "{{.Image}}")
        if not DIGEST.fullmatch(identity):
            raise ValueError("invalid container image identity")
        protected.add(identity)
    # Require the two production services to exist even if other containers do.
    for service in ("hail-public-provider-provider-1", "hail-public-provider-gui-1"):
        identity = docker("inspect", service, "--format", "{{.Image}}")
        if identity not in protected:
            raise ValueError("running service inventory changed")
    return protected

def candidates(protected):
    tags = docker("image", "ls", "--format", "{{.Repository}}:{{.Tag}}").splitlines()
    found = {}
    for tag in tags:
        match = TAG.fullmatch(tag)
        if not match:
            continue
        data = inspect(tag)
        identity = data["Id"]
        if identity != "sha256:" + match[1]:
            raise ValueError("rollback tag identity mismatch: " + tag)
        if identity in protected:
            continue
        aliases = data.get("RepoTags") or []
        digests = data.get("RepoDigests") or []
        # Leave manually retained/foreign aliases alone, even on an old release.
        if not aliases or any(not TAG.fullmatch(alias) or TAG.fullmatch(alias)[1] != identity[7:] for alias in aliases):
            print("Keep (additional alias): " + identity)
            continue
        if any(ref.split("@")[0] not in REPOSITORIES or not DIGEST.fullmatch(ref.split("@")[-1]) for ref in digests):
            print("Keep (other repository): " + identity)
            continue
        found[identity] = sorted(aliases)
    return found

try:
    plan = candidates(protected_images())
    for identity, aliases in sorted(plan.items()):
        print("Remove: " + identity + " " + " ".join(aliases), flush=True)
    print(f"{len(plan)} obsolete rollback image(s); mode={sys.argv[2]}", flush=True)
    if sys.argv[2] == "apply":
        # Revalidate the whole plan before any deletion; serialize with deploy.
        if candidates(protected_images()) != plan:
            raise ValueError("image inventory changed; rerun the report")
        for aliases in plan.values():
            # Digest references are removed by Docker with the final tag. Never
            # force deletion or prune parent images, containers, volumes or cache.
            subprocess.run(["docker", "image", "rm", "--no-prune", *aliases], check=True)
except (OSError, ValueError, KeyError, TypeError, subprocess.CalledProcessError) as error:
    print("Image retention stopped: " + str(error), file=sys.stderr)
    sys.exit(1)
PY_RETENTION
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
    check_space 0
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
  image-retention)
    case "$#:${2:-}" in 1:) image_retention report;; 2:--apply) image_retention apply;; *) echo "usage: $0 image-retention [--apply]" >&2; exit 2;; esac
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
    check_space 3145728
    # Verify both candidates before changing the running release. Never build here.
    for selected in "$image" "$client_image"; do
      docker pull "$selected"
      revision=$(docker image inspect "$selected" --format '{{index .Config.Labels "org.opencontainers.image.revision"}}')
      [ "$revision" = "$commit" ] || { echo "image revision does not match requested commit" >&2; exit 1; }
    done
    check_space 1048576
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
      # A cleanup problem must not roll back an otherwise healthy release.
      if ! image_retention apply; then
        echo "WARNING: deployment succeeded, but image retention needs operator attention" >&2
      fi
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
    echo "usage: $0 status|restart|logs|backup|signup-monitor-configure|deploy|rollback|image-retention" >&2
    exit 2
    ;;
esac
