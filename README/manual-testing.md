# 公论（Public-Opinion）当前手动测试文档

> 版本：v1.1，日期：2026-07-31。基于当前源码和 RuleVersion v1，使用 curl 或 Postman 执行。
> 测试前请先 `cd backend && npx prisma db push --force-reset && npx prisma db seed` 重置数据库。

## 当前口径

- 注册奖励：`2000` 点。
- 创建消息默认自押：`10` 点 PRO；每次押注/投票另收 `1` 点手续费，进入 RevenuePool。
- 当前关系类型由 `backend/src/lib/relationTypes.ts` 定义，共 `20` 种；`JOIN` 是容器内部关系，`RECOMMEND`/`ARCHIVE` 通过 TAG 入口使用。
- 投票接口仍是 `/api/rounds/:id/votes`，但实际创建无文本 `AGREE`/`DISAGREE` 关系消息；`UNKNOWN` 是结算平局结果，不是投票选项。
- 结算权限由 RuleVersion 决定，seed 默认 `anyone`。
- `/api/messages/:id/stakes` 是押注统计查询；写入押注可来自消息自押、关系消息和兼容的独立押注入口。
- 本文验证中心化 Web 原型的当前行为，不验证独立节点、P2P 或链上执行。

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
| 0.1.1 | 注册成功 | `POST /auth/register` `{"username":"alice","password":"123456"}` | 返回 201，user 含 id/username，自动获 2000 点注册奖励 |
| 0.1.2 | 重复注册 | 再用相同 username 注册 | 返回 409，"该资源已存在" |
| 0.1.3 | 与会者名校验 | username="a" | 返回 400，"与会者名至少 2 个字符" |
| 0.1.4 | 密码校验 | password="123" | 返回 400，"密码至少 6 个字符" |

### 0.2 登录与 JWT

| # | 测试项 | 操作 | 预期 |
|---|--------|------|------|
| 0.2.1 | 登录成功 | `POST /auth/login` `{"username":"alice","password":"123456"}` | 返回 200，含 token 和 user |
| 0.2.2 | 密码错误 | password="wrong" | 返回 401，"与会者名或密码错误" |
| 0.2.3 | 不存在的与会者 | username="nobody" | 返回 401 |
| 0.2.4 | 无 token 访问受保护 API | `GET /points/balance`（无 Authorization） | 返回 401，"未提供认证令牌" |
| 0.2.5 | 错误 token 访问 | Bearer 随意字符串 | 返回 401，"令牌无效或已过期" |

### 0.3 规则种子数据

| # | 测试项 | 操作 | 预期 |
|---|--------|------|------|
| 0.3.1 | 查询当前规则 | `GET /rules/current` | 返回 version=1, status="ACTIVE"，parameters 含 minStake=1, selfStakeOnCreate=10, stakeFeeAmount=1, settlementPermission="anyone" |

### 0.4 User publicKey 字段

| # | 测试项 | 操作 | 预期 |
|---|--------|------|------|
| 0.4.1 | 注册后 publicKey 为 null | 检查数据库 `SELECT "publicKey" FROM "User" WHERE username='alice'` | 值为 NULL（预留字段） |

---

## Phase 1：贡献点与账本

### 1.1 注册奖励

| # | 测试项 | 操作 | 预期 |
|---|--------|------|------|
| 1.1.1 | 注册获 2000 点 | 注册新与会者 bob/123456 | 注册成功 |
| 1.1.2 | 查询余额 | bob 登录后 `GET /points/balance` | available=2000, locked=0, balance.amount=2000, debtFrozen=false |
| 1.1.3 | 查询流水 | bob 登录后 `GET /points/transactions` | 有 1 条 MINT 类型记录，amount=+2000，reason="REGISTRATION_BONUS" |
| 1.1.4 | 查询流水无认证 | `GET /points/transactions` 无 token | 返回 401 |

### 1.2 前端 PointsBadge

