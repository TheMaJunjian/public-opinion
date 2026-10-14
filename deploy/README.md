# 运行与部署

项目使用 Node.js 24。所有 npm 命令都在仓库根目录运行，共用根目录的锁文件和 workspaces。

```sh
npm ci
npm test
npm run build
npm start
```

`npm start` 在 3000 端口同时提供 API 与 `apps/web/dist`。`npm run dev` 同时运行 3000 端口的服务和 5173 端口的 Vite，开发时访问 `http://localhost:5173`。Windows 也可以运行 `./deploy/start.ps1`，或构建后运行 `./deploy/start.ps1 -Production`；两者使用当前终端，按 Ctrl+C 停止，不会重置数据库。

数据库默认保存在 `data/gonglun.sqlite`，可用 `GONGLUN_DB` 改变路径。第一版使用单进程及 SQLite WAL；运行目录内的数据库、WAL 和 SHM 文件共同组成持久状态。

## 首次部署

服务器安装 Docker 与 Compose，将域名解析到服务器，并准备 80、443 端口。以下命令在仓库根目录执行：

```sh
cp deploy/.env.prod.example deploy/.env.prod
# 编辑 deploy/.env.prod 中的 DOMAIN 和 GONGLUN_FOUNDER_KEY。
# 在服务器本地生成初始化密钥：openssl rand -hex 32
docker compose --env-file deploy/.env.prod -f deploy/docker-compose.prod.yml up -d --build app
```

首次注册的账户成为项目发起人，生产模式注册时需要填写 `GONGLUN_FOUNDER_KEY`。在对外开放站点前，先通过服务器本机的 `http://127.0.0.1:3000` 注册。远程服务器可以使用 SSH 转发：

```sh
ssh -L 3000:127.0.0.1:3000 user@server
```

随后在自己电脑打开 `http://localhost:3000` 完成首次注册，再在服务器执行：

```sh
bash deploy/deploy.sh
```

发起人账户建立后，可从环境文件移除初始化密钥并重新运行部署脚本；已有数据库启动不依赖该密钥。脚本构建当前检出的代码，并启动一个应用实例和 Caddy。需要先拉取当前分支的更新时，使用 `bash deploy/deploy.sh --pull`。应用只将 3000 端口绑定到服务器回环地址；Caddy 提供公网 HTTPS，同源代理页面和 API，SSE 使用即时刷新并禁用缓存。健康检查为 `/api/health`。

## 更新与数据

后续运行 `bash deploy/deploy.sh` 会保留 `gonglun_data`、`caddy_data`、`caddy_config` 卷。SQLite 保存于应用容器 `/app/data/gonglun.sqlite`；只运行一个应用实例。部署不包含 PostgreSQL、Prisma 迁移或 GitHub Pages。

```sh
docker compose --env-file deploy/.env.prod -f deploy/docker-compose.prod.yml ps
docker compose --env-file deploy/.env.prod -f deploy/docker-compose.prod.yml logs --tail 100 app caddy
docker compose --env-file deploy/.env.prod -f deploy/docker-compose.prod.yml stop
```

备份时先停止应用，再备份完整的 `gonglun_data` 卷；恢复时也保持应用停止。不要在运行中单独复制主数据库文件，或使用 `down -v` 代替正常停止，前者可能遗漏 WAL 中的数据，后者会删除持久卷。现有环境文件由部署者维护，脚本不会生成、覆盖或输出其中的密钥。
