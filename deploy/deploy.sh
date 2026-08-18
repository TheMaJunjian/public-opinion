#!/usr/bin/env bash
# 一键部署脚本：更新代码 → 生成密钥 → 构建前端 → 启动容器 → 执行数据库迁移
# 在服务器上运行：bash deploy/deploy.sh
# 跳过代码更新：bash deploy/deploy.sh --no-pull
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
UPDATE_CODE=true

case "${1:-}" in
  '') ;;
  --no-pull|-n) UPDATE_CODE=false ;;
  *)
    echo "用法：bash deploy/deploy.sh [--no-pull|-n]"
    exit 2
    ;;
esac

cd "$REPO_ROOT"

# 默认从当前分支更新代码；--no-pull 用于服务器暂时离线或需要部署当前代码时跳过。
if [ "$UPDATE_CODE" = true ]; then
  echo "==> 更新代码"
  git pull --ff-only
else
  echo "==> 跳过代码更新"
fi

cd "$SCRIPT_DIR"

# 1. 首次运行时生成 deploy/.env.prod（域名 + 随机密钥）
if [ ! -f .env.prod ]; then
  read -rp "请输入域名（例如 gonglun.example.com，需已解析到本服务器）: " DOMAIN
  if [ -z "$DOMAIN" ]; then
    echo "必须提供域名（浏览器要求 HTTPS 才能使用签名功能）"
    exit 1
  fi
  cat > .env.prod <<EOF
DOMAIN=$DOMAIN
JWT_SECRET=$(openssl rand -hex 32)
POSTGRES_PASSWORD=$(openssl rand -hex 16)
EOF
  echo "已生成 deploy/.env.prod（含随机密钥），请妥善保存，勿提交到 Git"
fi

# 2. 构建前端（同源 API：/api 由 Caddy 转发给后端）
echo "==> 构建前端"
(
  cd ../frontend
  npm ci
  VITE_API_BASE_URL=/api VITE_DEBUG=false npm run build
)

# 3. 启动服务
echo "==> 启动容器"
docker compose -f docker-compose.prod.yml --env-file .env.prod up -d --build

# 4. 应用数据库迁移
echo "==> 执行数据库迁移"
docker compose -f docker-compose.prod.yml --env-file .env.prod exec api npx prisma migrate deploy

# 5. 输出结果
DOMAIN_VALUE=$(grep '^DOMAIN=' .env.prod | cut -d= -f2)
echo ""
echo "部署完成："
echo "  站点:   https://$DOMAIN_VALUE"
echo "  健康检查: https://$DOMAIN_VALUE/health"
echo "  API 文档: https://$DOMAIN_VALUE/api-docs"