| # | 测试项 | 操作 | 预期 |
|---|--------|------|------|
| 1.2.1 | 导航栏显示余额 | 登录后查看页面顶部导航栏 | 显示 "💎 2000" |
| 1.2.2 | 点击展开流水 | 点击 PointsBadge | 弹出面板显示 "铸造 +2000 余额 2000" |
| 1.2.3 | 锁定金额显示 | 押注后（Phase 2 操作后）回来检查 | 显示 "🔒N" |
| 1.2.4 | 负债冻结显示 | 负债后（Phase 4 操作后）检查 | 显示 "❄️冻结" + "负债N" |

### 1.3 Balance 与 PointAccount 一致性

| # | 测试项 | 操作 | 预期 |
|---|--------|------|------|
| 1.3.1 | 两个模型余额一致 | 注册后检查 Balance.balance 和 PointAccount.available | 两者相等（均为 2000） |
| 1.3.2 | 押注后一致性 | 押注后检查两者 | Balance.balance = PointAccount.available + PointAccount.locked |

---

## Phase 2：押注与资金池

### 2.1 发消息自动自押 PRO

| # | 测试项 | 操作 | 预期 |
|---|--------|------|------|
| 2.1.1 | 创建 Topic | `POST /topics` `{"title":"测试议题"}` （需 token） | 返回 201，记下 topicId |
| 2.1.2 | 发消息（无 stakeAmount） | `POST /topics/{topicId}/messages` `{"content":"第一条消息"}` | 返回 201，可用点减少 11（10 点自押 + 1 点手续费） |
| 2.1.3 | 查询消息押注 | `GET /messages/{msgId}/stakes` | pro=10, con=0, pool.lockedPro=10 |
| 2.1.4 | 发消息（指定 stakeAmount=20） | `POST /topics/{topicId}/messages` `{"content":"重押消息","stakeAmount":20}` | 返回 201，可用点减少 21（20 点自押 + 1 点手续费） |
| 2.1.5 | stakeAmount 超过余额 | stakeAmount=9999（余额不足时） | 返回 402，"贡献点余额不足" |
| 2.1.6 | 查询 PointsBadge | 查看导航栏余额 | 数字正确减少 |

### 2.2 押注统计和兼容写入 API

> 产品主流程使用“创建消息自押”和“AGREE/DISAGREE 关系消息投票”。独立押注 POST 仍用于兼容性测试，不作为标准演示路径。

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
| 2.5.1 | 赞同 → 目标 PRO | 在 UI 中对某消息点"赞同"（AGREE 关系） | 创建无文本 AGREE 关系并按当前规则记入目标 PRO 统计 |
| 2.5.2 | 反对 → 目标 CON | 在 UI 中对某消息点"反对"（DISAGREE 关系） | 创建无文本 DISAGREE 关系并按当前规则记入目标 CON 统计 |
| 2.5.3 | 赞同/反对消耗余额 | 执行赞同/反对后查看余额 | available 减少 selfStakeOnCreate 数量 |
| 2.5.4 | 押注流水记录 | `GET /points/transactions` | 出现 LOCK 类型记录，data 含 side 和 messageId |

### 2.6 关系消息自押

| # | 测试项 | 操作 | 预期 |
|---|--------|------|------|
| 2.6.1 | 创建非表态关系（如 reply） | reply 一条消息 | 关系消息自身 BetPool.lockedPro 增加（自押 PRO） |
| 2.6.2 | 创建表态关系（agree） | agree 一条消息 | 目标消息 BetPool 增加（不押关系消息自身） |

### 2.7 排行榜与近期消息

