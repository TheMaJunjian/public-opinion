# 审计日志架构重设计

> 日期：2026-07-17
> 状态：已实施

---

## 1. 问题诊断

### 1.1 entityId 回补反模式（已修复）

旧代码模式：
```ts
// 事务内：entityId 写空字符串
prisma.auditLog.create({ data: { ..., entityId: '', ... } })
// 事务外：事后回补
await prisma.auditLog.updateMany({
  where: { action: 'XXX', entityId: '', actorId, topicId },
  data: { entityId: realId },
});
```

受影响的 handler：`TOPIC_CREATED`、`MESSAGE_CREATED`（TEXT + ROUND 两条路径）、`RELATION_CREATED`、`STAKE_PLACED`、`ROUND_CREATED`（手动 + ensureVotingRound）、`VOTE_CAST`。

### 1.2 写入入口不统一（已修复）

`relations.ts` 的 `RELATION_TARGETS_UPDATED` 直接在路由里写 auditLog，绕过了事件化体系。现已抽象为 `RelationTargetsUpdated` 事件类型。

### 1.3 其他问题

- `data` 字段结构松散，每种 action 的 payload 字段名不统一
- 前端 `ACTION_LABELS` 不完整，缺少 `VOTE_CAST`、`RELATION_SUPERSEDED`、`RELATION_TARGETS_UPDATED`、`POINT_TRANSFERRED`
- API 只支持 `topicId` 过滤，无法按 action/用户/实体过滤
- `AuditLog` 表无索引

---

## 2. 新架构

### 2.1 写入模式：后置写入

```
┌──────────────────────────────────────────┐
│              applyEvent(event)            │
│                                          │
│  1. 校验 + 准备参数                       │
│  2. prisma.$transaction([...状态变更])     │
│     → 返回实体（含 ID）                   │
│  3. writeAuditLog({ entityId: entity.id })│ ← 后置，best-effort
│  4. return entity                        │
└──────────────────────────────────────────┘
```

**核心原则**：
- **状态事务不包含 auditLog**：避免 entityId 回补
- **审计后置、best-effort**：写入失败记录 error 日志，不抛异常、不回滚
- **统一入口**：`auditLog.ts` 的 `writeAuditLog()` 是唯一写入点

### 2.2 payload 规范化

所有审计日志 `data` 字段统一为：
```ts
{
  summary: string;           // 人类可读的一句话摘要，前端直接展示
  details: Record<string, unknown>;  // 结构化详情，支持 replay/verify
  version: 1;                // schema 版本号
}
```

### 2.3 模块结构

```
backend/src/lib/
  auditLog.ts    ← NEW: writeAuditLog() 统一写入
  events.ts      ← 重构: 移除事务内 auditLog.create/updateMany
  ...
```

---

## 3. Action 标签完整清单

| Action | 中文标签 | entityType |
|--------|---------|------------|
| USER_REGISTERED | 用户注册 | User |
| TOPIC_CREATED | 创建议题 | Topic |
| TOPIC_ARCHIVED | 归档议题 | Topic |
| TOPIC_REOPENED | 重开议题 | Topic |
| MESSAGE_CREATED | 发布消息 | Message |
| RELATION_CREATED | 建立关系 | Relation |
| RELATION_SUPERSEDED | 替换关系 | Relation |
| RELATION_TARGETS_UPDATED | 更新关系目标 | Relation |
| STAKE_PLACED | 押注 | Stake |
| ROUND_CREATED | 发起结算 | SettlementRound |
| VOTE_CAST | 投票 | VoteStake |
| ROUND_SETTLED | 结算完成 | SettlementRound |
| SETTLEMENT_CLAWBACK | 结算回滚 | SettlementRound |
| POINT_MINTED | 贡献点铸造 | PointTransaction |
| POINT_TRANSFERRED | 贡献点转移 | PointTransaction |

---

## 4. API 增强

`GET /api/audit-logs` 新增过滤参数：

| 参数 | 类型 | 说明 |
|------|------|------|
| `topicId` | string | 按议题过滤（已有） |
| `action` | string | 按操作类型过滤 |
| `actorId` | string | 按操作者过滤 |
| `entityType` | string | 按实体类型过滤 |
| `entityId` | string | 按实体 ID 过滤 |

---

## 5. 数据库索引

```prisma
@@index([topicId, createdAt])
@@index([actorId, createdAt])
@@index([action, createdAt])
```
