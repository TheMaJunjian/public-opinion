# Demo 理解与验收基线（工程可执行规格·深度版）

> **版本**：2026-05-03（深度修订版）  
> **来源**：基于 `docs/demo/赞同反对支持反驳与焦点与回复与引用与注释关系非线性结构显示和交互3.tsx` 及用户反馈全量分析。  
> 本文档以"工程可执行规格"为目标：每个函数/状态/交互事件均有独立条目，含输入、输出、状态读写、副作用及用户可见影响。

---

## 目录

1. [状态模型](#1-状态模型)
2. [关键函数解读（函数级）](#2-关键函数解读)
3. [交互事件链](#3-交互事件链)
4. [线性视图与非线性视图差异](#4-线性视图与非线性视图差异)
5. [候选区规则与同步策略](#5-候选区规则与同步策略)
6. [焦点规则](#6-焦点规则)
7. [边渲染几何规则](#7-边渲染几何规则)
8. [扩展性设计](#8-扩展性设计)
9. [功能清单](#9-功能清单)
10. [Gap 清单](#10-gap-清单)
11. [验收 Checklist](#11-验收-checklist)

---

## 1. 状态模型

### 1.1 全局状态（TopicDetailPage）

| 状态变量 | 类型 | 初始值 | 语义 |
|---------|------|--------|------|
| `topic` | `Topic \| null` | `null` | 当前话题元数据 |
| `messages` | `Message[]` | `[]` | 当前页所有文本消息 |
| `relations` | `Relation[]` | `[]` | 所有关系（不分页，limit=200） |
| `viewMode` | `'graph' \| 'tree' \| 'linear'` | `'graph'` | 左侧视图模式 |
| `relationType` | `string` | `'REPLY'` | 当前选中的关系类型（工具栏高亮项） |
| `focusMode` | `boolean` | `false` | 焦点模式是否启用 |
| `focusMessageId` | `string` | `''` | 当前焦点消息 ID（空字符串 = 未选） |
| `focusHops` | `number` | `2` | 焦点模式跳数（1–5） |
| `draft` | `DraftItem[]` | `[]` | 候选区条目列表 |
| `sources` | `DraftItem[]` | `[]` | 来源集合（仅 type='message'） |
| `targets` | `DraftItem[]` | `[]` | 目标集合（任意类型） |
| `textSelectionModeId` | `string \| null` | `null` | 当前处于文本选择模式的消息 ID（提升至父组件）|

### 1.2 状态迁移图

```
viewMode:
  graph ←──────────────→ tree ←──────→ linear
    └── 点击工具栏按钮 ──────────────────────┘

focusMode:
  false ──[开启 / 有候选时自动设 focusMessageId]──→ true
  true  ──[退出全部]────────────────────────────→ false

focusMessageId:
  '' ──[选择 / 开启时有候选]──→ <msgId>
  <msgId> ──[退出焦点]──→ ''

draft:
  [] ──[单击消息/关系标签 / 拖选文字]──→ [item, ...]
  [item, ...]  ──[单击空白 / 清空按钮]──→ []
             ──[加入来源/目标 批量]──→ items 移出 draft

textSelectionModeId:
  null ──[双击消息卡片]──→ <msgId>
  <msgId> ──[再次双击 / 单击空白 / 清空 draft]──→ null
```

### 1.3 DraftItem 类型（辨别联合）

```typescript
type DraftItem =
  | { type: 'message';      id: string }
  | { type: 'text-fragment'; messageId: string; text: string; hash: string }
  | { type: 'relation';     id: string; part?: 'label' | 'decoration' | 'frame' | 'whole' }
```

### 1.4 TargetRef 类型（辨别联合）

```typescript
type TargetRef =
  | { kind: 'message';       messageId: string }
  | { kind: 'text-fragment'; messageId: string; text: string; hash: string }
  | { kind: 'relation';      relationId: string; part?: 'label' | 'decoration' | 'frame' | 'whole' }
```

---

## 2. 关键函数解读

### 2.1 `TopicDetailPage` — 数据加载

#### `load()`
- **输入**：`topicId`（URL 参数），`msgPage`（当前分页）
- **输出**：设置 `topic`, `messages`, `relations`, `msgTotalPages`
- **状态读写**：读 `topicId`/`msgPage`；写 `loading`, `error`, `topic`, `messages`, `relations`, `msgTotalPages`
- **副作用**：并行调用 3 个 API（`getTopic`, `getMessages`, `getRelations`）
- **用户可见**：加载完成后左侧显示消息卡片，右侧显示关系列表

### 2.2 `TopicDetailPage` — 候选区管理

#### `handleClickMessage(id: string)`
- **触发**：用户单击消息卡片
- **逻辑**：若 `draft` 中已有同 ID 的 `message` 条目 → 移除（取消选中）；否则追加 `{ type: 'message', id }`
- **状态写**：`draft`
- **用户可见**：卡片边框 indigo 高亮 ↔ 普通，右侧候选区条目增减

#### `handleClickRelation(id: string)`
- **触发**：用户点击边标签或装饰 badge
- **逻辑**：与 `handleClickMessage` 类似，对 `type='relation'` 条目做切换
- **状态写**：`draft`
- **用户可见**：边标签 / badge 高亮切换，候选区出现关系条目

#### `handleSelectFragment(messageId, text, hash)`
- **触发**：用户在文本选择模式下拖选文字后 `mouseup`
- **逻辑**：切换 `type='text-fragment'` 条目（相同 messageId + text 则移除，否则追加）
- **状态写**：`draft`
- **用户可见**：候选区出现片段条目

#### `handleClearAll()`
- **触发**：清空按钮、单击视图空白区域
- **逻辑**：`draft = []`, `sources = []`, `targets = []`, `textSelectionModeId = null`
- **状态写**：`draft`, `sources`, `targets`, `textSelectionModeId`
- **用户可见**：候选区/来源/目标全部清空；所有卡片边框恢复普通色；文本选择模式退出

#### `handleBlankClick(e: React.MouseEvent)`
- **触发**：用户点击左侧视图的空白区域（非卡片、非标签）
- **逻辑**：检查 `e.target === e.currentTarget`（确保点击在容器自身而非子元素）→ 调 `handleClearAll()`
- **状态写**：同 `handleClearAll()`
- **用户可见**：同 `handleClearAll()`

### 2.3 `TopicDetailPage` — 集合转移

#### `handleDraftToSources(idx)` / `handleDraftToSourcesBatch(indices)`
- **约束**：只接受 `type='message'` 的整条消息（片段、关系不进来源集合）
- **逻辑**：将符合条件的 draft 项移入 `sources`（当前实现：来源一次保留最后一个）
- **状态写**：`sources`, `draft`

#### `handleDraftToTargets(idx)` / `handleDraftToTargetsBatch(indices)` / `handleDraftToTargetsAll()`
- **约束**：无类型限制（消息/片段/关系均可）
- **逻辑**：去重后追加到 `targets`，从 `draft` 移除
- **状态写**：`targets`, `draft`

### 2.4 `TopicDetailPage` — 焦点模式

#### `handleFocusToggle()`（已增强）
- **输入**：当前 `focusMode` 和 `draft`
- **逻辑**：
  ```
  if !focusMode:
    focusMode = true
    若 draft 中有 type='message' 的整条条目:
      focusMessageId = draft 第一个 type='message' 的 id
  else:
    focusMode = false
    focusMessageId = ''
  ```
- **状态写**：`focusMode`, `focusMessageId`
- **用户可见**：焦点模式开启时，若候选区有消息，视图立即筛选到该消息周围；否则显示全量消息

### 2.5 `computeLayout(messages, relations, visibleMessageIds)` — 布局

- **输入**：消息列表、关系列表、可见消息集合（可 null）
- **输出**：`{ posMap: Map<string, CardPos>, canvasWidth, canvasHeight }`
- **算法**：
  1. 所有消息初始列号 = 0
  2. 遍历 `edge-label` 和 `edge-decoration` 关系：`col(target) >= col(source) + 1`
  3. 迭代直到稳定（最多 200 次）
  4. 在每列内按创建时间排序，分配行号
  5. `x = PAD + col * (CARD_W + COL_GAP)`, `y = PAD + row * (CARD_H + ROW_GAP)`

### 2.6 `buildEdgePath(from, to)` — 边路径

- **输入**：源卡片位置 `from`、目标卡片位置 `to`
- **输出**：`{ path, labelPos, arrowEnd }`
- **公式**：
  ```
  x1 = from.x + CARD_W      // source 右中心
  y1 = from.y + CARD_H / 2
  x2 = to.x                 // target 左中心
  y2 = to.y + CARD_H / 2
  dx = |x2 - x1|
  cpx1 = x1 + dx * 0.45 (水平右偏控制点)
  cpx2 = x2 - dx * 0.45 (水平左偏控制点)
  path = "M x1 y1 C cpx1 y1 cpx2 y2 x2 y2"
  ```
- **标签位置**：贝塞尔中点 t=0.5

### 2.7 `groupDraftByMessage(draft)` — 候选区分组

- **输入**：`DraftItem[]`
- **输出**：`{ groups: DraftMessageGroup[], relationItems: DraftRelationItem[] }`
- **逻辑**：
  - 对 `type='message'` 和 `type='text-fragment'` 条目按 messageId 分组
  - `type='relation'` 条目单独收集到 `relationItems`
- **用途**：在候选区 UI 中将同消息的整条+片段显示为一组，关系条目单独显示

### 2.8 `draftItemToTargetRef(item)` — 类型转换

- **输入**：`DraftItem`
- **输出**：`TargetRef`
- **映射**：
  - `message` → `{ kind: 'message', messageId: item.id }`
  - `text-fragment` → `{ kind: 'text-fragment', messageId, text, hash }`
  - `relation` → `{ kind: 'relation', relationId: item.id, part }`

### 2.9 `buildFocusSubgraph(messages, relations, focusIds, hops)` — 焦点子图

- **输入**：消息列表、关系列表、焦点消息 ID 集合、跳数 N
- **输出**：`{ visibleMessages: Set<string>, visibleRelations: Set<string> }`
- **算法**：BFS 从焦点消息出发，通过关系边扩散，最多 N 跳；包含所有可达文本消息间的关系

---

## 3. 交互事件链

### 3.1 单击消息卡片（single click）

```
用户单击消息卡片
  → React onClick (仅在 !textMode 时绑定)
  → handleClickMessage(msgId)
    → draft.find(d => d.type='message' && d.id=msgId)
      已存在: draft.filter 移除 → 卡片恢复普通边框
      不存在: draft 追加 → 卡片变 indigo 边框 + ✓ 图标
```

### 3.2 双击消息卡片（double click）

```
用户双击消息卡片
  → React onDoubleClick
  → handleDoubleClick(msgId, e)
    → e.preventDefault() (阻止双击选文字默认行为)
    → textSelectionModeId === msgId ?
      → textSelectionModeId = null  (退出文本选择模式)
      → textSelectionModeId = msgId (进入文本选择模式)
        → 卡片变 amber 边框 + "T" 标志 + cursor: text
```

### 3.3 文本拖选（drag-select）

```
用户在 textMode 消息卡片上拖选文字 → mouseup
  → handleMouseUp(msgId)
    → textSelectionModeId !== msgId → 忽略
    → window.getSelection()
      collapsed / 空 → 忽略
      有文字:
        → onSelectFragment(msgId, text, hash)
          → draft 追加/切换 text-fragment
        → sel.removeAllRanges() (清除文字选中态)
```

### 3.4 单击空白区域（blank click）

```
用户点击左侧视图的空白区域（不在任何卡片/标签上）
  → onClick 事件冒泡到最外层容器
  → e.target === e.currentTarget (确认是空白区域)
  → handleClearAll()
    → draft = []
    → sources = []
    → targets = []
    → textSelectionModeId = null
    → 所有卡片边框恢复普通色
    → 候选区显示"单击消息卡片…"空提示
```

### 3.5 单击边标签 / 装饰 badge（relation click）

```
用户点击图视图边标签 或 列表视图装饰 badge
  → e.stopPropagation() (阻止冒泡到卡片 onClick)
  → onClickRelation(relationId)
    → handleClickRelation(relationId)
      → draft 切换 { type: 'relation', id, part: 'label' }
      → 标签/badge 高亮切换
```

### 3.6 边标签双击（edge label dblclick）

当前实现：暂未支持（可扩展）。演示中双击边标签可进入"关系-文本选择模式"。

### 3.7 候选区底部批量按钮

```
"加入来源集合" 按钮:
  → 遍历 draftGroups，找 hasWhole=true 的 group
  → 取其 wholeIndex 列表
  → onDraftToSourcesBatch(indices)
    → 筛选 type='message' 的条目 → setSources
    → setDraft 移除对应条目

"加入目标集合" 按钮:
  → onDraftToTargetsAll()
    → 去重后全部追加到 targets
    → draft = []
```

### 3.8 焦点模式开启（含候选区语义）

```
用户点击"开启"按钮:
  → handleFocusToggle()
    → !focusMode:
      → setFocusMode(true)
      → draft 有 type='message' 条目?
        是: setFocusMessageId(第一个 message id)
        否: focusMessageId 不变（仍为 '' 或保持原值）
    → focusMode:
      → setFocusMode(false)
      → setFocusMessageId('')
```

---

## 4. 线性视图与非线性视图差异

### 4.1 非线性视图（图视图 graph）

| 特征 | 规格 |
|------|------|
| 渲染方式 | SVG + 绝对定位卡片 |
| 布局 | 列布局，source 在左，target 在右 |
| 边类型 | edge-label / edge-decoration → 贝塞尔曲线 + 箭头 + 标签 |
| 装饰类型 | decoration / edge-decoration → 卡片内 badge |
| 内联标记 | inline-badge → 卡片角落 |
| 关系可见性 | 仅 edge-label + edge-decoration 有可见的边线 |
| 点击边 | 点击边标签按钮 → 关系加入候选区 |
| 空白点击 | 点击 SVG 背景或容器空白 → 清空候选区 |

### 4.2 线性视图（列表视图 linear）

| 特征 | 规格 |
|------|------|
| 渲染方式 | 普通列表，每条消息为一张卡片 |
| 排序 | 按 API 返回顺序（通常为创建时间升序） |
| 关系展示 | `decoration` / `edge-decoration` → 卡片内 badge（与图视图一致）|
| **关系消息展示** | **`edge-label` 和 `edge-decoration` 关系在其源消息卡片下方显示为可点击的"关系行"** |
| 关系行格式 | `[关系类型标签] → [目标消息摘要]`，可点击加入候选区 |
| 空白点击 | 点击列表容器任意空白处 → 清空候选区（消息卡片和关系行均 stopPropagation）|

### 4.3 关系消息在线性视图中的显示规则（详细）

```
对每条消息 msg:
  1. 渲染消息卡片（含 decoration/edge-decoration/inline-badge badge）
  2. 查找 outgoingRelationRows = relations.filter(
       r => r.sourceMessageId === msg.id &&
       (getPresentationSpec(r.relationType).kind === 'edge-label' ||
        getPresentationSpec(r.relationType).kind === 'edge-decoration')
     )
     注：edge-decoration（SUPPORT/REBUT）有有向边组件，因此也在源消息下方显示关系行；
         其装饰 badge 仍然显示在目标消息卡片上（两者并不冲突）。
  3. 对每条关系行 rel:
     渲染"关系行"：
       - 背景：该关系类型的 COLOR_BG 色
       - 边框：该关系类型的 COLOR_STROKE 色（半透明）
       - 内容：`[spec.label] → [目标消息作者] "目标消息前20字"`
       - 若 rel 在候选区（selectedRelationIds.has(rel.id)）：高亮（实色背景）
       - onClick: e.stopPropagation() → onClickRelation(rel.id)
       - title: "点击选中此关系"
```

### 4.4 树视图（tree）

- 使用 `buildMessageTree()` 基于 `formsTrees=true` 的关系类型构建树结构
- 若无 formsTrees 关系，回退到 InteractiveMessageList 显示
- 不支持文本片段选择（`MessageThread` 组件不含该交互）

---

## 5. 候选区规则与同步策略

### 5.1 加入规则

| 操作 | 加入候选区的内容 | 注意 |
|------|----------------|------|
| 单击消息卡片 | `{ type: 'message', id }` | 已有则移除（切换） |
| 双击→拖选文字 | `{ type: 'text-fragment', ... }` | 已有相同片段则移除 |
| 点击边标签/badge | `{ type: 'relation', id, part: 'label' }` | 已有则移除 |

### 5.2 移出规则（候选 → 来源/目标）

| 按钮 | 移出逻辑 |
|------|---------|
| "加入来源集合" | 仅取 `hasWhole=true` 的消息组 → 移入 sources；片段/关系留在 draft |
| "加入目标集合" | 全部 draft 内容移入 targets（去重）|
| 组头"×"按钮 | 移除整组（整条 + 所有片段）|
| 片段"×"按钮 | 仅移除该片段 |

### 5.3 清空触发条件

| 触发 | 清空范围 |
|------|---------|
| 点击视图空白区域 | draft + sources + targets + textSelectionModeId |
| "清空"按钮（候选区头部）| draft + sources + targets + textSelectionModeId |
| 操作 C/D 成功后 | `onClearAll()` 调用，同上 |

### 5.4 清空后状态同步

清空 draft 时必须同步重置：
1. **`textSelectionModeId = null`**：退出文本选择模式，所有 amber 边框消失
2. 来源集合、目标集合清空：所有 indigo/blue/green 高亮消失
3. 所有卡片恢复默认灰色边框

### 5.5 selected 集合计算（用于视图高亮）

```typescript
selectedMessageIds = new Set([
  ...draft (type='message').map(id),
  ...sources (type='message').map(id),
  ...targets (type='message').map(id),
])

selectedRelationIds = new Set([
  ...draft (type='relation').map(id),
  ...targets (type='relation').map(id),
])
```

---

## 6. 焦点规则

### 6.1 进入焦点（enter）

```
setFocusMode(true)
setFocusMessageId(msgId)  // 或保持 '' 如无候选
```

视图过滤：`buildFocusSubgraph(messages, relations, {focusMessageId}, focusHops)`

### 6.2 进入多目标焦点（enterMultiple）

当前实现：`buildFocusSubgraph` 接受 `Set<string>`，支持多起点 BFS。  
UI 层目前单选 focusMessageId；若候选区有多条整消息，可扩展为多选。

### 6.3 退出焦点（exit）

```
setFocusMessageId('')   // focusMode 仍为 true
```
视图回到全量消息，但仍处于"焦点模式"状态（UI 显示"◎ 焦点模式（开启）"）。

### 6.4 退出全部（exitAll）

```
setFocusMode(false)
setFocusMessageId('')
```

### 6.5 跳数（hop）语义

```
hop = 从起始文本消息经过几条关系边才能到达另一文本消息
例：A → [REPLY 关系] → B  = 1 跳
例：A → [REPLY 关系] → B → [SUPPORT 关系] → C = 2 跳
```

跳数范围：1–5（UI 为 5 个按钮），默认 2。

### 6.6 快照恢复

当前实现：无持久化快照。`focusMode`/`focusMessageId`/`focusHops` 均为组件内存状态，刷新后重置。

---

## 7. 边渲染几何规则

### 7.1 布局常量

```
CARD_W = 220px    // 消息卡片宽度
CARD_H = 110px    // 消息卡片高度
COL_GAP = 80px    // 列间距
ROW_GAP = 28px    // 行间距
PAD = 40px        // 画布边距
```

### 7.2 锚点规则

```
source 卡片右中心:  (x + CARD_W, y + CARD_H/2)
target 卡片左中心:  (x,          y + CARD_H/2)
```

### 7.3 贝塞尔控制点

```
dx = |target.x - (source.x + CARD_W)|
cpx1 = source.x + CARD_W + dx * 0.45
cpy1 = source.y + CARD_H / 2           // 水平切线
cpx2 = target.x - dx * 0.45
cpy2 = target.y + CARD_H / 2           // 水平切线
```

效果：S 型平滑曲线，从 source 右边水平出发，到 target 左边水平到达。

### 7.4 箭头（arrow marker）

- SVG `<marker>` 置于曲线末端（target 左边界处）
- 指向方向 = 曲线切线方向（`orient="auto"`）
- 每种颜色独立 marker（id = `arrow-{colorName}`）

### 7.5 标签避让（label offset）

```
LABEL_OFFSET_POSITIONS = 5
LABEL_OFFSET_INCREMENT = 14px
labelYOffset = (edgeIndex % 5) * 14px  // 按边序号在 Y 方向错位
```

标签固定宽度 100px，定位于贝塞尔中点，Z-index = 10（高于卡片 z-index 5）。

### 7.6 两遍渲染（Pass 1 / Pass 2）

**Pass 1**：目标为文本消息（kind='message' 或 'text-fragment'）的关系  
→ 从 source 卡片右中心 → target 卡片左中心  
→ 记录标签位置到 `relLabelPositions` Map

**Pass 2**：目标为关系消息（kind='relation'）的关系  
→ 从 source 卡片右中心 → Pass 1 记录的目标关系标签位置（cx, cy）  
→ 箭头指向关系标签，而非源消息卡片

### 7.7 Z-index 层级

| 元素 | z-index |
|------|---------|
| SVG 边线层 | 0 |
| 消息卡片（普通）| 5 |
| 边标签按钮 | 10 |
| 消息卡片（文本选择模式）| 15 |

---

## 8. 扩展性设计

### 8.1 新增关系类型（前端）

在 `frontend/src/types/index.ts` 的 `PRESENTATION_SPECS` 中新增一条：

```typescript
NEW_TYPE: {
  kind: 'edge-label',      // 选择合适的 kind
  label: '新关系名称',
  color: 'teal',           // Tailwind color token
  formsTrees: false,        // 是否参与树视图构建
  stanceEffect: undefined,  // 'support' | 'oppose' | undefined
},
```

**无需修改 GraphView / InteractiveMessageList**（它们通过 `PRESENTATION_SPECS` 动态获取样式）。

### 8.2 新增关系类型（后端）

在 `backend/src/lib/relationTypes.ts` 的 `RELATION_TYPES` 数组末尾追加：

```typescript
export const RELATION_TYPES = [
  // ... 现有类型
  'NEW_TYPE',   // 新类型描述
] as const;
```

- DB 列 `relationType` 为 `TEXT`，无需迁移
- Zod schema 自动包含新类型

### 8.3 新增 TargetRef 类型

若需支持新的 target 种类（如 topic-level 引用）：

1. 在 `frontend/src/types/index.ts` 的 `TargetRef` 联合类型追加新变体
2. 在 `backend/src/routes/relations.ts` 的 targetRef 解析逻辑中追加处理分支
3. 无需 DB 迁移（targetRefs 存储为 JSON）

### 8.4 新增 PresentationKind

若需新的视觉呈现方式：

1. 在 `frontend/src/types/index.ts` 的 `PresentationKind` 联合类型追加
2. 在 `GraphView.tsx` 和 `InteractiveMessageList.tsx` 中添加对应渲染分支
3. 前后端数据层无需改动

---

## 9. 功能清单

### 9.1 顶部区域（Toolbar）

| 功能 | 描述 | 实现文件 |
|------|------|----------|
| 话题标题与状态 | 显示话题名、状态、发起人、时间 | `TopicDetailPage` |
| 视图切换 | 图/树/列表三按钮 | `TopicDetailPage` |
| 关系类型选择条 | 横向按钮，当前选中 indigo 高亮 | `TopicDetailPage` |
| 焦点模式指示 | 开启时显示 "◎ 焦点模式：X/Y 条" | `TopicDetailPage` |

### 9.2 左侧视图区

| 功能 | 描述 | 状态 |
|------|------|------|
| 图视图 | SVG + 卡片，贝塞尔边 | ✅ |
| 树视图 | formsTrees 关系构建树 | ✅ |
| 列表视图 | 时间顺序线性列表 | ✅ |
| 单击选中 | indigo 边框 + 候选区 | ✅ |
| 双击文本模式 | amber 边框 + "T" 标志 | ✅ |
| 文本片段选择 | 拖选 → 候选区片段 | ✅ |
| 关系标签点击 | 关系加入候选区 | ✅ |
| **空白点击清空** | **点击空白 → 清空候选区** | ✅（已实现：InteractiveMessageList + TopicDetailPage 左侧面板）|
| **文本模式状态同步** | **清空候选区时退出文本模式** | ✅（已实现）|
| **线性视图关系行** | **edge-label + edge-decoration 关系显示在源消息下方** | ✅（已实现）|
| 默认高度 = 视口 | `min-height: calc(100vh - 220px)` | ✅ |
| 分页（列表/树）| 上/下页按钮 | ✅ |

### 9.3 右侧操作区

| 功能 | 描述 | 状态 |
|------|------|------|
| 候选区分组展示 | 消息组 + 关系条目 | ✅ |
| **候选区底部批量按钮** | "加入来源集合"/"加入目标集合" | ✅（已实现）|
| 来源集合 | 仅消息，蓝色 | ✅ |
| 目标集合 | 任意类型，绿色 | ✅ |
| 消息输入框 | 新消息内容 textarea | ✅ |
| A/B/C/D 操作按钮 | 四类发送/建关系流程 | ✅ |
| 焦点控制 | 开/关焦点、选消息、设跳数 | ✅ |
| **焦点模式用候选消息** | **开启时自动用候选第一条** | ✅（已实现）|
| 面板宽度 ≥ 380px | `width: 400px` | ✅ |
| 导出/导入 | JSON 下载、复制、导入 | ✅ |
| 关系列表/图例 | 底部展示 | ✅ |
| 立场统计 | 每条消息支持/反对进度条 | ✅ |

---

## 10. Gap 清单

| 差异项 | 状态 |
|--------|------|
| 右侧面板宽度（320px → 400px）| **已完成** |
| 左侧视图高度（min-height = 100vh-offset）| **已完成** |
| 非线性图视图列布局方向（source 左 target 右）| **已完成** |
| 边锚点（source 右边界 → target 左边界）| **已完成** |
| 候选区主交互改为底部批量按钮 | **已完成** |
| 后端 relationTypes 集中化 | **已完成** |
| 边标签小幅错位避让 | **已完成** |
| 点击空白清空候选区（InteractiveMessageList + 左侧面板兜底）| **已完成** |
| 清空候选区后状态同步（textSelectionModeId）| **已完成** |
| 候选区有消息时开启焦点 → 自动设焦点消息 | **已完成** |
| edge-label + edge-decoration 关系在线性视图中显示为关系行 | **已完成** |
| 发消息/建关系触发全页刷新（`await load()` 导致闪烁）| **已完成**（乐观更新：setMessages/setRelations，不再调 load()）|
| frame-group（CLASSIFY/MERGE）在图视图中不可见 | **已完成**（SVG 虚线边框 + 可点击标签）|
| DraftPanel 焦点控制在顶部、布局混乱 | **已完成**（焦点控制移至底部折叠面板，导出/导入同样折叠）|
| 右侧面板输入区在中间（应在底部）| **已完成**（输入+操作按钮移至来源/目标集合之后，焦点/导出折叠至最底部）|
| DraftItem 类型定义散落在 DraftPanel.tsx | **已完成**（已移入 frontend/src/types/index.ts 统一导出）|
| 完整 E2E 测试（Playwright）| 后续 |
| 边标签双击进入关系文本模式 | 后续 |
| 多焦点消息并行支持（UI 层）| 后续 |
| 关系类型前后端 shared schema 生成 | 后续 |
| 导入 API 完整实现 | 后续 |

---

## 11. 验收 Checklist（可手工执行）

### A. 界面检查

- [ ] 右侧操作区宽度 ≥ 380px，内容不被截断
- [ ] 左侧视图区域高度至少占满可视视口
- [ ] 图视图中消息卡片横向排列，源消息在左，目标消息在右
- [ ] 关系边从左侧卡片右中心出发，贝塞尔曲线向右延伸，到达右侧卡片左中心
- [ ] 箭头出现在右侧卡片左边界处（指向目标）
- [ ] 多条边的标签在 Y 方向错位，不完全重叠
- [ ] 列表视图中，每条消息卡片下方可见 edge-label 类型的关系行（如 REPLY、ANNOTATION）
- [ ] 列表视图中，每条消息卡片下方可见 edge-decoration 类型的关系行（如 SUPPORT、REBUT）

### B. 候选区交互检查

- [ ] 单击消息卡片 → 整条加入候选区，边框变 indigo，右侧候选区出现消息组
- [ ] 再次单击 → 取消选中，退出候选区，边框恢复普通
- [ ] 双击消息卡片 → 进入文本选择模式（amber 边框，"T" 标志，cursor: text）
- [ ] 双击再次 → 退出文本选择模式
- [ ] 文本选择模式下，拖选文字 → 候选区出现片段条目
- [ ] 单击图视图边标签 → 关系加入候选区，标签高亮
- [ ] 单击列表视图关系行 → 关系加入候选区，行高亮
- [ ] **点击左侧视图空白区域 → 候选区、来源、目标全部清空，所有高亮消失**
- [ ] **候选区清空后，文本选择模式（amber 边框）同步退出**
- [ ] 候选区底部"加入来源集合"按钮 → 整条消息批量移入来源集合
- [ ] 候选区底部"加入目标集合"按钮 → 全部内容批量移入目标集合

### C. 操作 A/B/C/D 检查

- [ ] 操作 A：输入内容 → 仅发送，候选区不影响
- [ ] 操作 B：输入内容 + 候选区有内容 → 发送并建立关系，候选区作目标
- [ ] 操作 C：输入内容 + 目标集合有内容 → 发送并建立关系，Targets 作目标
- [ ] 操作 D：来源集合有消息 + 目标集合有内容 → 不发新消息，仅建立关系

### D. 焦点模式检查

- [ ] 无候选时点击"开启" → focusMode=true，需手动选消息
- [ ] **候选区有整条消息时点击"开启" → 自动设该消息为焦点，视图立即过滤**
- [ ] 选择焦点消息 → 视图筛选到焦点消息 ± N 跳范围
- [ ] 调整跳数 → 视图实时更新
- [ ] "退出焦点" → focusMessageId 清空，focusMode 保持 true，视图回到全量
- [ ] "退出全部" → focusMode=false，视图回到全量，焦点指示隐藏

### E. 后端校验检查

- [ ] `POST /api/topics/:id/messages` 创建消息成功
- [ ] `POST /api/topics/:id/relations` 使用合法类型成功
- [ ] `POST /api/topics/:id/relations` 使用非法类型返回 400
- [ ] 新增关系类型只需修改 `backend/src/lib/relationTypes.ts` 中的数组

---

*本文档由 Copilot Agent 根据 demo 代码深度分析与用户需求生成，版本: 2026-05-03（第三次修订：edge-decoration 线性视图修复 + 空白点击修复）*
