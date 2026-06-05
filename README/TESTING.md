# 测试环境搭建与运行指南

本文档说明如何为「公论（Public Opinion）」项目搭建测试环境、运行各类测试，以及如何在本地和 CI 中触发测试。

---

## 目录

1. [技术栈与依赖概览](#技术栈与依赖概览)
2. [首次搭建](#首次搭建)
3. [运行测试](#运行测试)
4. [前端测试详解（Vitest + React Testing Library）](#前端测试详解)
5. [后端测试详解（Jest + Supertest）](#后端测试详解)
6. [CI 集成（GitHub Actions）](#ci-集成)
7. [设计符合性报告](#设计符合性报告)

---

## 技术栈与依赖概览

### 前端测试（`frontend/`）

| 依赖 | 版本 | 用途 |
|------|------|------|
| `vitest` | ^2.1.9 | 测试运行器（基于 Vite，天然支持 TypeScript） |
| `@vitest/coverage-v8` | ^2.1.9 | 代码覆盖率报告 |
| `@testing-library/react` | ^16.3.0 | React 组件测试工具 |
| `@testing-library/jest-dom` | ^6.6.3 | DOM 断言扩展（`toBeInTheDocument()` 等） |
| `@testing-library/user-event` | ^14.5.2 | 模拟用户交互 |
| `jsdom` | ^25.0.1 | 浏览器环境模拟 |

### 后端测试（`backend/`）

| 依赖 | 版本 | 用途 |
|------|------|------|
| `jest` | ^29.7.0 | 测试运行器 |
| `@types/jest` | ^29.5.14 | Jest TypeScript 类型 |
| `ts-jest` | ^29.2.6 | TypeScript 转换（让 Jest 直接运行 .ts） |
| `supertest` | ^7.0.0 | HTTP 集成测试（无需启动真实服务器） |
| `@types/supertest` | ^6.0.2 | Supertest TypeScript 类型 |

---

## 首次搭建

### 前提条件

- Node.js >= 18（推荐 20 LTS）
- npm >= 9

### 安装步骤

```bash
# 1. 克隆仓库
git clone https://github.com/TheMaJunjian/public-opinion.git
cd public-opinion

# 2. 安装前端依赖（包含测试框架）
cd frontend
npm install
cd ..

# 3. 安装后端依赖（包含测试框架）
cd backend
npm install
cd ..
```

> **说明**：测试依赖已经包含在各自的 `package.json` 的 `devDependencies` 中，`npm install` 会自动安装。

---

## 运行测试

### 前端测试

```bash
cd frontend

# 单次运行所有测试（推荐在 CI 或提交前使用）
npm test

# 监听模式（文件变更时自动重跑，推荐开发时使用）
npm run test:watch

# 带覆盖率报告
npm run test:coverage
# 覆盖率报告生成在 frontend/coverage/ 目录，打开 coverage/index.html 查看 HTML 报告
```

### 后端测试

```bash
cd backend

# 单次运行所有测试
npm test

# 监听模式
npm run test:watch

# 带覆盖率报告
npm run test:coverage
```

> **注意**：后端测试使用了 Jest mock，不需要真实数据库连接。`DATABASE_URL` 环境变量可以是任意字符串（mock 会拦截所有 Prisma 调用）。如需设置：
>
> ```bash
> export JWT_SECRET=any-test-secret
> npm test
> ```

### 全部测试（一键）

```bash
# 在项目根目录
cd frontend && npm test; cd ../backend && npm test
```

---

## 前端测试详解

### 测试文件位置

所有测试文件放在 `frontend/src/test/` 目录：

```
frontend/src/test/
  setup.ts              # 测试环境初始化（引入 @testing-library/jest-dom）
  graph.test.ts         # 图算法工具函数测试
  types.test.ts         # 类型辅助函数和 PRESENTATION_SPECS 测试
  RelationBadge.test.tsx  # RelationBadge 组件测试
```

### Vitest 配置

测试配置位于 `frontend/vite.config.ts` 中的 `test` 字段：

```typescript
test: {
  environment: 'jsdom',        // 模拟浏览器 DOM 环境
  globals: true,               // describe/it/expect 全局可用
  setupFiles: ['./src/test/setup.ts'],  // 每个测试文件前运行
  coverage: {
    provider: 'v8',
    reporter: ['text', 'html', 'lcov'],
    include: ['src/**/*.{ts,tsx}'],
    exclude: ['src/test/**', 'src/main.tsx'],
  },
},
```

### 编写新的前端测试

#### 工具函数测试示例

```typescript
// frontend/src/test/myUtil.test.ts
import { describe, it, expect } from 'vitest';
import { myFunction } from '../utils/myUtil';

describe('myFunction', () => {
  it('returns expected result', () => {
    expect(myFunction('input')).toBe('expected output');
  });
});
```

#### React 组件测试示例

```typescript
// frontend/src/test/MyComponent.test.tsx
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import MyComponent from '../components/MyComponent';

describe('MyComponent', () => {
  it('renders correctly', () => {
    render(<MyComponent label="test" />);
    expect(screen.getByText('test')).toBeInTheDocument();
  });

  it('responds to user interaction', async () => {
    const user = userEvent.setup();
    render(<MyComponent onChange={fn} />);
    await user.click(screen.getByRole('button'));
    // ... assertions
  });
});
```

### 现有前端测试覆盖范围

| 测试文件 | 测试数量 | 覆盖内容 |
|---------|---------|---------|
| `graph.test.ts` | 20 | `buildMessageTree`, `computeStanceStats`, `computeTextHops`, `buildFocusSubgraph` |
| `types.test.ts` | 19 | `getPresentationSpec`, `getTargetMessageIds`, `getTargetRelationIds`, `PRESENTATION_SPECS` 完整性 |
| `RelationBadge.test.tsx` | 9 | 所有 14 种关系类型的徽标渲染、未知类型降级显示、`className` prop |

---

## 后端测试详解

### 测试文件位置

```
backend/src/test/
  validation.test.ts      # Zod schema 验证逻辑单元测试
  relations.api.test.ts   # /api/topics/:topicId/relations 集成测试
```

### Jest 配置

配置文件：`backend/jest.config.json`

```json
{
  "preset": "ts-jest",
  "testEnvironment": "node",
  "testMatch": ["**/src/test/**/*.test.ts"],
  "transform": {
    "^.+\\.ts$": ["ts-jest", { "tsconfig": "tsconfig.json" }]
  },
  "clearMocks": true,
  "resetMocks": true
}
```

### Prisma Mock 策略

后端集成测试使用 `jest.mock('../lib/prisma')` 完全替换 Prisma 客户端，不需要真实数据库：

```typescript
jest.mock('../lib/prisma', () => ({
  prisma: {
    topic: { findUnique: jest.fn() },
    message: { findFirst: jest.fn(), findMany: jest.fn() },
    relation: { create: jest.fn(), findMany: jest.fn(), count: jest.fn() },
  },
}));

import { prisma } from '../lib/prisma';

beforeEach(() => {
  // 为每个测试设置 mock 返回值
  (prisma.topic.findUnique as jest.Mock).mockResolvedValue(mockTopic);
});
```

### 编写新的后端 API 测试

```typescript
// backend/src/test/myRoute.api.test.ts
import request from 'supertest';
import app from '../app';

jest.mock('../lib/prisma', () => ({
  prisma: {
    myModel: { findMany: jest.fn() },
  },
}));

import { prisma } from '../lib/prisma';

describe('GET /api/myRoute', () => {
  it('returns 200 with data', async () => {
    (prisma.myModel.findMany as jest.Mock).mockResolvedValue([{ id: '1' }]);
    const res = await request(app).get('/api/myRoute');
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
  });
});
```

### 现有后端测试覆盖范围

| 测试文件 | 测试数量 | 覆盖内容 |
|---------|---------|---------|
| `validation.test.ts` | 21 | `TargetRef` discriminated union 所有 3 种 kind、`createRelationSchema` 全部验证规则 |
| `relations.api.test.ts` | 14 | GET/POST 接口、鉴权、话题不存在/归档、来源消息校验、关系目标递归、404 响应 |

---

## CI 集成

### GitHub Actions 工作流

工作流配置：`.github/workflows/tests.yml`

自动在以下情况触发：
- 向 `main` 分支 push
- 创建或更新目标为 `main` 的 Pull Request
- 向 `copilot/**` 分支 push

工作流包含两个并行 job：
1. **Frontend Tests** — 运行 `npm test`（Vitest）
2. **Backend Tests** — 运行 `npm test`（Jest + Supertest，无真实数据库）

### 本地模拟 CI

如果你想在本地完整模拟 CI 流程：

```bash
# 前端
cd frontend
npm ci           # 使用 package-lock.json 精确安装，与 CI 一致
npm test         # 单次运行

# 后端
cd ../backend
npm ci
JWT_SECRET=local-ci-test npm test
```

### 手动触发 CI（GitHub 上）

1. 打开仓库 → **Actions** → **Tests** workflow
2. 点击 **Run workflow** → 选择分支 → **Run workflow**

---

## 设计符合性报告

以下是对照设计文档对当前代码的符合性检查结果：

### ✅ 符合的点

| 设计要求 | 实现情况 |
|---------|---------|
| 消息和关系消息是一等公民 | `Relation` 有独立 id、作者、时间，可被 `TargetRef` 的 `relation` kind 直接指向 |
| `TargetRef` 区分 message / text-fragment / relation | ✅ discriminated union，后端 Zod + 前端 TypeScript 双重约束 |
| 来源只能是文本消息 | ✅ `RelationForm` 只展示 `messages` 列表作为 source；后端校验 `sourceMessageId` 必须存在于 `message` 表 |
| 目标可以是文本消息、文本片段或关系消息 | ✅ `TargetRef` 完整支持三种 kind |
| 关系消息可递归（对关系建立关系） | ✅ `kind: 'relation'` 的 target 支持，后端校验目标关系是否存在 |
| `PresentationSpec` 抽象层 | ✅ `PRESENTATION_SPECS` registry + `getPresentationSpec()` 函数；新增关系类型只需添加一条记录 |
| 所有 14 种关系类型 | ✅ ANNOTATION/REFERENCE/REPLY/AGREE/DISAGREE/SUPPORT/REBUT/CORRECT/SUPPLEMENT/CLASSIFY/MERGE/SUMMARY/RECOMMEND/ARCHIVE |
| 焦点模式 hop 语义正确 | ✅ `computeTextHops()` 以文本消息为节点做 BFS；关系消息仅在两端文本消息都可见时才显示 |
| `buildFocusSubgraph` 递归关系处理 | ✅ 使用 fixed-point 迭代确保 relation→relation 目标正确传播 |
| 数据格式基于新架构 | ✅ `targetRefs: Json`（discriminated union），抛弃了旧 `targetMessageId` 格式 |
| `RelationBadge` 由 `PresentationSpec` 驱动 | ✅ 颜色、图标、标签均来自 spec，新增类型自动适配 |
| 立场统计（stance stats）通过 spec 扩展 | ✅ `stanceEffect` 字段驱动计数逻辑 |
| 树状视图（`formsTrees`）通过 spec 扩展 | ✅ `formsTrees` 字段驱动 `buildMessageTree` |

### ⚠️ 待完善的点

| 设计要求 | 现状 | 建议 |
|---------|------|------|
| 关系消息的「点击区/片段」选中行为（单击=片段，双击=全选） | 后端 `part` 字段已就绪，但前端无独立的选中状态 UI | 添加前端选中高亮状态管理 |
| 各 `PresentationKind` 的差异化渲染（装饰/框架/替换覆盖等） | 当前 UI 统一使用 `RelationBadge` + 侧边栏列表渲染所有类型 | 按 kind 实现差异化渲染组件 |
| 显示稳定性（布局变化不影响其他消息绘制） | 当前为 CSS 流布局，稳定性一般 | 可引入绝对定位或 canvas 视图 |
| `Message` 表中的遗留字段（`quoteSourceId` 等） | 旧字段仍保留在 schema 中 | 可做清理 migration（不影响核心功能） |

---

## 常见问题

**Q: 后端测试报 `Cannot find module '../lib/prisma'`**  
A: 确保在 `backend/` 目录下运行 `npm test`，而不是在根目录。

**Q: 前端测试报 `ReferenceError: document is not defined`**  
A: 检查 `vite.config.ts` 中 `test.environment` 是否为 `'jsdom'`，且 `setup.ts` 已正确导入 `@testing-library/jest-dom`。

**Q: 如何只运行特定测试文件？**

```bash
# 前端：指定文件名
cd frontend && npx vitest run src/test/graph.test.ts

# 后端：使用 --testPathPattern
cd backend && npx jest --config jest.config.json --testPathPattern=validation
```

**Q: 如何调试失败的测试？**

```bash
# 前端：增加 --reporter=verbose
cd frontend && npx vitest run --reporter=verbose

# 后端：增加 --verbose
cd backend && npx jest --config jest.config.json --verbose
```
