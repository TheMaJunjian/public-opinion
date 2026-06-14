 # 公论（Public-Opinion）Phase 0-3 手动测试文档

> 基于 `http://localhost:3000/api`，使用 curl 或 Postman 执行。
> 测试前请先 `cd backend && npx prisma db push --force-reset && npx prisma db seed` 重置数据库。

---

## 零、准备与辅助命令

```bash
# 基础 URL
BASE=http://localhost:3000/api

# 获取 JWT token 的辅助函数（PowerShell）
function Get-Token { param($u,$p); (Invoke-RestMethod "$BASE/auth/login" -Method POST -Body (@{username=$u;password=$p}|ConvertTo-Json) -ContentType "application/json").token }
```

---

## Phase 0：基础设施

### 0.1 注册走事件统一写路径

| # | 测试项 | 操作 | 预期 |
|---|--------|------|------|
| 0.1.1 | 注册成功 | `POST /auth/register` `{"username":"alice","password":"123456"}` | 返回 201，user 含 id/username，自动获 100 点注册奖励 |
| 0.1.2 | 重复注册 | 再用相同 username 注册 | 返回 409，"该资源已存在" |
| 0.1.3 | 用户名校验 | username="a" | 返回 400，"用户名至少 2 个字符" |
| 0.1.4 | 密码校验 | password="123" | 返回 400，"密码至少 6 个字符" |

### 0.2 登录与 JWT

| # | 测试项 | 操作 | 预期 |
|---|--------|------|------|
| 0.2.1 | 登录成功 | `POST /auth/login` `{"username":"alice","password":"123456"}` | 返回 200，含 token 和 user |
| 0.2.2 | 密码错误 | password="wrong" | 返回 401，"用户名或密码错误" |
| 0.2.3 | 不存在的用户 | username="nobody" | 返回 401 |
| 0.2.4 | 无 token 访问受保护 API | `GET /points/balance`（无 Authorization） | 返回 401，"未提供认证令牌" |
| 0.2.5 | 错误 token 访问 | Bearer 随意字符串 | 返回 401，"令牌无效或已过期" |

### 0.3 规则种子数据

| # | 测试项 | 操作 | 预期 |
|---|--------|------|------|
| 0.3.1 | 查询当前规则 | `GET /rules/current` | 返回 version=1, status="ACTIVE"，parameters 含 minStake=1, selfStakeOnCreate=1 |

### 0.4 User publicKey 字段

| # | 测试项 | 操作 | 预期 |
|---|--------|------|------|
| 0.4.1 | 注册后 publicKey 为 null | 检查数据库 `SELECT "publicKey" FROM "User" WHERE username='alice'` | 值为 NULL（预留字段） |

---

## Phase 1：贡献点与账本

### 1.1 注册奖励

| # | 测试项 | 操作 | 预期 |
|---|--------|------|------|
| 1.1.1 | 注册获 100 点 | 注册新用户 bob/123456 | 注册成功 |
| 1.1.2 | 查询余额 | bob 登录后 `GET /points/balance` | available=100, locked=0, balance.amount=100, debtFrozen=false |
| 1.1.3 | 查询流水 | bob 登录后 `GET /points/transactions` | 有 1 条 MINT 类型记录，amount=+100，reason="REGISTRATION_BONUS" |
| 1.1.4 | 查询流水无认证 | `GET /points/transactions` 无 token | 返回 401 |

### 1.2 前端 PointsBadge

| # | 测试项 | 操作 | 预期 |
|---|--------|------|------|
| 1.2.1 | 导航栏显示余额 | 登录后查看页面顶部导航栏 | 显示 "💎 100" |
| 1.2.2 | 点击展开流水 | 点击 PointsBadge | 弹出面板显示 "铸造 +100 余额 100" |
| 1.2.3 | 锁定金额显示 | 押注后（Phase 2 操作后）回来检查 | 显示 "🔒N" |
| 1.2.4 | 负债冻结显示 | 负债后（Phase 4 操作后）检查 | 显示 "❄️冻结" + "负债N" |

### 1.3 Balance 与 PointAccount 一致性

| # | 测试项 | 操作 | 预期 |
|---|--------|------|------|
| 1.3.1 | 两个模型余额一致 | 注册后检查 Balance.balance 和 PointAccount.available | 两者相等（均为 100） |
| 1.3.2 | 押注后一致性 | 押注后检查两者 | Balance.balance = PointAccount.available + PointAccount.locked |

