# PostgreSQL 在线演练与最终切换

生产基线 a5216ca 使用旧 Prisma 模型。旧服务器继续提供服务；先在线导出一致快照，到新服务器恢复并核对，再转换到独立新版数据库。只有实际备份的迁移报告无阻断项、新版验收通过，才安排最终停写。禁止在测试完成前执行最终切换或停旧 API。

## 1. 在线备份：旧版不停机

将本仓库的 `deploy/export-production.sh`、`deploy/migration-manifest.sql` 复制到旧服务器原有 deploy 目录，不替换旧版 Compose 或代码。执行：

```sh
bash export-production.sh --online
```

脚本使用旧 Compose 连接 PostgreSQL，生成 `backups/时间戳/gonglun-final.dump`、`source-commit.txt`、`SHA256SUMS`。文件名虽然带 final，在线模式只是演练快照。在线模式不执行 stop，pg_dump 使用一致性快照；旧版新增数据不会进入已经完成的快照，所以最终切换必须重新导出。

使用 scp 安全传输整个备份目录到新服务器。保留旧服务器、旧配置、代码和卷；不要切 DNS。备份含密码哈希及业务数据，不能提交 Git 或放进镜像。

## 2. 在新服务器恢复快照

新服务器配置本仓库的 `deploy/.env.prod`，使用新数据库密码、发起人密钥和生产域名。先只启动 PostgreSQL，不启动新版 API：

```sh
cd deploy
docker compose -f docker-compose.prod.yml -f docker-compose.migration.yml --env-file .env.prod up -d --wait postgres
# 替换实际时间戳目录，并在该目录验证校验值。
(cd backups/实际时间戳 && sha256sum -c SHA256SUMS)
docker compose -f docker-compose.prod.yml --env-file .env.prod exec -T postgres createdb -U gonglun gonglun_legacy_rehearsal
docker compose -f docker-compose.prod.yml --env-file .env.prod cp backups/实际时间戳/gonglun-final.dump postgres:/tmp/legacy.dump
docker compose -f docker-compose.prod.yml --env-file .env.prod exec -T postgres pg_restore -U gonglun -d gonglun_legacy_rehearsal --no-owner --no-acl --exit-on-error --single-transaction /tmp/legacy.dump
docker compose -f docker-compose.prod.yml --env-file .env.prod exec -T postgres psql -X -qAt -U gonglun -d gonglun_legacy_rehearsal < migration-manifest.sql > restored-manifest.jsonl
```

`docker-compose.migration.yml` 只将 PostgreSQL 暴露在新服务器 localhost:54330，供本机迁移 CLI 使用。最终可撤掉这个端口。`gonglun_legacy_rehearsal` 是源快照库；默认创建的 `gonglun` 留作空的新版目标库。不要在已有库上使用 `--clean`。每次演练重新建独立源库和独立空目标库，不能在已有结果上重复导入。

在线导出时源库持续变化，不能把“导出后源库的统计”与“备份快照统计”要求完全相同。传输用 SHA256 校验，恢复过程用 `--exit-on-error --single-transaction` 检查；逐表内容指纹从恢复的稳定快照生成。最终停写备份额外生成源库 manifest，届时源、目标指纹必须完全一致。

## 3. 预检与业务转换

在新服务器安装 Node.js 24，仓库根目录执行 `npm ci`。复制 `.env.migration.example` 到 `.env.migration`，填入仅供迁移的源、目标连接，密码放配置文件中；不要发到聊天。连接示例：

```dotenv
LEGACY_DATABASE_URL=postgresql://gonglun:实际新库密码@127.0.0.1:54330/gonglun_legacy_rehearsal
MIGRATION_TARGET_DATABASE_URL=postgresql://gonglun:实际新库密码@127.0.0.1:54330/gonglun
```

用户名必须选定一位旧用户作为新版 founder，传旧 User.id。目标 schema 默认 public，必须没有表。迁移程序不使用生产 DATABASE_URL，源库查询全部位于只读一致快照事务内。

```sh
mkdir -p migration-reports
# 默认只预检，不创建或修改目标库。
npm run db:migrate-legacy -- --founder-id 旧用户ID --report migration-reports/preflight.json
# 只有 blockers 为空、确认 notes 中的迁移语义后，才应用到演练目标库。
npm run db:migrate-legacy -- --founder-id 旧用户ID --apply --accept-checkpoint --report migration-reports/applied.json
```

