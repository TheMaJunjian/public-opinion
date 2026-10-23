# 取消旧 Topic 转成的分类

此升级用于已经完成旧库迁移的新版数据库。版本 3（`retire-converted-topic-containers`）由独立迁移程序执行。API 启动会自动调用独立迁移程序完成待执行版本，无需提醒或确认；也可在启动前手动运行 `npm run db:migrate -- --plan` 和 `npm run db:migrate`。下列核验工具针对单独取消 Topic 的步骤；全部旧格式升级还会将旧字段转成新版结构，须另核对迁移备份及资金校验结果。

专项视图核验需要当前查询表结构，适用于本版历史导入完成后仍保留 Topic 的数据库。较早版本的数据库应执行完整的 `db:migrate` 和 `db:verify`，不要直接套用下列专项视图核验命令。

## 处理规则

- 通过“消息 ID 等于元数据 legacyTopicId，并且是迁移产生的 CLASSIFY”识别旧 Topic，不按标题或所有带 legacyTopicId 的消息批量处理。
- 解除升级时直接指向这些分类的当前归属，成员回根目录。已经移到其他分类、归并、排列或总结的消息保持当前位置，内部结构保持原样。
- Topic 本身若被加入其他容器，也解除其当前归属，不在正常图、消息表或“被反对的容器”提示中显示。它仍存在于消息库、历史版本、原文归档、按 ID 读取及完整导出中。
- 不删除任何消息，包括“加入”“赞同”“反对”和更正记录；不改写原消息、历史版本、签名、引用、旧执行记录和资金。旧 Topic 以及指向它的加入记录永久停止组织效果，不能通过赞同恢复，也不能新加入。
- 已移出 Topic 的消息仍在其新位置。之后反对新加入时，历史链遇到已取消 Topic 即回根目录，不恢复更早的其他位置。新的移动仍保存自己的历史。

升级在已有跨进程事务锁内完成，失败整体回滚，并发执行迁移只处理一次，重复执行不会再追加记录。版本 3 没有旧 Topic 时只登记数据库版本。若在空库登记版本 3 后才通过历史导入工具导入旧库，须在导入完成后显式运行下述取消命令；历史导入工具本身仍保留旧边界，便于核对源快照。

## 本机预检与核验

所有命令读取当前指定的 `DATABASE_URL` / `DATABASE_SCHEMA`。预检只读，不调用自动升级入口。

```sh
npm run db:topic-retirement -- --report data/topic-plan.json
npx tsx --env-file=.env apps/migrate/src/topic-retirement-audit.ts capture data/topic-before.json
npx tsx --env-file=.env apps/migrate/src/topic-retirement-view-audit.ts capture data/topic-before-view.json
```

先保存数据库备份。使用预检输出的 region 显式应用，或执行独立迁移程序：

```sh
npm run db:topic-retirement -- --apply --expect-region 预检输出的region
npx tsx --env-file=.env apps/migrate/src/topic-retirement-audit.ts verify data/topic-before.json data/topic-verification.json
npx tsx --env-file=.env apps/migrate/src/topic-retirement-view-audit.ts verify data/topic-before-view.json data/topic-view-verification.json
```

严格前后核验期间应暂停业务写入，避免把期间的正常发言或账户变化算作升级差异。

## 生产镜像操作

镜像内自带取消命令和两种只读核验工具，服务器无需 Node 开发依赖。以下在仓库根目录、原生产 Compose 项目中执行；沿用已有配置和数据库。先通过现有维护脚本备份并暂停发布窗口内的业务写入。需要核验的候选镜像须已经加载，命令中的 `GONGLUN_IMAGE` 必须指向该候选镜像；可以将经过校验的候选镜像名写入环境变量，不要为了预检先启动新版 API。

```sh
umask 077
mkdir -p data/topic-upgrade
docker compose -f deploy/docker-compose.prod.yml --env-file deploy/.env.prod run --rm --no-deps -T api node apps/migrate/dist/retire-legacy-topics-cli.js
docker compose -f deploy/docker-compose.prod.yml --env-file deploy/.env.prod run --rm --no-deps -T api node apps/migrate/dist/topic-retirement-audit.js capture - > data/topic-upgrade/before.json
docker compose -f deploy/docker-compose.prod.yml --env-file deploy/.env.prod run --rm --no-deps -T api node apps/migrate/dist/topic-retirement-view-audit.js capture - > data/topic-upgrade/before-view.json
```

三个预检命令都不执行数据库升级。先用同一镜像显式执行 `node apps/migrate/dist/retire-legacy-topics-cli.js --apply --expect-region 预检输出的region`。单独取消 Topic 后验证：

```sh
docker compose -f deploy/docker-compose.prod.yml --env-file deploy/.env.prod run --rm --no-deps -T api node apps/migrate/dist/topic-retirement-audit.js verify - - < data/topic-upgrade/before.json > data/topic-upgrade/verification.json
docker compose -f deploy/docker-compose.prod.yml --env-file deploy/.env.prod run --rm --no-deps -T api node apps/migrate/dist/topic-retirement-view-audit.js verify - - < data/topic-upgrade/before-view.json > data/topic-upgrade/view-verification.json
```

核验工具失败返回非零状态。两份报告应为 `verified: true`，再检查根目录、进入原有分类、按 ID 查看历史及导出。最后恢复业务写入。版本 3 后旧程序会因迁移版本不兼容拒绝启动；只回退镜像不能回退数据，需按既有维护流程将升级前备份恢复到新数据库后切换，并保留升级后数据。

## 第三方可核验的范围

公开升级事件包含 Topic ID、解除归属的完整旧索引和停用的加入记录 ID。独立文件迁移和数据库核验工具会核对 Topic 身份、当时的直接成员、解除列表、停用状态和连续游标；多移成员、冒充 Topic、恢复已取消归属都会被拒绝。主程序的导出复算检查连续游标、资金守恒及已退役组织的状态；完整导出及更新旧导出均保留升级事件。

额外的 SQL 核验工具不调用升级实现，逐表比较消息、历史版本、旧执行记录、原文归档、引用、签名和资金数据的指纹，并将当前索引、账户与导出复算结果对照。视图核验覆盖每个已有用户及匿名视图，检查所有原有内部容器的成员保持一致、取消后的 Topic 没有当前组织效果。

这些检查验证记录和变更符合本次升级规则，不等同于外部机构已完成审计，也不替代对签名真实性、程序发布授权和备份来源的独立验证。

完成此专项核验后，再显式执行 `node apps/migrate/dist/migrate-cli.js` 完成全部剩余版本，最后启动 API。主程序构建目录仅包含主程序及其版本清单，所有迁移可执行文件均在 `apps/migrate/dist/`。
