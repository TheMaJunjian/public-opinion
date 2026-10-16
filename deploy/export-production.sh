#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
umask 077
backup_stamp="$(date -u +%Y%m%dT%H%M%SZ)-$$"
backup_dir="backups/$backup_stamp"
container_dump="/tmp/gonglun-export-$backup_stamp.dump"
mkdir -p "$backup_dir"
compose=(docker compose -f docker-compose.prod.yml --env-file .env.prod)
case "${1:-}" in
  --online) echo 'Online rehearsal export: old API remains running.' ;;
  --final) "${compose[@]}" stop api ;;
  *) echo 'Usage: bash export-production.sh --online|--final'; exit 2 ;;
esac
# Other writers must also be stopped before --final. The online manifest is
# generated later from the restored dump, not from a changing source database.
"${compose[@]}" exec -T postgres pg_dump -U gonglun -d gonglun -Fc --no-owner --no-acl -f "$container_dump"
"${compose[@]}" cp "postgres:$container_dump" "$backup_dir/gonglun-final.dump"
"${compose[@]}" exec -T postgres rm -f "$container_dump"
if [ "$1" = '--final' ]; then
  "${compose[@]}" exec -T postgres psql -X -qAt -U gonglun -d gonglun < migration-manifest.sql > "$backup_dir/manifest.jsonl"
fi
git rev-parse HEAD > "$backup_dir/source-commit.txt"
(cd "$backup_dir" && sha256sum *.dump *.txt > SHA256SUMS && if [ -f manifest.jsonl ]; then sha256sum manifest.jsonl >> SHA256SUMS; fi)
echo "Backup: $backup_dir. Mode: $1. Copy this directory and preserve deployment credentials securely."
