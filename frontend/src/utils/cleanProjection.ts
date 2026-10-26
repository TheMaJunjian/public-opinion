import type { CleanFilterRule } from '../types';
import type { CleanVisibleIds } from '../hooks/useCleanView';
import type { DemoMessage, DemoEdge } from './modelBridge';
import { isCardMessage, isContentKind } from './modelBridge';
import { getPresentationSpec } from '../types';

/** 单条规则对单条消息的判定 */
function rulePassesMessage(
  rule: CleanFilterRule,
  msgId: string,
  ctx: {
    msgMap: Map<string, DemoMessage>;
    stakeCounts: Record<string, { truth: { pro: number; con: number }; value: { pro: number; con: number } }>;
    edges: DemoEdge[];
    roundCounts: Record<string, number>;
    participantCounts: Record<string, number>;
    tagCounts: Record<string, Record<string, number>>;
  },
): boolean {
  switch (rule.kind) {
    case 'sender': {
      const msg = ctx.msgMap.get(msgId);
      return msg?.author === rule.username;
    }
    case 'stake': {
      const sc = ctx.stakeCounts[msgId];
      const totalPro = (sc?.truth.pro ?? 0) + (sc?.value.pro ?? 0);
      const totalCon = (sc?.truth.con ?? 0) + (sc?.value.con ?? 0);
      if (rule.side === 'PRO') return totalPro >= rule.minAmount;
      if (rule.side === 'CON') return totalCon >= rule.minAmount;
      return (totalPro + totalCon) >= rule.minAmount;
    }
    case 'rounds': {
      return (ctx.roundCounts[msgId] ?? 0) >= rule.minRounds;
    }
    case 'participants': {
      return (ctx.participantCounts[msgId] ?? 0) >= rule.minCount;
    }
    case 'tag': {
      // 按 subType 统计标签数量（RECOMMEND/ARCHIVE/TAG 的 subType）
      const tagType = rule.tagType.toUpperCase();
      const msgTagCounts = ctx.tagCounts[msgId];
      if (!msgTagCounts) return false;
      const count = msgTagCounts[tagType] ?? msgTagCounts[tagType.toLowerCase()] ?? 0;
      return count >= rule.minCount;
    }
    case 'relationType': {
      // relationType 规则：消息内容类型匹配指定的关系类型
      // 从 edges 中查找该消息作为 source 或 target 的关系，匹配 relationType
      const targetType = rule.relationType.toUpperCase();
      const msg = ctx.msgMap.get(msgId);
      if(msg?.relationType?.toUpperCase()===targetType)return true;
      if (ctx.edges.some(
        e => e.relationType.toUpperCase() === targetType &&
          (e.relationMessageId === msgId || e.from.messageId === msgId || e.to.messageId === msgId),
      )) return true;

      // 治理/运营类消息（PROPOSAL / CODE_CHANGE / OPERATIONS）不产生自身类型的边，
      // 它们通过 REFERENCE 边连接目标，因此需直接检查消息的 kind
      if (msg) {
        if (targetType === 'PROPOSAL' && msg.kind === 'governance') return true;
        if (targetType === 'CODE_CHANGE' && msg.kind === 'code') return true;
        if (targetType === 'OPERATIONS' && msg.kind === 'operations') return true;
      }
      return false;
    }
    default:
      return true;
  }
}

export function deriveCleanVisibleIds({ messages, edges, stakeCounts, tagCounts }: {
  messages: DemoMessage[]; edges: DemoEdge[];
  stakeCounts: Record<string, { truth: { pro: number; con: number }; value: { pro: number; con: number } }>;
  tagCounts: Record<string, Record<string, number>>;
}, cleanFilters: CleanFilterRule[]): CleanVisibleIds | null {
  if (!cleanFilters.length) return null;
  // 预计算 msgMap（避免 useMemo 内重复 new Map）
  const msgMap = new Map(messages.map(m => [m.id, m]));

  // 预计算轮次计数：从 ROUND 消息的 settlementTargetId 统计
  const roundCounts = (() => {
    const counts: Record<string, number> = {};
    for (const m of messages) {
      if (m.kind === 'round' && m.settlementTargetId) {
        counts[m.settlementTargetId] = (counts[m.settlementTargetId] ?? 0) + 1;
      }
    }
    return counts;
  })();

  // 预计算站队人数：统计每条消息被 AGREE/DISAGREE 关系指向的次数
  const participantCounts = (() => {
    const counts: Record<string, number> = {};
    for (const e of edges) {
      const rt = e.relationType.toUpperCase();
      if (rt === 'AGREE' || rt === 'DISAGREE') {
        counts[e.to.messageId] = (counts[e.to.messageId] ?? 0) + 1;
      }
    }
    return counts;
  })();

  return (() => {

    const ctx = { msgMap, stakeCounts, edges, roundCounts, participantCounts, tagCounts };

    // Readable relation bodies and organization headers are filter candidates
    // too, including when a CORRECT edge targets the relation itself.
    const visibleTextIds = new Set<string>();
    const visibleRelIds = new Set<string>();
    for (const m of messages) {
      if (!isCardMessage(m)&&!getPresentationSpec(m.relationType??'').isContainer) continue;
      const passes = cleanFilters.every(rule => rulePassesMessage(rule, m.id, ctx));
      if (passes)(isContentKind(m.kind)?visibleTextIds:visibleRelIds).add(m.id);
    }

    // Step 2: 纳入端点都可见的关系消息。
    // 关系消息也可以引用另一条关系消息，不能只检查 visibleTextIds；
    // 用固定点迭代把 relation -> relation 的显示依赖闭包算出来。
    let changed = true;
    while (changed) {
      changed = false;
      for (const e of edges) {
        const endpointVisible = (messageId: string, allowAnonymous: boolean) =>
          (allowAnonymous && messageId.startsWith('anon:'))
          || visibleTextIds.has(messageId)
          || visibleRelIds.has(messageId);
        const fromOk = endpointVisible(e.from.messageId, true);
        const toOk = endpointVisible(e.to.messageId, false);
        if (fromOk && toOk && !visibleRelIds.has(e.relationMessageId)) {
          visibleRelIds.add(e.relationMessageId);
          changed = true;
        }
      }
    }

    return { visibleTextIds, visibleRelIds };
  })();

}
