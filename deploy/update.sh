#!/usr/bin/env bash
set -euo pipefail

# Keep the complete workflow in a parsed function: git pull may update this file
# while it is running. The deployment script is opened only after the pull.
main() {
  if [ "$#" -ne 0 ]; then
    echo 'Usage: bash deploy/update.sh' >&2
    return 2
  fi

  local script_dir repo_root branch commit previous_commit upstream checkout_status service container state api_id actual_image
  script_dir="$(cd "$(dirname "$0")" && pwd)"
  repo_root="$(cd "$script_dir/.." && pwd)"
  cd "$repo_root"

  stage='checking the checkout'
  trap 'status=$?; if [ "$status" -ne 0 ]; then echo "Production update failed during: $stage (exit $status)." >&2; fi' EXIT
  branch="$(git symbolic-ref --quiet --short HEAD)" || { echo 'Check out the deployment branch first.' >&2; return 1; }
  upstream="$(git rev-parse --abbrev-ref --symbolic-full-name '@{upstream}')"
  checkout_status="$(git status --porcelain --untracked-files=no)"
  [ -z "$checkout_status" ] || { echo 'Tracked files have local changes. Resolve them before updating.' >&2; return 1; }
  previous_commit="$(git rev-parse --short HEAD)"
  printf 'Branch: %s (upstream: %s)\nPrevious checkout: %s\n' "$branch" "$upstream" "$previous_commit"
  echo 'Previous deployment:'
  if [ -f "$script_dir/.env.image" ]; then
    cat "$script_dir/.env.image"
  else
    echo '(no deployment record yet)'
  fi

  stage='pulling code'
  git pull --ff-only
  commit="$(git rev-parse HEAD)"
  [ "$commit" = "$(git rev-parse '@{upstream}')" ] || { echo 'The checkout differs from its upstream. Resolve local commits before deploying.' >&2; return 1; }
  printf 'Updated checkout: %s\n' "$commit"

  stage='deploying production'
  bash "$script_dir/deploy.sh" --production

  stage='checking the deployment'
  echo 'Current deployment:'
  cat "$script_dir/.env.image"
  export GONGLUN_IMAGE="gonglun:sha-$commit"
  [ "$(cat "$script_dir/.env.image")" = "$(printf 'GONGLUN_IMAGE=%s\nGONGLUN_DEPLOY_MODE=production' "$GONGLUN_IMAGE")" ] || { echo 'The deployment record does not match the requested production revision.' >&2; return 1; }
  local -a compose=(docker compose -f "$script_dir/docker-compose.prod.yml" --env-file "$script_dir/.env.prod")
  "${compose[@]}" ps
  for service in postgres api caddy; do
    container="$("${compose[@]}" ps -q "$service")"
    [ -n "$container" ] || { echo "Missing running service: $service" >&2; return 1; }
    state="$(docker inspect --format '{{.State.Status}} {{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "$container")"
    case "$service:$state" in
      postgres:running\ healthy|api:running\ healthy|caddy:running\ healthy|caddy:running\ none) ;;
      *) echo "Service check failed: $service ($state)" >&2; return 1 ;;
    esac
    if [ "$service" = api ]; then api_id="$container"; fi
  done
  actual_image="$(docker inspect --format '{{.Config.Image}}' "$api_id")"
  [ "$actual_image" = "$GONGLUN_IMAGE" ] || { echo "The API is running an unexpected image: $actual_image" >&2; return 1; }
  "${compose[@]}" exec -T api node -e 'fetch("http://127.0.0.1:3000/api/health", { signal: AbortSignal.timeout(10000) }).then(async r => { if (!r.ok || (await r.json()).ok !== true) throw new Error("Unhealthy API"); console.log("API health check passed."); }).catch(e => { console.error(e.message); process.exit(1); })'
  printf 'Production update and checks passed: %s (%s)\n' "$branch" "$commit"
}

# Parse the exit with the call so Bash never resumes reading a replaced file.
main "$@"; exit
