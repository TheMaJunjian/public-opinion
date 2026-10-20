#!/usr/bin/env bash
# Interactive maintenance for an existing deployment. Never sources .env files.
set -euo pipefail
umask 077
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

fail() { printf '%s\n' "$*" >&2; exit 1; }
ask() {
  local answer
  printf '%s [%s]: ' "$2" "$3" >&2
  IFS= read -r answer || fail '输入已结束，操作取消。'
  printf -v "$1" '%s' "${answer:-$3}"
}
valid_database() {
  [[ "$1" =~ ^[a-z_][a-z0-9_]{0,62}$ ]] || fail '库名须为小写字母、数字或下划线，不能以数字开头，最长 63 字符。'
  case "$1" in postgres|template0|template1) fail '不能使用 PostgreSQL 系统库。' ;; esac
}

action="${1:-}"
[ "$#" -le 1 ] || fail '用法：bash deploy/manage.sh [backup|restore|images]'
case "$action" in
  -h|--help) echo '用法：bash deploy/manage.sh [backup|restore|images]，不传参数时显示菜单。'; exit 0 ;;
  '')
    printf '1) 备份数据库\n2) 恢复备份到新数据库\n3) 删除指定旧应用镜像\n0) 退出\n'
    ask action '选择操作' 0
    case "$action" in 1) action=backup ;; 2) action=restore ;; 3) action=images ;; 0) exit 0 ;; esac ;;
esac
case "$action" in backup|restore|images) ;; *) fail '未知操作。' ;; esac
ask env_file '部署配置文件路径' "$SCRIPT_DIR/.env.prod"
[ -f "$env_file" ] || fail "配置文件不存在：$env_file"
env_file="$(cd "$(dirname "$env_file")" && pwd)/$(basename "$env_file")"
compose=(docker compose -f "$SCRIPT_DIR/docker-compose.prod.yml" --env-file "$env_file")

# Show the container actually deployed, rather than the image default in Compose.
echo '当前部署（读取实际 API 容器）：'
api_id="$("${compose[@]}" ps -aq api)"
current_image=''
detected_db=''
detected_schema=''
if [ -n "$api_id" ]; then
  current_image="$(docker inspect --format '{{.Config.Image}}' "$api_id")"
  printf '  应用镜像：%s\n' "$current_image"
  runtime="$("${compose[@]}" exec -T api node -e '
    const rehearsal = process.env.GONGLUN_REHEARSAL === "1";
    const value = rehearsal ? process.env.MIGRATION_TARGET_DATABASE_URL : process.env.DATABASE_URL;
    const database = decodeURIComponent(new URL(value).pathname.slice(1));
    const schema = (rehearsal ? process.env.MIGRATION_TARGET_SCHEMA : process.env.DATABASE_SCHEMA) || "public";
    console.log([database, schema, rehearsal ? "rehearsal" : "production"].join("\t"));
  ' 2>/dev/null)" || runtime=''
  if [ -n "$runtime" ]; then
    IFS=$'\t' read -r detected_db detected_schema deployed_mode <<< "$runtime"
    printf '  运行模式：%s\n  当前数据库：%s\n  当前 schema：%s\n' "$deployed_mode" "$detected_db" "$detected_schema"
  fi
else
  echo '  未找到 API 容器。'
fi
if [ -z "$detected_db" ]; then
  echo '  当前数据库：未能确认（API 可能已停止）；请核对原部署配置。'
fi

if [ "$action" = images ]; then
  docker image ls gonglun --format 'table {{.Repository}}:{{.Tag}}\t{{.ID}}\t{{.Size}}'
  echo '建议保留最近一个正常版本用于回退。'
  ask image '输入要删除的完整镜像名；回车取消' ''
  [ -n "$image" ] || exit 0
  [[ "$image" =~ ^gonglun:sha-[0-9a-f]{40}$ ]] || fail '只允许删除 gonglun:sha-完整40位提交SHA。'
  [ "$image" != "$current_image" ] || fail '这是实际 API 容器使用的镜像，拒绝删除。'
  if [ -f "$SCRIPT_DIR/.env.image" ]; then
    while IFS= read -r line || [ -n "$line" ]; do
      [ "${line%$'\r'}" != "GONGLUN_IMAGE=$image" ] || fail '这是部署记录中的当前镜像，拒绝删除。'
    done < "$SCRIPT_DIR/.env.image"
  fi
  containers="$(docker ps -aq --filter "ancestor=$image")"
  [ -z "$containers" ] || fail '该镜像仍有关联容器（包括已停止容器），拒绝删除。'
  ask confirmation '再次输入完整镜像名确认删除' ''
  [ "$confirmation" = "$image" ] || fail '确认不匹配，操作取消。'
  docker image rm "$image"
  exit 0
fi

postgres_id="$("${compose[@]}" ps -q postgres)"
[ -n "$postgres_id" ] || fail '未找到此 Compose 项目中运行的 PostgreSQL；请核对目录、项目名和配置。'
[ "$(docker inspect --format '{{.State.Running}}' "$postgres_id")" = true ] || fail 'PostgreSQL 未运行。'