无阻断且应用成功的报告应包含 `applied: true`。预检有阻断时退出码为 2，应用失败为 1；不会继续启动新版。报告记录各源表行数和源快照摘要，不包含密码或连接串。大库转换目前在内存中读取整个快照，需在新服务器评估内存与耗时。

若真实快照因进行中资金或组织执行状态阻断，可仅在独立空目标库生成只读检查环境：

```sh
npm run db:migrate-legacy -- --founder-id 旧用户ID --apply --read-only-rehearsal --report migration-reports/readonly-applied.json
npx tsx apps/migrate/src/verify-legacy-rehearsal-cli.ts migration-reports/verification.json
```

此模式保留账户 available/locked 和全部源原文，但不续接旧版资金执行语义；新版 API 读取 settings.migration.mode 后禁用业务写入及自动结算，仅允许登录/退出用于检查。进行中轮次以 legacy-pending 保存，UI 保留原 VOTING 状态，不能伪装成已结算。报告仍保留 blockers，CLI 仍返回阻断退出码；`applied: true` 仅表示只读演练库生成成功，绝不表示可上线。引用断链、身份冲突、账户不一致等完整性问题仍阻止生成。确认模式的行为有专门集成测试。验证 CLI 比较每条归档内容和摘要、用户与密码哈希、消息正文、账户及新版账本重放，不输出密码哈希。

进一步保留活跃状态时加 `--preserve-active-state`：

```sh
npm run db:migrate-legacy -- --founder-id 旧用户ID --apply --read-only-rehearsal --preserve-active-state --report migration-reports/preserved.json
```

此模式将 Stake、VoteStake、BetPool、Balance 历史指标分别迁移到可查询的结构化兼容表，原金额、方向、类型、轮次与状态不改变，界面显示原押注与池余额；组织按旧版传递投票、拒绝状态和有效 JOIN 恢复归属。原 UTC 时间显式转换，避免本机时区造成偏移。旧合同的本金/池暴露与账户锁定额单独核对，差异写入 financialAudit，不补锁、不解锁、不增发、不结算。这个差异可能来自旧版累计权重及跨池解锁，必须先确定旧合同语义，不能把总押注权重当作新版可支付资金。仍强制只读；结构化状态保留成功不表示旧合同执行兼容已完成。

### 当前转换范围

- 用户、话题、消息保留 ID、作者及时间。旧 Topic 转为独立分类，分类内容使用原网址末尾的 Topic ID，原 title/body/status 保存在元数据与原文归档中。Topic 成员仍为成员，不拼接成分类正文；不同 Topic 保持原边界。旧 CLASSIFY 仍为分类，原正文、标题、声明成员及 JOIN 引用种类完整保留。新版单一父容器索引用于执行查询，不替换旧声明和当前用户的 JOIN 选择。普通消息转为 parts；个人关注/已读/屏蔽同步保留。
- 旧 bcrypt 密码仍可登录，包括旧版允许的短密码；新版注册继续要求至少 8 位。旧 JWT 会话不迁移，用户需重新登录；设备公钥保留。
- PointAccount.available 必须与 Balance.balance 一致。余额和 RevenuePool 余额作为迁移检查点导入，不重放旧流水、不再发 initialGrant；新版 earned/spent 从检查点开始，旧 totalEarned/totalLost 及流水完整保存在原文归档。
- 已关闭轮次的目标、结果、投票和前轮链可查看。旧资金历史目标不能跨检查点下注/翻案，仍可作无资金的赞同/反对。新消息使用新版完整结算流程。旧轮次的结算算法不伪装成新版 payout。
- 旧版全部 public 表（包括审计、原签名、规则及 Prisma 迁移记录）原样保存在目标的私有 legacy_records 表。旧规则不会重新执行；默认启用新版 DEFAULT_RULES，也可用 `--rules rules.json` 明确指定符合新版结构的规则。

### 必须解决的阻断项

默认模式会阻止锁定资金不为零、非空押注池和进行中的 OPEN/VOTING 轮次；专项保留与虚拟点补锁方案见文末。不得直接把 locked 清零或把轮次改成 SETTLED。存在多重归属、片段组织成员、组织赞同/否定执行状态、引用断链、用户名冲突、账户对账失败等，也会阻止应用。

源原文归档不代表所有历史语义都能继续执行。若上线要求包含跨旧完成轮次翻案或继续执行旧规则，需要额外转换；当前可操作专项模式只续接活动本金，未来采用新版规则。

## 4. 新版验收：旧版继续运行