- 排行榜统计当前讨论范围；人榜同时显示发送消息总数、文本消息数和关系消息数，且总数始终等于两类数量之和。JOIN、发起结算和结算结果均归关系消息，也参与消息榜，同一消息 ID 只计一次。三项数量均可单独排序。
- 系统生成的结算记录按已记录的发起人或触发操作归属用户；延时结算沿用该轮发起人，缺少可核对的归属信息时保留实际作者。发起和完成是不同消息，分别计入关系消息数；目标消息的结算活跃度仍按轮次去重。
- “最近文本消息”只列独立文本；回复、引用、分类、提案、加入、发起结算和结算结果等列入“最近关系消息”，按“【类型】消息ID：正文”显示。有正文的关系消息仍归关系列表。
- 人榜名称列表头为“与会者”。消息榜按“排名、消息 ID、消息摘要、议事人、各项统计指标、议事人 ID”的顺序显示；议事人 ID 放在最右侧，与人榜采用相同归属。“被押注总点”表示这条消息收到的押注，排序文案采用相同名称。系统结算记录对应的 ID 和名称应属于同一发起或触发用户。可按消息 ID、议事人 ID 或议事人搜索，长 ID 可完整查看和复制。
- 消息榜表头、排序和激烈度说明统一使用“押注人数”。排行榜右下角可拖动调整宽高，拖动时左上角保持不动，松开后自动居中，切换榜单保持手动尺寸。“自适应窗口”按当前列宽和本页实际内容收紧宽高，内容变多时再扩展，不为填满屏幕留下大块空白。窗口允许超过可视区域，通过外层横向和纵向滚动查看，关闭、恢复和分页控件应保持可访问；手动缩小窗口时表格可在内部滚动。
- 人榜、消息榜都可拖动表头右侧边缘调整列宽，拖动时只预览，松开后统一更新并保存一次；自适应窗口跟随预览宽度，松开后恢复居中，手动窗口尺寸保持不变。双击边缘恢复该列，也可聚焦后用左右方向键调整；“重置列宽”恢复当前榜单的默认列宽。切换榜单后各自保留列宽。
- 两榜默认每页 20 条，可选择 50 或 100 条，显示筛选后的总条数、当前范围和页码，支持首页、上一页、下一页和末页。消息榜超过 80 条仍可翻页查看；跨页排名连续，搜索、排序、调整样本或每页条数后回到第一页，切换榜单保留各自页码。刷新后记录减少时页码不应超出范围；没有匹配结果时显示空状态且翻页按钮不可用。
- 两榜各列宽度、窗口手动宽高（或自适应模式）和每页条数自动保存在当前浏览器；关闭重开、刷新页面后恢复。重置列宽只影响当前榜单，自适应只恢复窗口布局，均保留其他设置。存储内容异常、不可用或空间不足时，窗口仍应可正常使用。
- 关闭重开保留当前榜单、排序、筛选和页码；数据未变时复用统计与排序，不重新请求数据、读写设置或重绘讨论画布。关闭时移除弹窗及尺寸观察器，后台消息变化不触发排行榜计算；重开时展示最新数据，必要时收回超出范围的页码。切换排序不应重新汇总消息或生成全部摘要；未修改设置的打开操作不写存储。名称列改名后继续沿用此前保存的列宽。
- 点击“排行榜”立即显示“正在打开排行榜…”居中提示及旋转进度图标，先让提示呈现，再开始加载、统计及表格布局；首次打开和关闭重开均应有响应。模块加载或计算期间提示持续保留，榜单准备好后自动切换，不额外固定等待。连续点击不重复打开；准备期间可取消，取消或离开页面后不得延迟弹出窗口。打开失败应结束等待并提示重试。
- 点击“刷新”沿用当前同步游标读取增量，不重新全量加载或建立事件连接；无变化时保留统计及画布。有增量时显示“刷新完成，已更新最新数据”，无增量时显示“刷新完成，暂无新变化”，提示在约 1.5 秒后自动消失。等待期间显示“刷新中…”并禁用重复点击；请求失败提示重试，不能显示成功。导出文件阅览模式不发起网络刷新。刷新时关闭窗口不应残留提示或定时器。
- 分别缩小、放大窗口后连续关闭重开，恢复最终尺寸时应无明显卡顿。连续拖动只预览窗口尺寸，松开后统一保存；重复布局测量不应持续重绘界面。用每页 100 条和消息较多的讨论验证，确认居中、自适应、滚动和保存设置仍正常。
- 右下角只点击、按住不拖动或移动不足 3 像素时，不应改变居中位置、拉高窗口或出现下方空白区域；取消拖动或失去指针捕获应恢复拖动前的尺寸和布局，不保存未完成的调整。
- 排行榜内拖动手柄时尝试先向下、再向右上方往返调整，不应打开“快捷符输入蒙版”。按钮、输入框、窗口与列宽分隔条的拖动不参与全局手势识别；鼠标已松键或失去捕获后，移动到其他消息不得继续先前轨迹。普通区域主动绘制快捷符仍应可用。
- 在 Chrome 原生窗口按“打开排行榜 → 拖动调整宽高 → 自适应窗口 → 关闭”操作后，以约每秒一次的速度在两条消息间交替点击至少 30 秒，再连续来回点击至少 40 次，等候数秒后继续点击、滚动和输入；选择区和画面中的操作日志均应及时更新，不应残留遮罩或重新计算排行榜。分别验证人榜、消息榜、多个浏览器窗口与长页面。背景引导线应由整组透明度动画统一驱动，不逐条移动背景或预设独立图层；关闭后不应残留运行的引导动画。遮罩只覆盖可视窗口，大表格通过排行榜自身的滚动区域查看。
- 对关系消息押注、表态或引用后，消息榜和作者人榜的对应指标应同步增加。被表态贡献点读取实际押注金额，引用同一消息的多个片段不重复增加引用热度。
- 充值申请未执行时收入不增加，实际分账后按接收者到账点数增加；“充值及受押总点”为充值到账点数加消息受押总额，不代表结算收益。
- 同一轮结算的发起与完成只计一次结算活跃度。切换各排序条件及升降序、搜索 ID/用户名、设置净支持率最小样本，结果应与表格数值一致；刷新后新消息应重新参与排名。

