# 公论 (GongLun) 后端 API

公论是一个结构化讨论系统，支持用户在话题下发布消息并通过显式关系（支持、反对、引用等）建立观点网络。

## 技术栈

- **运行时**: Node.js 20 + TypeScript
- **框架**: Express 4
- **ORM**: Prisma 5
- **数据库**: PostgreSQL 16
- **认证**: JWT (7 天有效期)
- **校验**: Zod
- **文档**: OpenAPI 3.0 + Swagger UI

## 快速开始（Docker Compose）

```bash
cd backend
docker-compose up -d
```

服务启动后：
- API: http://localhost:3000
- Swagger 文档: http://localhost:3000/api-docs

## 手动安装

```bash
cd backend
npm install
cp .env.example .env
# 修改 .env 中的 DATABASE_URL 和 JWT_SECRET
npm run db:migrate
npm run dev
```

## API 端点总览

### 认证 `/api/auth`
| 方法 | 路径 | 需认证 |
|------|------|--------|
| POST | `/api/auth/register` | 否 |
| POST | `/api/auth/login` | 否 |
| POST | `/api/auth/logout` | 是 |

### 话题 `/api/topics`
| 方法 | 路径 | 需认证 |
|------|------|--------|
| GET | `/api/topics` | 否 |
| POST | `/api/topics` | 是 |
| GET | `/api/topics/:topicId` | 否 |
| PATCH | `/api/topics/:topicId` | 是（仅作者）|
| DELETE | `/api/topics/:topicId` | 是（仅作者）|

### 消息 & 关系
| 方法 | 路径 | 需认证 |
|------|------|--------|
| GET | `/api/topics/:topicId/messages` | 否 |
| POST | `/api/topics/:topicId/messages` | 是 |
| GET | `/api/topics/:topicId/relations` | 否 |
| POST | `/api/topics/:topicId/relations` | 是 |

## 设计要点

- **消息不可变**：消息一旦发布不可修改或删除
- **显式关系**：消息间逻辑关系通过 Relation 模型显式声明
- **JWT 无状态认证**：登出仅需客户端删除令牌
