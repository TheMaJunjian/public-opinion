# 公论 Frontend

**一切记录在案，是非自有公论。**

公论（GongLun）是为楚门设计的结构化讨论工具——一套非线性表显示和交互系统。

---

## 设计理念

公论放弃线性表结构，改用**非线性表结构**展示与交互信息：

> 消息是节点；消息的关系也是消息；消息的关系的关系依然是消息。

核心功能：
- **非线性树视图** — 按 REPLY/SUPPORT/OPPOSE/CORRECT 关系形成讨论分支树，直观呈现逻辑关联
- **立场统计** — 每条消息显示"▲ N 支持 / ▼ N 反对"的实时立场汇总
- **关联图谱** — 分类侧边栏汇总所有关系，支持添加新关联
- **时间轴视图** — 可切换为传统线性时序排列

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

### 开发（Mock 模式，无需后端）

```bash
VITE_USE_MOCK=true npm run dev
# 或在 .env 中设置 VITE_USE_MOCK=true
```

Mock 模式内置示例：
- 3 个用户（alice / bob / charlie，密码任意）
- 3 个分类，含多层 REPLY/SUPPORT/OPPOSE/CORRECT 关系
- 分类 t1"人工智能与就业"展示完整的 5 层非线性讨论树

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
| `VITE_USE_MOCK` | `false` | `true` 时使用内置 Mock 数据 |

---

## 页面结构

| 路径 | 说明 |
|------|------|
| `/` | 分类广场（搜索/分页/创建分类） |
| `/login` | 登录 |
| `/register` | 注册 |
| `/topics/:id` | 分类详情（非线性树视图 / 时间轴 + 关联图谱 + 立场统计） |
| `/topics/:id/messages/:msgId` | 节点详情（单条消息的全量关联分析） |

---

## 项目结构

```
src/
  api/
    client.ts   # fetch 封装，读取 localStorage token 作为 Bearer
    mock.ts     # Mock 数据（含示例树型讨论）
    index.ts    # 根据 VITE_USE_MOCK 导出真实或 Mock API
  context/
    AuthContext.tsx    # 用户认证状态（localStorage 持久化）
  utils/
    graph.ts          # buildMessageTree() / computeStanceStats()
  types/
    index.ts          # User / Topic / Message / Relation / MessageNode / StanceStats
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
    MessageThread.tsx     # 递归树节点组件（含缩进连接线）
    RelationBadge.tsx     # 关系类型彩色标签
    RelationView.tsx      # 节点维度的关联分析视图
    MessageForm.tsx
    RelationForm.tsx
```

---

## 关系类型说明

| 类型 | 颜色 | 含义 |
|------|------|------|
| SUPPORT | 绿色 | 支持某条消息的论点 |
| OPPOSE  | 红色 | 反对某条消息的论点 |
| CORRECT | 黄色 | 对某条消息的事实纠正 |
| REPLY   | 蓝色 | 回复某条消息 |
| QUOTE   | 靛蓝 | 引用某条消息的片段 |
| LINK    | 灰色 | 建立关联 |
| UNLINK  | 灰色 | 解除关联 |

