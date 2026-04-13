# 公论 (GongLun) 后端 API

公论是一个结构化讨论系统，支持用户在话题下发布消息并通过显式关系（支持、反对、引用等）建立观点网络。本文档为 MVP 后端部署与测试指南。

---

## 技术栈与依赖

| 依赖 | 版本 | 用途 |
|------|------|------|
| Node.js | 20+ | 运行时 |
| TypeScript | 5.6 | 类型安全 |
| Express | 4.x | HTTP 框架 |
| Prisma | 5.x | ORM + 数据库迁移 |
| PostgreSQL | 16 | 关系型数据库 |
| jsonwebtoken | 9.x | JWT 认证 |
| bcryptjs | 2.x | 密码哈希 |
| zod | 3.x | 请求体校验 |
| swagger-ui-express | 5.x | API 文档 UI |
| express-rate-limit | 7.x | 写操作速率限制 |

---

## 快速开始（推荐：Docker Compose）

**前提：已安装 Docker 和 Docker Compose**

```bash
cd backend

# 1. 启动 PostgreSQL + API 服务
docker-compose up -d

# 2. 等待约 10 秒让数据库就绪，然后运行迁移
docker-compose exec api npx prisma migrate deploy
```

服务启动后：
- **API 根路径**: http://localhost:3000
- **Swagger 交互文档**: http://localhost:3000/api-docs

---

## 手动安装（本地开发）

**前提：已安装 Node.js 20+，并有可用的 PostgreSQL 实例**

```bash
cd backend

# 1. 安装依赖
npm install

# 2. 配置环境变量
cp .env.example .env
# 编辑 .env，填入实际的 DATABASE_URL 和 JWT_SECRET

# 3. 初始化数据库（生成表结构）
npm run db:migrate

# 4. 启动开发服务器（热重载）
npm run dev
```

### 可用命令

| 命令 | 说明 |
|------|------|
| `npm run dev` | 开发模式（ts-node-dev 热重载） |
| `npm run build` | 编译为 JavaScript |
| `npm start` | 生产模式启动（需先 build） |
| `npm run db:migrate` | 创建并应用迁移 |
| `npm run db:generate` | 重新生成 Prisma 客户端 |
| `npm run db:push` | 直接同步 schema（开发调试用） |
| `npm run db:studio` | 打开 Prisma Studio 可视化管理 |

---

## API 端点总览

### 认证 `/api/auth`
| 方法 | 路径 | 需认证 | 说明 |
|------|------|--------|------|
| POST | `/api/auth/register` | 否 | 注册（用户名+密码） |
| POST | `/api/auth/login` | 否 | 登录，返回 JWT |
| POST | `/api/auth/logout` | 是 | 登出（客户端删除令牌） |

### 话题 `/api/topics`
| 方法 | 路径 | 需认证 | 说明 |
|------|------|--------|------|
| GET | `/api/topics` | 否 | 列表（支持搜索、排序、分页） |
| POST | `/api/topics` | 是 | 创建话题 |
| GET | `/api/topics/:topicId` | 否 | 获取单个话题 |
| PATCH | `/api/topics/:topicId` | 是（仅作者）| 更新话题状态/内容 |
| DELETE | `/api/topics/:topicId` | 是（仅作者）| 删除话题（连带消息和关系） |

### 消息 `/api/topics/:topicId/messages`
| 方法 | 路径 | 需认证 | 说明 |
|------|------|--------|------|
| GET | `/api/topics/:topicId/messages` | 否 | 分页列出消息 |
| POST | `/api/topics/:topicId/messages` | 是 | 发布消息（不可变） |

### 关系 `/api/topics/:topicId/relations`
| 方法 | 路径 | 需认证 | 说明 |
|------|------|--------|------|
| GET | `/api/topics/:topicId/relations` | 否 | 列出关系（可按消息过滤） |
| POST | `/api/topics/:topicId/relations` | 是 | 建立关系 |

---

## Postman / HTTPie 测试流程