---

## Phase 2：押注与资金池

### 2.1 发消息自动自押 PRO

| # | 测试项 | 操作 | 预期 |
|---|--------|------|------|
| 2.1.1 | 创建 Topic | `POST /topics` `{"title":"测试议题"}` （需 token） | 返回 201，记下 topicId |
| 2.1.2 | 发消息（无 stakeAmount） | `POST /topics/{topicId}/messages` `{"content":"第一条消息"}` | 返回 201，可用点减少 1（auto selfStakeOnCreate） |
| 2.1.3 | 查询消息押注 | `GET /messages/{msgId}/stakes` | pro=1, con=0, pool.lockedPro=1 |
| 2.1.4 | 发消息（指定 stakeAmount=5） | `POST /topics/{topicId}/messages` `{"content":"重押消息","stakeAmount":5}` | 返回 201，可用点减少 5 |
| 2.1.5 | stakeAmount 超过余额 | stakeAmount=9999（余额不足时） | 返回 402，"贡献点余额不足" |
| 2.1.6 | 查询 PointsBadge | 查看导航栏余额 | 数字正确减少 |

### 2.2 独立押注 API

| # | 测试项 | 操作 | 预期 |
|---|--------|------|------|
| 2.2.1 | 押注 PRO | `POST /messages/{msgId}/stakes` `{"side":"PRO","amount":10}` | 返回 201，newAvailable 减少 10 |
| 2.2.2 | 押注 CON | `POST /messages/{msgId}/stakes` `{"side":"CON","amount":5}` | 返回 201 |
| 2.2.3 | 查询统计 | `GET /messages/{msgId}/stakes` | pro=累计值，con=累计值，pool 同步更新 |
| 2.2.4 | 最小押注额 | amount=0 | 返回 400，"最小押注额为 1 点" |
| 2.2.5 | 非法 side | side="NEUTRAL" | 返回 400，Zod 校验失败 |
| 2.2.6 | 余额不足 | amount=99999 | 返回错误（来自 events handler） |
| 2.2.7 | 未登录 | 不带 token | 返回 401 |

### 2.3 BetPool 一致性

| # | 测试项 | 操作 | 预期 |
|---|--------|------|------|
| 2.3.1 | BetPool 与 Stake 对齐 | 押注后 `GET /messages/{msgId}/stakes` | pool.lockedPro = 所有 PRO stake 之和，pool.lockedCon = 所有 CON stake 之和 |

### 2.4 前端押注数量控件

| # | 测试项 | 操作 | 预期 |
|---|--------|------|------|
| 2.4.1 | 发送按钮旁有金额输入 | 进入 Topic 详情页 | 输入框默认值=1 |
| 2.4.2 | 输入金额后发消息 | 输入 3，发送消息 | 消息创建成功，余额扣 3 |
| 2.4.3 | 金额上限 | 输入超过可用余额的值 | 发送失败，显示错误提示 |

### 2.5 赞同/反对 → 目标消息押注映射

| # | 测试项 | 操作 | 预期 |
|---|--------|------|------|
| 2.5.1 | 赞同 → 目标 PRO | 在 UI 中对某消息点"赞同"（agree 关系） | 目标消息的 BetPool.lockedPro 增加 1 |
| 2.5.2 | 反对 → 目标 CON | 在 UI 中对某消息点"反对"（disagree 关系） | 目标消息的 BetPool.lockedCon 增加 1 |
| 2.5.3 | 赞同/反对消耗余额 | 执行赞同/反对后查看余额 | available 减少 selfStakeOnCreate 数量 |
| 2.5.4 | 押注流水记录 | `GET /points/transactions` | 出现 LOCK 类型记录，data 含 side 和 messageId |

### 2.6 关系消息自押

| # | 测试项 | 操作 | 预期 |
|---|--------|------|------|
| 2.6.1 | 创建非表态关系（如 reply） | reply 一条消息 | 关系消息自身 BetPool.lockedPro 增加（自押 PRO） |
| 2.6.2 | 创建表态关系（agree） | agree 一条消息 | 目标消息 BetPool 增加（不押关系消息自身） |

