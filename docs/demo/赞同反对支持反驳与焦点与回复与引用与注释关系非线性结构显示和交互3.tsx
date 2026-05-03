/**
 * 赞同反对支持反驳与焦点与回复与引用与注释关系非线性结构显示和交互3.tsx
 *
 * ⚠️  参考实现归档 — 非生产架构
 *
 * 这是用户提供的原始 demo 单文件，作为功能与界面的黄金参考，
 * 已归档至此供开发对照。实际生产代码请参考：
 *   - frontend/src/components/GraphView.tsx      (非线性图视图)
 *   - frontend/src/components/DraftPanel.tsx     (候选区/来源/目标/操作面板)
 *   - frontend/src/components/InteractiveMessageList.tsx (线性/树视图交互)
 *   - frontend/src/pages/TopicDetailPage.tsx     (顶层整合页)
 *
 * demo 原始文件说明：
 * - 单文件 React TSX，无外部依赖（自包含所有类型与逻辑）
 * - 展示了：赞同/反对/支持/反驳/回复/引用/注释关系的非线性结构渲染
 * - 核心交互：焦点模式、候选区批量流转、文本片段选择
 * - 边渲染：贝塞尔曲线 + 箭头 + 标签，源在左，目标在右
 *
 * 架构局限（不适合直接用于生产）：
 * - 所有关系类型逻辑硬编码（无法通过配置扩展）
 * - 没有前后端分离，数据写死在组件内
 * - 没有分页、懒加载
 * - 没有持久化与 API 集成
 *
 * 以下为 demo 的关键界面与交互规则（供对照）：
 */

// ─── 消息布局规则 ──────────────────────────────────────────────────────────────
//
// 列布局算法：
//   source 消息（发出关系的消息）放左侧（低列号）
//   target 消息（被关系指向的消息）放右侧（高列号）
//   约束：col(target) >= col(source) + 1
//
// 常量：
//   CARD_W = 220, CARD_H = 110
//   COL_GAP = 80, ROW_GAP = 28, PAD = 40

// ─── 边渲染规则 ────────────────────────────────────────────────────────────────
//
// 三次贝塞尔曲线：
//   起点：source 卡片右中心  (x1 = source.x + CARD_W, y1 = source.y + CARD_H/2)
//   终点：target 卡片左中心  (x2 = target.x,          y2 = target.y + CARD_H/2)
//   控制点：
//     cpx1 = x1 + dx * 0.45, cpy1 = y1
//     cpx2 = x2 - dx * 0.45, cpy2 = y2
//   箭头 marker 置于终点，指向 target
//
// 支持的边类型（来自关系类型）：
//   ANNOTATION (注释)  - edge-label,      蓝色
//   REFERENCE  (引用)  - edge-label,      靛蓝
//   REPLY      (回复)  - edge-label,      蓝色, formsTrees
//   SUPPLEMENT (补充)  - edge-label,      紫色, formsTrees
//   SUPPORT    (支持)  - edge-decoration, 绿色, formsTrees, stanceEffect=support
//   REBUT      (反驳)  - edge-decoration, 红色, formsTrees, stanceEffect=oppose
//   AGREE      (赞同)  - decoration,      绿色, stanceEffect=support
//   DISAGREE   (反对)  - decoration,      红色, stanceEffect=oppose
//   CORRECT    (更正)  - replace-overlay, 黄色
//   CLASSIFY   (分类)  - frame-group,     灰色
//   MERGE      (归并)  - frame-group,     灰色
//   SUMMARY    (总结)  - replace-overlay, 琥珀
//   RECOMMEND  (推荐)  - inline-badge,    橙色
//   ARCHIVE    (冷藏)  - inline-badge,    石板

// ─── 候选区交互规则 ────────────────────────────────────────────────────────────
//
// 主交互方式（底部批量按钮）：
//   [加入来源集合]  — 候选区中全部整条文本消息 → sources
//   [加入目标集合]  — 候选区全部内容 → targets
//
// 次级辅助（分组头部快捷按钮，非主交互）：
//   每组 →来源  — 该组整条消息加入 sources
//   每组 →目标  — 该组所有条目加入 targets
//
// 候选区过期条目规则：
//   来源集合：只接受 type='message' 的整条消息
//   目标集合：接受 message / text-fragment / relation

// ─── 焦点模式规则 ──────────────────────────────────────────────────────────────
//
// hop 定义：两个文本消息之间经过的关系链数
// 焦点模式下仅显示焦点消息 ±N 跳以内的消息与关系
//
// 状态操作：
//   开启焦点模式：focusMode=true
//   选择焦点消息：focusMessageId = id
//   退出焦点：    focusMessageId = '' (保持 focusMode=true)
//   退出全部：    focusMode=false + focusMessageId=''
//
// 跳数范围：1-5（默认 2）

// ─── 四类操作流程 ──────────────────────────────────────────────────────────────
//
// A: 仅发送消息
//    需要：输入框有内容
//    结果：POST /messages，不建立关系
//
// B: 发送消息 + 建立关系（候选区作目标）
//    需要：输入框有内容 + 候选区非空
//    结果：POST /messages → POST /relations (source=新消息, targets=候选区)
//
// C: 发送消息 + 建立关系（Targets集合作目标）
//    需要：输入框有内容 + 目标集合非空
//    结果：POST /messages → POST /relations (source=新消息, targets=Targets集合)
//
// D: 仅建立关系（不发新消息）
//    需要：来源集合有整条消息 + 目标集合非空
//    结果：POST /relations (source=Sources[0], targets=Targets集合)

// ─── 关系类型扩展方式 ──────────────────────────────────────────────────────────
//
// 前端：在 frontend/src/types/index.ts 的 PRESENTATION_SPECS 中新增条目
// 后端：在 backend/src/lib/relationTypes.ts 的 RELATION_TYPES 数组中追加
// DB 无需迁移（relationType 字段为 TEXT 类型）

export {};
// 此文件为说明性归档，不包含可运行代码。
// 参考上方注释了解 demo 的核心规则，或查阅 docs/demo-understanding.md 获取完整文档。
