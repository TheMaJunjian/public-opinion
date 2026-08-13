# 公论 Frontend

**一切记录在案，是非自有公论。**

公论（GongLun）是为楚门设计的结构化讨论工具——一套非线性表显示和交互系统。

---

## 设计理念

公论放弃线性表结构，改用**非线性表结构**展示与交互信息：

> 消息是节点；消息的关系也是消息；消息的关系的关系依然是消息。

核心功能：
- **图谱、树和列表视图** — 同一批消息与关系的不同投影
- **关系消息递归引用** — 关系本身也是消息，可作为后续关系的目标
- **分类、总结、归并、排列和焦点导航** — 通过容器关系降低复杂讨论的阅读负担
- **立场、押注和结算面板** — 展示 PRO/CON、轮次、结果、推翻链和账本变化
- **审计、收入和清爽视图** — 查看操作历史、收入池和组合过滤结果

---

## 技术栈

- Vite + React 18 + TypeScript
- Tailwind CSS
- React Router DOM
- 原生 `fetch` 调用后端 RESTful API

---

## 快速开始

```bash
cd frontend
npm install
```

### 开发（对接真实后端）

确保后端运行在 `http://localhost:3000`，然后：

```bash
npm run dev
```

### 构建

```bash
npm run build
```

---

## 环境变量

复制 `.env.example` 为 `.env` 并按需修改：

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `VITE_API_BASE_URL` | `http://localhost:3000/api` | 后端 API 基础 URL |

> 内置 Mock 数据已移除，前端始终请求真实后端。开发时请先启动后端（见 `README/重启后启动开发环境.md`）。

---

## 页面结构

| 路径 | 说明 |
|------|------|
| `/` | 分类广场（搜索/分页/创建分类） |
| `/login` | 登录 |
| `/register` | 注册 |
| `/topics/:id` | 分类详情（图谱 / 树 / 列表 + 关系创建 + 结算面板） |
| `/topics/:id/messages/:msgId` | 节点详情（单条消息的全量关联分析） |

---

## 项目结构

```
src/
  api/
    client.ts   # fetch 封装，读取 localStorage token 作为 Bearer
    mock.ts     # Mock 数据（含示例树型讨论）
    index.ts    # API 统一入口（真实后端）
  context/
    AuthContext.tsx    # 用户认证状态（localStorage 持久化）
  utils/
    graph.ts          # 图关系、立场和焦点子图计算
  types/
    index.ts          # User / Topic / Message / Relation / 结算和过滤类型
  pages/
    TopicListPage.tsx
    TopicDetailPage.tsx   # 非线性视图核心页
    MessageDetailPage.tsx
    LoginPage.tsx
    RegisterPage.tsx
  components/
    Navbar.tsx
    TopicCard.tsx
    MessageCard.tsx       # 支持 relationType 左边框色 + 立场统计
    GraphView.tsx         # 图谱投影和关系实体渲染
    TopicStructureView.tsx # 分类、总结、归并等容器视图
    SettlementPanel.tsx   # 轮次、投票和结算
    PointsBadge.tsx       # 可用、锁定和冻结积分
    AuditLogView.tsx      # 审计日志
    CleanFilterPanel.tsx  # 清爽视图过滤器
```

---

## 当前关系类型说明

后端当前允许 20 种关系类型：`ANNOTATION`、`REFERENCE`、`REPLY`、`NOTIFY`、`AGREE`、`DISAGREE`、`TAG`、`CORRECT`、`ARRANGE`、`CLASSIFY`、`MERGE`、`SUMMARY`、`RECOMMEND`、`ARCHIVE`、`ATTENTION`、`BLOCK`、`PROPOSAL`、`CODE_CHANGE`、`OPERATIONS`、`JOIN`。

其中 `RECOMMEND`/`ARCHIVE` 由 TAG 入口创建，`JOIN` 是容器创建时的内部成员关系，不一定作为顶层工具栏按钮展示。

| 类型 | 颜色 | 含义 |
|------|------|------|
| AGREE | 绿色 | 赞同目标；无文本时是纯立场消息 |
| DISAGREE | 红色 | 反对目标；无文本时是纯立场消息 |
| CORRECT | 黄色 | 对某条消息的事实纠正 |
| REPLY   | 蓝色 | 回复某条消息 |
| QUOTE   | 靛蓝 | 引用某条消息的片段 |
| LINK    | 灰色 | 建立关联 |
| UNLINK  | 灰色 | 解除关联 |