---

## Phase 3：结算轮次与分账

### 3.1 创建结算轮次

| # | 测试项 | 操作 | 预期 |
|---|--------|------|------|
| 3.1.1 | 发起结算 | `POST /messages/{msgId}/rounds` `{}` | 返回 201，status="VOTING" |
| 3.1.2 | 并发约束 | 对同一消息再次 `POST /messages/{msgId}/rounds` | 返回错误，"该消息已有进行中的结算轮次" |
| 3.1.3 | 负债冻结用户 | debt_frozen=true 的用户发起 | 返回 403，"账户负债冻结" |
| 3.1.4 | 消息不存在 | msgId 不存在 | 返回 404 |
| 3.1.5 | 可选备注 | `{"note":"测试轮次"}` | 返回 201，round.note="测试轮次" |

### 3.2 投票

| # | 测试项 | 操作 | 预期 |
|---|--------|------|------|
| 3.2.1 | 投 TRUE | `POST /rounds/{roundId}/votes` `{"vote":"TRUE","amount":10}` | 返回 201，newAvailable 减少 10 |
| 3.2.2 | 投 FALSE | `POST /rounds/{roundId}/votes` `{"vote":"FALSE","amount":5}` | 返回 201 |
| 3.2.3 | 投 UNKNOWN | `POST /rounds/{roundId}/votes` `{"vote":"UNKNOWN","amount":3}` | 返回 201 |
| 3.2.4 | 多次投票（同一用户） | 同一用户投 TRUE 10 → TRUE 5 | 两次均成功，累计 15 |
| 3.2.5 | 改变投票方向 | 同一用户先投 TRUE 10 → FALSE 5 | 两次均成功，两条 VoteStake 记录 |
| 3.2.6 | 投票金额 < 1 | amount=0 | 返回 400 |
| 3.2.7 | 轮次不存在 | roundId 不存在 | 返回 404 |
| 3.2.8 | 轮次非 VOTING | 对 SETTLED 轮次投票 | 返回错误 |
| 3.2.9 | 余额不足 | amount=99999 | 返回错误 |
| 3.2.10 | 负债冻结 | debt_frozen=true 用户 | 返回错误 |

### 3.3 查询轮次

| # | 测试项 | 操作 | 预期 |
|---|--------|------|------|
| 3.3.1 | 消息轮次列表 | `GET /messages/{msgId}/rounds` | 返回所有轮次，含 votes 和 _count |
| 3.3.2 | 单个轮次详情 | `GET /rounds/{roundId}` | 含 weights（TRUE/FALSE/UNKNOWN 当前权重）和 votes 列表 |
| 3.3.3 | 轮次不存在 | `GET /rounds/nonexistent` | 返回 404 |

### 3.4 结算

| # | 测试项 | 操作 | 预期 |
|---|--------|------|------|
| 3.4.1 | TRUE 获胜结算 | 场景：投票 TRUE 权重最大 → `POST /rounds/{roundId}/close-and-settle`（需 round 创建者 token） | 返回 200，result="TRUE"，PRO 方获返本+瓜分 CON |
| 3.4.2 | FALSE 获胜结算 | 场景：投票 FALSE 权重最大 | result="FALSE"，CON 方获返本+瓜分 PRO |
| 3.4.3 | UNKNOWN 平局 | 场景：TRUE 和 FALSE 投票权重相等 | result="UNKNOWN"，所有押注退回 |
| 3.4.4 | 非发起者结算 | 用非 round 创建者的 token 调用 | 返回 403，"只有轮次发起者可以结算" |
| 3.4.5 | 重复结算 | 对已 SETTLED 的轮次再次调用 | 返回错误 |
| 3.4.6 | 结算后余额变化 | 结算后查看各用户 `GET /points/balance` | 赢家余额增加（返本+分红），输家余额不变（已扣） |
| 3.4.7 | 流水记录 | 结算后 `GET /points/transactions` | 出现 UNLOCK/SPEND 类型记录，含 settlementResult 信息 |
| 3.4.8 | 轮次状态 | `GET /rounds/{roundId}` | status="SETTLED"，result 非 null，closedAt 非 null |

### 3.5 推翻链（Clawback 基础验证）