确认报告无阻断项后，在新服务器启动新版。演练使用测试域名或 hosts 映射，不切生产 DNS；测试环境不接收真实用户写入。验证登录、用户/话题/消息数量、引用、分类归属、个人状态、签名、逐账户余额、运营池、结算历史、新消息押注结算，以及重启后数据持久化。

程序自动进行逐账户余额、全部原文归档行数、新版导出账本重放和资金守恒检查；仍需真实备份的业务验收。容器链路可另外运行 `npm run test:production`，该测试使用独立随机项目与空库，不代替真实备份迁移验收。

## 5. 通过后最终短暂停写与切换

先冻结新服务器演练写入，并保留演练数据库供核查。仅在前四步通过后，在旧服务器暂停全部写入进程（API、多实例、定时任务、外部 worker），运行：

```sh
bash export-production.sh --final
```

传输这次最新完整备份，恢复到新的源快照库；比对源 manifest 和恢复库指纹，必须无差异。使用新的空目标库（例如先 `createdb -U gonglun gonglun_v2_final`）再次执行预检和应用；即使演练通过，最终快照出现新阻断也必须取消切换并恢复旧 API。最终转换通过后，在新服务器 `deploy/.env.prod` 设置 `GONGLUN_DATABASE_NAME=gonglun_v2_final`，Compose 据此构造 API 的 DATABASE_URL；默认 DATABASE_SCHEMA=public。直接在宿主机启动 API 时才直接设置 DATABASE_URL。验证健康、登录、查询和余额，再切换生产 DNS/入口。新旧服务器不能同时接收生产写入。

切换前失败：旧库未被转换程序写入，启动原旧 API 即可恢复服务。切换后已有新版写入：不能直接切回旧库，否则会丢失新数据；当前没有新版到旧 Prisma 的反向转换，必须先停写并制定增量回迁方案。需要快速可逆的上线应在开放真实写入前完成回滚验证。
## 2026-10-14：虚拟贡献点补锁与可操作隔离演练

贡献点不涉及真实资金时，可在 `--preserve-active-state` 基础上加 `--lock-available`：逐用户按活动本金缺口从 available 转入 locked，最多锁定当前可用余额。总额、minted 不变，余额不足保留 remaining，不增发、不借款、不清零。只读模式允许保留不足部分供核查。

活动本金全部覆盖后，可选择 `--native-rehearsal` 接通新版引擎，仍必须使用独立空目标库：

```sh
npm run db:migrate-legacy -- --founder-id 旧用户ID --apply --read-only-rehearsal --preserve-active-state --lock-available --native-rehearsal --report migration-reports/native.json
npx tsx apps/migrate/src/verify-legacy-rehearsal-cli.ts migration-reports/verification.json
```

该组合生成 `settings.migration.mode=native-rehearsal`，允许隔离环境业务写入。`--read-only-rehearsal` 在此组合中是保留源锁定状态的显式安全选项，最终模式以报告为准。TRUTH 和 VALUE 使用不同目标键，活动本金导入 bets，VOTING 保持 open，没有截止计时，不自动结算。委托奖励导入 escrow，超出 rewardAmount 的原池积分继续锁定保留；只有之后的显式完成认定才能支付奖励。历史记录、签名、组织执行状态及所有源表原文继续保留。

执行边界：之后的押注和结算使用新版规则；仅活动本金参与新结算，旧完成轮次及其支付不会被重放或跨检查点追回，旧累计权重仍可查询。未覆盖本金、UNKNOWN 有资金投票、轮次本金与池不一致或无法无歧义映射的委托会阻止可操作模式。此实现不是旧 Prisma 结算算法的逐行复制。原 RuleVersion 为空时采用新版默认规则，正式切换前须验收未来规则及 founder 权限。

真实备份演练使用 postgres.real_native_v5，验证通过：252 用户、1,356 原消息、13,923 原记录、536 轮次（478 个仍在投票）、763 押注、491 池、287 组织状态和 237 有效 JOIN。可用余额共转入锁定 101,000,271 点，最终 available=325,688,026、locked=102,048,590，逐账户总额及账本重放一致，剩余缺口 0。委托保留 1,000,000 奖励及额外 10 点原池锁定，不提前支付。

演练通过仍不意味着现在停止旧版。新服务器先恢复在线备份、生成新的隔离目标、验收和验证容器；最终切换再停写导出最新备份，重新恢复和迁移到空目标。任何最终快照差异或阻断都应取消切换，恢复旧版写入。禁止将本机测试库直接当作最终生产数据。