> 以下示例使用 [HTTPie](https://httpie.io/)。也可直接在 http://localhost:3000/api-docs 使用 Swagger UI 交互测试。

### 步骤 1：注册用户

```bash
http POST localhost:3000/api/auth/register \
  username="alice" \
  password="secret123"
```

### 步骤 2：登录，获取 JWT Token

```bash
http POST localhost:3000/api/auth/login \
  username="alice" \
  password="secret123"
# 响应中取 token 字段，下面用 $TOKEN 代替
```

### 步骤 3：创建话题

```bash
http POST localhost:3000/api/topics \
  "Authorization:Bearer $TOKEN" \
  title="关于气候变化的全球讨论" \
  body="这个话题邀请所有人就气候变化提出观点和证据。"
# 记录返回的 id，下面用 $TOPIC_ID 代替
```

### 步骤 4：发布第一条消息

```bash
http POST localhost:3000/api/topics/$TOPIC_ID/messages \
  "Authorization:Bearer $TOKEN" \
  content="可再生能源是应对气候变化的核心解决方案。" \
  contentType="TEXT"
# 记录返回的 id，下面用 $MSG1_ID 代替
```

### 步骤 5：发布引用局部文字的消息（partial quote）

> quotedTextHash 为引用文字的 SHA-256 十六进制值，可用以下命令生成：
> ```bash
> echo -n "核心解决方案" | sha256sum
> # 输出: a3f1c8...（32 字节十六进制，去掉末尾空格和 '-'）
> ```

```bash
http POST localhost:3000/api/topics/$TOPIC_ID/messages \
  "Authorization:Bearer $TOKEN" \
  content="补充：核能也应纳入考量，而不仅限于可再生能源。" \
  contentType="TEXT" \
  quoteSourceId="$MSG1_ID" \
  quotedText="核心解决方案" \
  quotedTextHash="a3f1c8d2e5b7f9041c6a8d3e2f5b7901a3f1c8d2e5b7f9041c6a8d3e2f5b790"
```

### 步骤 6：建立 OPPOSE（反对）关系

```bash
http POST localhost:3000/api/topics/$TOPIC_ID/relations \
  "Authorization:Bearer $TOKEN" \
  relationType="OPPOSE" \
  sourceMessageId="$MSG2_ID" \
  targetRefs:='[{"targetMessageId": "$MSG1_ID"}]'
```

### 步骤 7：建立 CORRECT（更正）关系

```bash
http POST localhost:3000/api/topics/$TOPIC_ID/relations \
  "Authorization:Bearer $TOKEN" \
  relationType="CORRECT" \
  sourceMessageId="$MSG2_ID" \
  targetRefs:='[{"targetMessageId": "$MSG1_ID", "targetSelectedText": "核心解决方案"}]'
```

### 步骤 8：查询话题下所有关系

```bash
http GET localhost:3000/api/topics/$TOPIC_ID/relations
```

### 步骤 9：按消息过滤关系（查看某条消息的所有相关关系）

```bash
http GET "localhost:3000/api/topics/$TOPIC_ID/relations?messageId=$MSG1_ID"
```

---

## 设计要点

- **消息不可变**：消息一旦发布，不可修改或删除（符合 SRS 要求）
- **显式关系图**：消息间的逻辑关系通过独立的 Relation 实体声明，支持多目标（targetRefs 数组）
- **局部引用**：发消息时可附带 quoteSourceId + quotedText + quotedTextHash，引用另一条消息的片段
- **关系类型**：QUOTE / REPLY / SUPPORT / OPPOSE / CORRECT / LINK / UNLINK（共 7 种）
- **JWT 无状态认证**：登出只需客户端删除令牌，服务端无需维护黑名单（MVP 简化）
- **写操作速率限制**：防止脚本刷屏，默认每 IP 每 15 分钟最多 100 次写请求
- **OpenAPI 文档**：完整 schema 位于 `src/openapi.yaml`，Swagger UI 在 `/api-docs`

---

## 目录结构

```
backend/
├── src/
│   ├── index.ts              # 服务器入口（启动监听）
│   ├── app.ts                # Express 应用配置（路由、中间件）
│   ├── openapi.yaml          # OpenAPI 3.0 规范文档
│   ├── lib/
│   │   └── prisma.ts         # Prisma 客户端单例
│   ├── middleware/
│   │   ├── auth.ts           # JWT 认证中间件
│   │   └── errorHandler.ts   # 全局错误处理
│   └── routes/
│       ├── auth.ts           # 注册/登录/登出
│       ├── topics.ts         # 话题 CRUD
│       ├── messages.ts       # 消息（只写+只读）
│       └── relations.ts      # 关系建立与查询
├── prisma/
│   └── schema.prisma         # 数据库 schema（User/Topic/Message/Relation）
├── Dockerfile
├── docker-compose.yml
├── .env.example
├── package.json
└── tsconfig.json
```