| # | 测试项 | 操作 | 预期 |
|---|--------|------|------|
| 3.5.1 | 创建推翻轮次 | 先创建 Round 1 并结算（result=TRUE），再对同一消息创建 Round 2 | Round 2 的 previousRoundId = Round 1 的 id |
| 3.5.2 | 推翻后结算 | Round 2 投票 FALSE 获胜 → 结算 | Clawback 扣回 Round 1 赢家收益，再按 FALSE 分配 |
| 3.5.3 | 推翻链查询 | `GET /messages/{msgId}/rounds` | 轮次链显示完整（链式追溯） |

### 3.6 前端 SettlementPanel

| # | 测试项 | 操作 | 预期 |
|---|--------|------|------|
| 3.6.1 | 点击 ⚖️ 展开 | 在消息卡片头部（有押注时）点击 ⚖️ 按钮 | 展开结算面板，显示押注池（PRO/CON 数量） |
| 3.6.2 | 无押注时不显示 ⚖️ | 查看一条没有任何押注的消息 | 不显示 ⚖️ 按钮 |
| 3.6.3 | 发起结算按钮 | 点击"发起结算" | 创建轮次，面板显示"投票中"状态 |
| 3.6.4 | 投票操作 | 选择 TRUE/FALSE/UNKNOWN + 金额 → 点"投票" | 投票成功，权重条更新 |
| 3.6.5 | 结算按钮 | 点"结算"（需是 round 创建者） | 弹出确认框，确认后显示结算结果 |
| 3.6.6 | 结算历史 | 展开 ⚖️ 后查看轮次列表 | 显示已结算轮次的结果（TRUE/FALSE/UNKNOWN）和推翻链 |

### 3.7 前端 RoundHistory

| # | 测试项 | 操作 | 预期 |
|---|--------|------|------|
| 3.7.1 | Compact 模式 | SettlementPanel 下方的 RoundHistory compact | 显示最新结算结果 |
| 3.7.2 | 链可视化 | 多轮次消息的 chain 显示 | 以圆角标签链显示 TRUE → FALSE → UNKNOWN |
| 3.7.3 | 点击展开详情 | 点击链中的某一轮次 | 展开详情：状态、结果、权重条、投票记录列表 |
| 3.7.4 | 投票记录明细 | 展开某轮次后查看 | 显示每个投票用户的 username、方向、金额 |

---

## 四、跨 Phase 集成测试

### 4.1 完整结算流程（端到端）

**场景**：3 个用户围绕一条消息完成押注→结算→推翻的完整生命周期。

| 步骤 | 用户 | 操作 | 预期 |
|------|------|------|------|
| 1 | alice | 注册 alice/123456，登录 | 余额 100 |
| 2 | bob | 注册 bob/123456，登录 | 余额 100 |
| 3 | charlie | 注册 charlie/123456，登录 | 余额 100 |
| 4 | alice | 创建 Topic "E2E测试" | topicId 记下 |
| 5 | alice | 发送消息 "太阳从东边升起" | msgId 记下，alice 自押 1 PRO，余额 99 |
| 6 | bob | 对 msgId 押注 PRO 20 | 余额 80 |
| 7 | charlie | 对 msgId 押注 CON 15 | 余额 85 |
| 8 | alice | 对 msgId 押注 PRO 10 | 余额 89 |
| 9 | - | `GET /messages/{msgId}/stakes` | PRO=31, CON=15 |
| 10 | alice | 发起结算轮次 | roundId 记下 |
| 11 | bob | 投票 TRUE 20 | 余额 60 |
| 12 | charlie | 投票 FALSE 10 | 余额 75 |
| 13 | alice | 投票 TRUE 5 | 余额 84 |
| 14 | alice | 结算 | result=TRUE（TRUE 权重 25 > FALSE 10） |
| 15 | - | 检查各方余额 | alice/bob（PRO方）获利，charlie（CON方）损失 |

### 4.2 负债冻结基本验证

> 注：负债冻结（debt_frozen）由 Clawback 触发，主要测试在 Phase 4。此处做基础校验。

| # | 测试项 | 操作 | 预期 |
|---|--------|------|------|
| 4.2.1 | 正常用户不冻结 | 查看任意新用户 Balance | debtFrozen=false |
| 4.2.2 | 余额为负时冻结 | 结算后 Clawback 导致 balance<0 | debtFrozen=true |

