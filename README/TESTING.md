# 测试

在仓库根目录使用 Node.js 24 或更新版本：

```sh
npm ci
npm run db:up
npm test
npm run test:deployment
npm run build
```

`npm test` 使用 Vitest 运行共享模型、真实 PostgreSQL 后端集成和 React 工作台测试。`npm run db:up` 启动本地 PostgreSQL；每个后端测试使用随机独立 schema，结束后只清理本轮测试创建的 schema。

使用其他测试数据库时设置 `TEST_DATABASE_URL`，账号需要创建和删除 schema 的权限。测试不会读取生产用的 `DATABASE_URL`。默认测试地址与本地开发 PostgreSQL 相同，但测试 schema 与应用数据隔离。

开发时可以指定文件或项目缩小范围：

```sh
npx vitest run apps/server/src/ui.test.ts
npx vitest run frontend/src/test/message-workbench-page.test.tsx
npm run typecheck
```

重点检查消息部件及版本引用、事务提交与重复重试、结算守恒和推翻、组织恢复、原发送操作、分页期间的增量同步，以及非线性布局。PostgreSQL 测试还覆盖两个 API 实例并发重试、超额支出、重复结算、嵌套事务回滚、读取快照和跨实例 SSE。浏览器检查使用单独的测试数据库和本地测试账号。

工作台首次加载使用 `batch=4` 合并最多四个 200 条分页，仍按原游标读完全部数据，并从第一批的执行序号补齐并发变更后才生成完整图。`format=compact-v1` 将响应中重复的关系记录编码为消息数组索引，前端还原完整记录；额外的独立关系字段仍原样传输。快照接口按 `Accept-Encoding` 协商 gzip，直接通过 Node 和 SSH 隧道访问时也会压缩，不改变 SSE 或登录接口。

`snapshot-transport.test.ts`、`snapshot-client.test.ts` 和 `migrate-legacy.test.ts` 覆盖无损还原、旧接口兼容、分页期间的变更、原押注池及旧数据完整性。大样本测试实际迁移 420 条旧文本消息及分类、JOIN 和跨页引用，以每页 100 条遍历所有普通与合并分页，逐字段比较最终消息、JOIN、引用、用户和附属状态，同时检查请求次数及传输字节减少。不同服务器上的实际耗时需要另行测量。
# 生产容器验证

运行 `npm run test:production`，需要 Docker Compose 2.24.4+ 和空闲的本机 54443、54331 端口。脚本使用独立随机 Compose 项目与临时凭据，验证 PostgreSQL、API、Caddy 内部 CA 的 HTTPS、前端静态页面、首位用户保护、Secure Cookie、CSRF、消息写入、API 重启后的持久化、会话及登录；随后运行实际迁移 CLI，将合成旧 Prisma 数据转换到新 schema，重建生产 API 验证 bcrypt 登录、旧消息及余额、新版写入。结束后删除本轮测试容器和卷。内部 CA 测试不替代真实域名的 DNS 与公网证书验收，合成数据不替代真实备份演练。

该验证显式合并仅供本地/CI 的 `docker-compose.build.yml`；生产 Compose 本身只有镜像引用。验证还将已迁移的数据切到镜像只读演练入口，检查错误目标不创建 schema、原 PostgreSQL 容器 ID/启动时间/数据卷不变，以及旧登录、余额、消息和禁止写入的行为。`test:deployment` 另行验证部署脚本在缺库、错误目标、镜像缺失或校验失败时不替换服务，并检查下载校验顺序、无构建更新、配置不改写及显式镜像回退。

`test:deployment` 也通过模拟 Git、Docker 和下载命令运行 `deploy/update.sh`：验证先拉取再调用更新后的部署脚本、脚本自身被拉取覆盖时仍能完成流程，以及本地改动、上游异常、未发布镜像、容器状态异常、运行镜像不符和健康请求失败时的停止行为。这些流程测试不连接生产服务器，也不替代真实容器或公网 HTTPS 验收。
