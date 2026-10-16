#!/usr/bin/env bash
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
mode=production
env_file="$SCRIPT_DIR/.env.prod"
migration_env="$REPO_ROOT/.env.migration"
image_override=''
while [ "$#" -gt 0 ]; do
  case "$1" in
    --rehearsal) mode=rehearsal; shift ;;
    --production) mode=production; shift ;;
    --no-pull|-n) shift ;; # Update code before running this script.
    --image|--env-file|--migration-env-file)
      [ "$#" -ge 2 ] || { echo "Missing value for $1" >&2; exit 2; }
      case "$1" in
        --image) image_override="$2" ;;
        --env-file) env_file="$2" ;;
        --migration-env-file) migration_env="$2" ;;
      esac
      shift 2 ;;
    *) echo 'Usage: bash deploy/deploy.sh [--rehearsal|--production] [--image EXISTING_LOCAL_IMAGE] [--env-file PATH] [--migration-env-file PATH]' >&2; exit 2 ;;
  esac
done
[ -f "$env_file" ] || { echo 'Missing deploy/.env.prod; preserve and configure the existing database credentials first.' >&2; exit 1; }
env_file="$(cd "$(dirname "$env_file")" && pwd)/$(basename "$env_file")"
if [ "$mode" = rehearsal ]; then
  [ -f "$migration_env" ] || { echo 'Missing .env.migration for the existing migrated target.' >&2; exit 1; }
  migration_env="$(cd "$(dirname "$migration_env")" && pwd)/$(basename "$migration_env")"
fi
cd "$SCRIPT_DIR"
compose=(docker compose -f "$SCRIPT_DIR/docker-compose.prod.yml" --env-file "$env_file")
if [ "$mode" = rehearsal ]; then
  export GONGLUN_MIGRATION_ENV_FILE="$migration_env"
  compose+=(-f "$SCRIPT_DIR/docker-compose.rehearsal.yml")
fi
# Look up the original project: never create a new DB container/volume when
# the deployment directory or Compose project name is wrong.
postgres_id="$("${compose[@]}" ps -q postgres)"
[ -n "$postgres_id" ] || { echo 'No running PostgreSQL found in this Compose project. Nothing was started or replaced.' >&2; exit 1; }
[ "$(docker inspect --format '{{.State.Running}}' "$postgres_id")" = true ] || { echo 'The existing PostgreSQL must already be running.' >&2; exit 1; }

if [ -n "$image_override" ]; then
  [[ "$image_override" =~ ^[a-z0-9][a-z0-9./:_@-]*$ ]] || { echo 'Invalid image reference.' >&2; exit 2; }
  export GONGLUN_IMAGE="$image_override"
  docker image inspect "$GONGLUN_IMAGE" >/dev/null
else
  commit="$(git -C "$REPO_ROOT" rev-parse HEAD)"
  export GONGLUN_IMAGE="gonglun:sha-$commit"
  if ! docker image inspect "$GONGLUN_IMAGE" >/dev/null 2>&1; then
    case "$(docker info --format '{{.Architecture}}')" in
      x86_64|amd64) arch=amd64 ;;
      aarch64|arm64) arch=arm64 ;;
      *) echo 'Only Linux amd64 and arm64 images are published.' >&2; exit 1 ;;
    esac
    remote="$(git -C "$REPO_ROOT" config --get remote.origin.url)"
    case "$remote" in
      https://github.com/*) repository="${remote#https://github.com/}" ;;
      git@github.com:*) repository="${remote#git@github.com:}" ;;
      *) echo 'Expected a GitHub origin remote.' >&2; exit 1 ;;
    esac
    repository="${repository%.git}"
    [[ "$repository" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]] || { echo 'Invalid GitHub repository.' >&2; exit 1; }
    umask 077
    download_dir="$(mktemp -d "${TMPDIR:-/tmp}/gonglun-image.XXXXXXXX")"
    cleanup_download() {
      local target parent
      target="$(cd "$download_dir" && pwd -P)" || return
      parent="$(cd "${TMPDIR:-/tmp}" && pwd -P)" || return
      case "$target" in "$parent"/gonglun-image.*) rm -rf -- "$target" ;; esac
    }
    trap cleanup_download EXIT
    archive="gonglun-linux-$arch.tar.gz"
    release="https://github.com/$repository/releases/download/server-$commit"
    echo "Downloading the GitHub-built $arch image for $commit..."
    if ! curl --fail --show-error --location --retry 3 --output "$download_dir/SHA256SUMS" "$release/SHA256SUMS"; then
      echo 'The image release is not available. Wait for GitHub Actions to finish; running services have not been replaced.' >&2
      exit 1
    fi
    curl --fail --show-error --location --retry 3 --output "$download_dir/$archive" "$release/$archive"
    awk -v archive="$archive" '$2 == archive { print }' "$download_dir/SHA256SUMS" > "$download_dir/selected.sha256"
    [ "$(wc -l < "$download_dir/selected.sha256")" -eq 1 ] || { echo 'Missing or duplicate image checksum.' >&2; exit 1; }
    (cd "$download_dir" && sha256sum -c selected.sha256)
    docker load -i "$download_dir/$archive"
  fi
  revision="$(docker image inspect --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' "$GONGLUN_IMAGE")"
  [ "$revision" = "$commit" ] || { echo 'Image revision does not match this checkout.' >&2; exit 1; }
fi

# Only query the target, in a disposable container with a read-only transaction.
# Wrong/empty/legacy targets fail before the running API is replaced.
"${compose[@]}" run --rm --no-deps -T api node scripts/start-existing.mjs --check
"${compose[@]}" up -d --no-deps --no-build --pull never --wait api
if [ "$mode" = production ]; then
  "${compose[@]}" up -d --no-deps --no-build --wait caddy
fi
umask 077
printf 'GONGLUN_IMAGE=%s\nGONGLUN_DEPLOY_MODE=%s\n' "$GONGLUN_IMAGE" "$mode" > "$SCRIPT_DIR/.env.image"
echo "Ready ($mode): $GONGLUN_IMAGE"
echo "Existing PostgreSQL container preserved: $postgres_id"
if [ "$mode" = rehearsal ]; then
  echo 'Rehearsal: http://localhost:33000 (keep using your SSH tunnel). Runs in the background after SSH disconnects.'
fi