---

## Phase 3：结算轮次与分账

### 3.1 创建结算轮次

| # | 测试项 | 操作 | 预期 |
|---|--------|------|------|
| 3.1.1 | 发起结算 | `POST /messages/{msgId}/rounds` `{}` | 返回 201，status="VOTING" |
| 3.1.2 | 并发约束 | 对同一消息再次 `POST /messages/{msgId}/rounds` | 返回错误，"该消息已有进行中的结算轮次" |
| 3.1.3 | 负债冻结与会者 | debt_frozen=true 的与会者发起 | 返回 403，"账户负债冻结" |
| 3.1.4 | 消息不存在 | msgId 不存在 | 返回 404 |
| 3.1.5 | 可选备注 | `{"note":"测试轮次"}` | 返回 201，round.note="测试轮次" |

### 3.2 投票

| # | 测试项 | 操作 | 预期 |
|---|--------|------|------|
| 3.2.1 | 投 TRUE | `POST /rounds/{roundId}/votes` `{"vote":"TRUE","amount":10}` | 返回 201，newAvailable 减少 10 |
| 3.2.2 | 投 FALSE | `POST /rounds/{roundId}/votes` `{"vote":"FALSE","amount":5}` | 返回 201 |
| 3.2.3 | 平局结果 | 不提交 UNKNOWN 投票；让 TRUE/FALSE 权重相等后结算 | 返回 result="UNKNOWN" |
| 3.2.4 | 多次投票（同一与会者） | 同一与会者投 TRUE 10 → TRUE 5 | 两次均成功，累计 15 |
| 3.2.5 | 改变投票方向 | 同一与会者先投 TRUE 10 → FALSE 5 | 两次均成功，两条 VoteStake 记录 |
| 3.2.6 | 投票金额 < 1 | amount=0 | 返回 400 |
| 3.2.7 | 轮次不存在 | roundId 不存在 | 返回 404 |
| 3.2.8 | 轮次非 VOTING | 对 SETTLED 轮次投票 | 返回错误 |
| 3.2.9 | 余额不足 | amount=99999 | 返回错误 |
| 3.2.10 | 负债冻结 | debt_frozen=true 与会者 | 返回 403 错误 |

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
| 3.4.6 | 结算后余额变化 | 结算后查看各与会者 `GET /points/balance` | 赢家余额增加（返本+分红），输家余额不变（已扣） |
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
| 3.6.4 | 投票操作 | 选择 TRUE/FALSE + 金额 → 点"投票" | 投票成功，权重条更新；平局时结算结果为 UNKNOWN |
| 3.6.5 | 结算按钮 | 点"结算"（需是 round 创建者） | 弹出确认框，确认后显示结算结果 |
| 3.6.6 | 结算历史 | 展开 ⚖️ 后查看轮次列表 | 显示已结算轮次的结果（TRUE/FALSE/UNKNOWN）和推翻链 |