if [ "$action" = backup ]; then
  if [ -z "$detected_db" ]; then
    echo '无法读取运行中 API 的库名，请从实际部署配置核对后输入；不会默认使用 gonglun。'
  fi
  ask database '要备份的数据库名' "$detected_db"
  valid_database "$database"
  printf '本次备份数据库：%s\n' "$database"
  ask output_dir '备份存放目录' "$SCRIPT_DIR/backups"
  mkdir -p -- "$output_dir"
  output_dir="$(cd "$output_dir" && pwd)"
  backup_stamp="${database}-$(date -u +%Y%m%dT%H%M%SZ)"
  partial_dir="$(mktemp -d "$output_dir/$backup_stamp.partial.XXXXXXXX")"
  trap 'echo "备份未完成，临时文件保留在：$partial_dir" >&2' ERR
  "${compose[@]}" exec -T postgres pg_dump -U gonglun -d "$database" -Fc > "$partial_dir/database.dump"
  "${compose[@]}" exec -T postgres pg_restore --list < "$partial_dir/database.dump" > /dev/null
  backup_schema='unknown'
  [ "$database" != "$detected_db" ] || backup_schema="$detected_schema"
  printf 'database=%s\nschema=%s\nimage=%s\ncreated_at_utc=%s\n' \
    "$database" "$backup_schema" "$current_image" "$(date -u +%FT%TZ)" > "$partial_dir/metadata.txt"
  (cd "$partial_dir" && sha256sum database.dump metadata.txt > SHA256SUMS)
  backup_dir="$output_dir/$backup_stamp.${partial_dir##*.partial.}"
  mv -- "$partial_dir" "$backup_dir"
  trap - ERR
  printf '备份成功：%s\n请将整个目录另存到服务器之外。归档目录检查不代替恢复演练。\n' "$backup_dir"
  exit 0
fi

ask dump_file '备份文件路径（pg_dump -Fc 生成的 .dump）' ''
[ -f "$dump_file" ] || fail "备份文件不存在：$dump_file"
dump_dir="$(cd "$(dirname "$dump_file")" && pwd)"
dump_file="$dump_dir/$(basename "$dump_file")"
# Support both this script's directory and the earlier single-file commands.
if [ -f "${dump_file}.sha256" ]; then
  # Earlier commands recorded an absolute path; the archive may since have moved.
  expected="$(awk 'NF { print $1 }' "${dump_file}.sha256")"
elif [ -f "$dump_dir/SHA256SUMS" ]; then
  # Verify the selected archive, not an unrelated file in the same directory.
  expected="$(awk -v name="$(basename "$dump_file")" '$2 == name || $2 == "*" name { print $1 }' "$dump_dir/SHA256SUMS")"
else
  echo '没有找到 SHA256 校验文件，将检查归档并在新库中尝试恢复。'
fi
if [ -n "${expected+x}" ]; then
  [[ "$expected" =~ ^[0-9a-f]{64}$ ]] || fail '校验文件中缺少所选备份的唯一 SHA256 校验值。'
  actual="$(sha256sum "$dump_file")"
  [ "${actual%% *}" = "$expected" ] || fail '备份 SHA256 校验失败。'
fi
"${compose[@]}" exec -T postgres pg_restore --list < "$dump_file" > /dev/null
ask database '恢复到新的数据库名（不能使用已有库）' "gonglun_restore_$(date -u +%Y%m%d_%H%M%S)"
valid_database "$database"
printf '本次恢复目标：%s；当前网站数据库：%s（不会自动切换）。\n' "$database" "${detected_db:-未能确认}"
exists="$("${compose[@]}" exec -T postgres psql -X -qAt -v ON_ERROR_STOP=1 -U gonglun -d postgres \
  -c "SELECT 1 FROM pg_database WHERE datname = '$database'")"
[ -z "$exists" ] || fail '目标数据库已存在；请选择一个新库名，原库不会被覆盖。'
"${compose[@]}" exec -T postgres createdb -U gonglun -O gonglun -T template0 -- "$database"
if ! "${compose[@]}" exec -T postgres pg_restore -U gonglun -d "$database" \
  --no-owner --no-acl --exit-on-error --single-transaction < "$dump_file"; then
  fail "恢复失败，应用仍使用原库。新建目标库 $database 已保留供检查；重试请使用另一个新库名。"
fi
"${compose[@]}" exec -T postgres psql -X -qAt -v ON_ERROR_STOP=1 -U gonglun -d "$database" \
  -c "SELECT current_database(), count(*) FROM information_schema.tables WHERE table_schema NOT IN ('pg_catalog', 'information_schema');"
printf '\n恢复完成：%s（尚未切换网站）。\n' "$database"
printf '核验恢复数据与应用版本兼容后，安排停写并对当前生产库再做一次备份。\n'
printf '在 %s 中将 GONGLUN_DATABASE_NAME 设置为 %s，DATABASE_SCHEMA 设置为备份中的业务 schema。\n' "$env_file" "$database"
printf '然后在仓库根目录执行：bash deploy/deploy.sh --production --env-file %q\n' "$env_file"
echo '这会让网站回到备份时的数据；备份之后的写入不会进入恢复库。原库保留。'
echo '以上切换方式用于正式部署；演练部署请修改 .env.migration 中的目标连接并按演练流程启动。'