### 4.3 审计日志完整性

| # | 测试项 | 操作 | 预期 |
|---|--------|------|------|
| 4.3.1 | 事件被记录 | 检查数据库 AuditLog 表 | 包含以下事件：USER_REGISTERED, POINT_MINTED, TOPIC_CREATED, MESSAGE_CREATED, STAKE_PLACED, ROUND_CREATED, VOTE_CAST, ROUND_SETTLED |
| 4.3.2 | 事件含完整 payload | 查看各条 AuditLog.data | 含相关 messageId、amount、side 等信息 |

---

## 五、快速手动测试脚本

以下为 PowerShell 一键测试脚本，验证核心流程：

```powershell
$BASE = "http://localhost:3000/api"

# 1. 注册
$alice = Invoke-RestMethod "$BASE/auth/register" -Method POST -Body '{"username":"alice","password":"123456"}' -ContentType "application/json"
$bob   = Invoke-RestMethod "$BASE/auth/register" -Method POST -Body '{"username":"bob","password":"123456"}' -ContentType "application/json"

# 2. 登录
$aliceToken = (Invoke-RestMethod "$BASE/auth/login" -Method POST -Body '{"username":"alice","password":"123456"}' -ContentType "application/json").token
$bobToken   = (Invoke-RestMethod "$BASE/auth/login" -Method POST -Body '{"username":"bob","password":"123456"}' -ContentType "application/json").token
$authAlice  = @{Authorization="Bearer $aliceToken"}
$authBob    = @{Authorization="Bearer $bobToken"}

# 3. 查余额
Invoke-RestMethod "$BASE/points/balance" -Headers $authAlice
# 预期: available=100, locked=0

# 4. 创建话题
$topic = Invoke-RestMethod "$BASE/topics" -Method POST -Body '{"title":"测试"}' -Headers $authAlice -ContentType "application/json"

# 5. 发消息
$msg = Invoke-RestMethod "$BASE/topics/$($topic.id)/messages" -Method POST -Body '{"content":"hello"}' -Headers $authAlice -ContentType "application/json"

# 6. bob 押注 CON
Invoke-RestMethod "$BASE/messages/$($msg.id)/stakes" -Method POST -Body '{"side":"CON","amount":10}' -Headers $authBob -ContentType "application/json"

# 7. 查押注统计
Invoke-RestMethod "$BASE/messages/$($msg.id)/stakes"
# 预期: pro=1(alice自押), con=10

# 8. alice 发起结算
$round = Invoke-RestMethod "$BASE/messages/$($msg.id)/rounds" -Method POST -Body '{}' -Headers $authAlice -ContentType "application/json"

# 9. alice 投票 TRUE
Invoke-RestMethod "$BASE/rounds/$($round.id)/votes" -Method POST -Body '{"vote":"TRUE","amount":5}' -Headers $authAlice -ContentType "application/json"

# 10. bob 投票 FALSE
Invoke-RestMethod "$BASE/rounds/$($round.id)/votes" -Method POST -Body '{"vote":"FALSE","amount":3}' -Headers $authBob -ContentType "application/json"

# 11. alice 结算
$result = Invoke-RestMethod "$BASE/rounds/$($round.id)/close-and-settle" -Method POST -Headers $authAlice
# 预期: result="TRUE"（TRUE权重5 > FALSE权重3）

Write-Host "结算结果: $($result.result)"
Write-Host "TRUE权重: $($result.weights.TRUE)"
Write-Host "FALSE权重: $($result.weights.FALSE)"
```

---

## 六、测试用例汇总

| Phase | 测试项数 | 关键覆盖 |
|-------|----------|----------|
| Phase 0 | 10 | 注册/登录、JWT 鉴权、规则 seed、publicKey |
| Phase 1 | 8 | 余额查询、流水查询、PointsBadge、模型一致性 |
| Phase 2 | 16 | 自押、独立押注、BetPool 同步、赞同/反对映射、前端控件 |
| Phase 3 | 26 | 创建轮次、并发约束、投票（含多次/改向）、TRUE/FALSE/UNKNOWN 结算、Clawback、前端面板 |
| 集成 | 19 | 端到端流程、负债冻结、审计日志 |
| **合计** | **79** | 覆盖全部 Phase 0-3 功能细节 |