### 3.7 前端 RoundHistory

| # | 测试项 | 操作 | 预期 |
|---|--------|------|------|
| 3.7.1 | Compact 模式 | SettlementPanel 下方的 RoundHistory compact | 显示最新结算结果 |
| 3.7.2 | 链可视化 | 多轮次消息的 chain 显示 | 以圆角标签链显示 TRUE → FALSE → UNKNOWN |
| 3.7.3 | 点击展开详情 | 点击链中的某一轮次 | 展开详情：状态、结果、权重条、投票记录列表 |
| 3.7.4 | 投票记录明细 | 展开某轮次后查看 | 显示每个投票与会者的 username、方向、金额 |

---

## 四、跨 Phase 集成测试

### 4.1 完整结算流程（端到端）

**场景**：3 个与会者围绕一条消息完成押注→结算→推翻的完整生命周期。

| 步骤 | 与会者 | 操作 | 预期 |
|------|------|------|------|
| 1 | alice | 注册 alice/123456，登录 | 余额 2000 |
| 2 | bob | 注册 bob/123456，登录 | 余额 2000 |
| 3 | charlie | 注册 charlie/123456，登录 | 余额 2000 |
| 4 | alice | 创建 Topic "E2E测试" | topicId 记下 |
| 5 | alice | 发送消息 "太阳从东边升起" | msgId 记下，alice 自押 10 PRO 并支付 1 点手续费，余额 1989 |
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
| 4.2.1 | 正常与会者不冻结 | 查看任意新与会者 Balance | debtFrozen=false |
| 4.2.2 | 余额为负时冻结 | 结算后 Clawback 导致 balance<0 | debtFrozen=true |

### 4.3 审计日志完整性

| # | 测试项 | 操作 | 预期 |
|---|--------|------|------|
| 4.3.1 | 事件被记录 | 检查数据库 AuditLog 表 | 包含 USER_REGISTERED, POINT_MINTED, TOPIC_CREATED, MESSAGE_CREATED, STAKE_PLACED, ROUND_CREATED/相关 MESSAGE_CREATED、ROUND_SETTLED；当前投票通过带 `relationPayload.vote=true` 的 RELATION_CREATED 记录 |
| 4.3.2 | 事件含完整 payload | 查看各条 AuditLog.data | 含相关 messageId、amount、side 等信息；投票关系还应含 relationPayload.roundId 和 relationPayload.amount |
| 4.3.3 | 审计快照导出 | `GET /topics/{topicId}/export/audit-export` | 返回 `formatVersion=1`，含 messages、auditEvents、stakes、votes、rounds、rules，可作为独立 replay 输入 |
| 4.3.4 | 离线回放 | `cd backend; npm run replay:export -- path/to/audit-export.json` | 输出主题范围的 stakes、votes、rounds 复算摘要；不宣称完成全局余额守恒 |

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
# 预期: available=2000, locked=0

# 4. 创建话题
$topic = Invoke-RestMethod "$BASE/topics" -Method POST -Body '{"title":"测试"}' -Headers $authAlice -ContentType "application/json"

# 5. 发消息
$msg = Invoke-RestMethod "$BASE/topics/$($topic.id)/messages" -Method POST -Body '{"content":"hello"}' -Headers $authAlice -ContentType "application/json"

# 6. bob 通过 DISAGREE 关系消息对目标表达 CON 立场
Invoke-RestMethod "$BASE/messages/$($msg.id)/stakes" -Method POST -Body '{"side":"CON","amount":10}' -Headers $authBob -ContentType "application/json"

# 7. 查押注统计
Invoke-RestMethod "$BASE/messages/$($msg.id)/stakes"
# 预期: pro=10(alice自押), con=10

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
| **合计** | **79** | 覆盖当前 Phase 0-3 核心功能；其中独立押注写入用例属于兼容性验证 |
