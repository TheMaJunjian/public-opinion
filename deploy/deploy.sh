#!/usr/bin/env bash
# Build and deploy the current checkout. Updating Git requires --pull.
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd -- "$SCRIPT_DIR/.." && pwd)"
ENV_FILE="$SCRIPT_DIR/.env.prod"
UPDATE_CODE=false

case "${1:-}" in
  '') ;;
  --pull) UPDATE_CODE=true ;;
  --help|-h)
    printf 'Usage: bash deploy/deploy.sh [--pull]\n'
    exit 0
    ;;
  *)
    printf 'Usage: bash deploy/deploy.sh [--pull]\n' >&2
    exit 2
    ;;
esac
if (( $# > 1 )); then
  printf 'Only one optional argument is supported.\n' >&2
  exit 2
fi
if [[ ! -f "$ENV_FILE" ]]; then
  printf 'Create deploy/.env.prod from deploy/.env.prod.example and set DOMAIN first.\n' >&2
  exit 1
fi

cd -- "$REPO_ROOT"
if [[ "$UPDATE_CODE" == true ]]; then
  git pull --ff-only
fi

compose=(docker compose --project-directory "$SCRIPT_DIR" --env-file "$ENV_FILE" -f "$SCRIPT_DIR/docker-compose.prod.yml")
"${compose[@]}" config --quiet
printf 'Building the root workspace with Node.js 24...\n'
"${compose[@]}" build --pull app
printf 'Starting one application instance and Caddy...\n'
"${compose[@]}" up -d --no-build --scale app=1 --wait --wait-timeout 120
"${compose[@]}" ps
printf 'Deployment is ready. The existing SQLite and Caddy volumes have been retained.\n'
