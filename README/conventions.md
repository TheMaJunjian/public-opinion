# 公论工程约定

> 每次工作前先读本文档。

## 1. 日志诊断

### 原则
- 遇到无法通过代码审查定位的运行时问题，**不要猜测**，用日志定位
- 解决问题原因，不是解决问题现象
- 前后端统一输出到 `README/logs/` 目录（前端通过 `debugLog` → `POST /api/debug-log` → 后端写文件）
- **只输出与当前问题直接相关的日志**，无关的不要输出
- **问题解决后清理诊断日志**，不保留临时调试代码

### 方法
| 场景 | 方式 |
|------|------|
| 前端诊断 | `debugLog('tag', 'msg')` — 同时 console + 写入 `README/logs/` |
| 前端异常 | `debugWarn('tag', 'msg')` — catch 块中记录失败详情 |
| 后端诊断 | `log('Tag', 'msg')` 或 `debugLog('Tag', 'msg')` |

### 日志格式
```
[模块] 操作描述 关键参数
```
例如：`[join] createJoinRelationsForContainer called containerId=abc123 type=CLASSIFY targets=xyz,def`

## 2. 代码修改原则

- 先理解全貌再动手
- 多文件修改用 `multi_replace_string_in_file` 一次性完成
- 每次修改后跑 `npm run build && npm test` 验证
- 修改前检查是否有 3 处以上的重复逻辑需要同步更新（如错误消息格式）

## 3. 测试验证基线

```bash
cd frontend && npm run build   # 必须通过
cd frontend && npm test         # 10 文件 / 279 测试
cd backend && npm run build     # 必须通过
cd backend && npm test          # 8 套件 / 139 测试
```

## 4. 项目关键概念

- 所有容器类型（CLASSIFY/SUMMARY/ARRANGE/MERGE）的 join 关系用统一的 `createJoinRelationsForContainer` 创建
- 容器嵌套：容器 A 加入容器 B，只创建 A→B 的 join，不展开 A 的子消息
- `totalConsumption`：发送前计算总消耗（文本 + 关系 + join + 引用 + 燃烧）
- `scrollMsgToCenter` 依赖 DOM 上的 `data-msgid` 属性定位消息卡片
- 框架元素（排列/归并/分类的 SVG rect）之前没有 `data-msgid`，已修复

## 5. 消息类型速查

| kind | 含义 | 渲染 |
|------|------|------|
| normal | 文本消息/加入容器记录 | 普通卡片 |
| relation | 关系消息/容器 | 主题卡片或框架 |
| round | 结算轮次 | 特殊卡片 |
| round_result | 结算结果 | 特殊卡片 |
| governance | 治理提案 | 黄色卡片 |
| code | 代码变更 | 青色卡片 |
| operations | 运营公告 | 青色卡片 |

## 6. 消息创建触发原则

- 所有消息统一由前端用户动作显式触发（点击发送/结算等按钮）
- 允许一次前端动作按顺序创建多条消息（例如：先结算，再创建结算结果消息）
- 后端不主动“隐式补发”消息；后端负责校验、记账和状态变更
- 消息类型不影响触发原则：`normal/relation/round/round_result/governance/code/operations` 均遵循同一规则
