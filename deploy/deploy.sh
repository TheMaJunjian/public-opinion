#!/usr/bin/env bash
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
case "${1:-}" in
  '') (cd "$REPO_ROOT" && git pull --ff-only) ;;
  --no-pull|-n) ;;
  *) echo 'Usage: bash deploy/deploy.sh [--no-pull|-n]'; exit 2 ;;
esac
cd "$SCRIPT_DIR"
umask 077
if [ ! -f .env.prod ]; then
  read -rp 'Domain (DNS must point to this server): ' DOMAIN
  if [ -z "$DOMAIN" ]; then echo 'A domain is required for HTTPS.'; exit 1; fi
  printf 'DOMAIN=%s\nGONGLUN_FOUNDER_KEY=%s\n' "$DOMAIN" "$(openssl rand -hex 32)" > .env.prod
elif ! grep -q '^GONGLUN_FOUNDER_KEY=.' .env.prod; then
  printf '\nGONGLUN_FOUNDER_KEY=%s\n' "$(openssl rand -hex 32)" >> .env.prod
fi
if ! grep -q '^POSTGRES_PASSWORD=[^[:space:]]' .env.prod; then
  printf '\nPOSTGRES_PASSWORD=%s\n' "$(openssl rand -hex 32)" >> .env.prod
fi
docker compose -f docker-compose.prod.yml --env-file .env.prod up -d --build --wait
DOMAIN_VALUE="$(sed -n 's/^DOMAIN=//p' .env.prod | head -n 1)"
echo "Ready: https://$DOMAIN_VALUE"
echo "Health: https://$DOMAIN_VALUE/api/health"
echo 'The first account requires GONGLUN_FOUNDER_KEY from deploy/.env.prod.'
echo 'Messages and the contribution ledger persist in the postgres_data volume.'
