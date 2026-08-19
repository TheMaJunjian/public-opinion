// useCleanView.ts — 清爽视图过滤器 hook
// 提供可组合的多维过滤器规则，输出过滤后的消息/关系 ID 集合。
// 架构：与焦点模式同层级，都是"同一批消息的不同投影"，不改变消息模型。

import { useMemo, useState, useCallback } from 'react';
import type { CleanFilterRule } from '../types';
import type { DemoMessage, DemoEdge } from '../utils/modelBridge';
import { isContentKind } from '../utils/modelBridge';

interface UseCleanViewInput {
  messages: DemoMessage[];
  edges: DemoEdge[];
  stakeCounts: Record<string, { truth: { pro: number; con: number }; value: { pro: number; con: number } }>;
  /** per-message tag counts: messageId → { SPAM: n, OFFTOPIC: n, ..., recommend: n, archive: n } */
  tagCounts: Record<string, Record<string, number>>;
}

interface CleanVisibleIds {
  /** 通过过滤器的文本消息 ID */
  visibleTextIds: Set<string>;
  /** 两端文本消息都可见时，纳入的关系消息 ID */
  visibleRelIds: Set<string>;
}

interface UseCleanViewOutput {
  /** 是否处于清爽模式 */
  cleanMode: boolean;
  /** 当前激活的过滤规则列表 */
  cleanFilters: CleanFilterRule[];
  /** 添加一条过滤规则 */
  addFilter: (rule: CleanFilterRule) => void;
  /** 移除一条过滤规则 */
  removeFilter: (ruleId: string) => void;
  /** 更新一条过滤规则 */
  updateFilter: (ruleId: string, updater: (rule: CleanFilterRule) => CleanFilterRule) => void;
  /** 清空所有规则 */
  clearFilters: () => void;
  /** 过滤后的可见 ID 集合，null 表示不过滤（清爽模式未激活） */
  cleanVisibleIds: CleanVisibleIds | null;
}

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
      if (ctx.edges.some(
        e => e.relationType.toUpperCase() === targetType &&
          (e.from.messageId === msgId || e.to.messageId === msgId),
      )) return true;

      // 治理/运营类消息（PROPOSAL / CODE_CHANGE / OPERATIONS）不产生自身类型的边，
      // 它们通过 REFERENCE 边连接目标，因此需直接检查消息的 kind
      const msg = ctx.msgMap.get(msgId);
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

export function useCleanView({ messages, edges, stakeCounts, tagCounts }: UseCleanViewInput): UseCleanViewOutput {
  const [cleanFilters, setCleanFilters] = useState<CleanFilterRule[]>([]);

  const addFilter = useCallback((rule: CleanFilterRule) => {
    setCleanFilters(prev => [...prev, rule]);
  }, []);

  const removeFilter = useCallback((ruleId: string) => {
    setCleanFilters(prev => prev.filter(r => r.id !== ruleId));
  }, []);

  const updateFilter = useCallback(
    (ruleId: string, updater: (rule: CleanFilterRule) => CleanFilterRule) => {
      setCleanFilters(prev => prev.map(r => (r.id === ruleId ? updater(r) : r)));
    },
    [],
  );

  const clearFilters = useCallback(() => {
    setCleanFilters([]);
  }, []);

  const cleanMode = cleanFilters.length > 0;

  // 预计算 msgMap（避免 useMemo 内重复 new Map）
  const msgMap = useMemo(() => new Map(messages.map(m => [m.id, m])), [messages]);

  // 预计算轮次计数：从 ROUND 消息的 settlementTargetId 统计
  const roundCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const m of messages) {
      if (m.kind === 'round' && m.settlementTargetId) {
        counts[m.settlementTargetId] = (counts[m.settlementTargetId] ?? 0) + 1;
      }
    }
    return counts;
  }, [messages]);

  // 预计算站队人数：统计每条消息被 AGREE/DISAGREE 关系指向的次数
  const participantCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const e of edges) {
      const rt = e.relationType.toUpperCase();
      if (rt === 'AGREE' || rt === 'DISAGREE') {
        counts[e.to.messageId] = (counts[e.to.messageId] ?? 0) + 1;
      }
    }
    return counts;
  }, [edges]);

  const cleanVisibleIds = useMemo((): CleanVisibleIds | null => {
    if (!cleanMode) return null;

    const ctx = { msgMap, stakeCounts, edges, roundCounts, participantCounts, tagCounts };

    // Step 1: 找出通过所有规则的内容消息
    const visibleTextIds = new Set<string>();
    for (const m of messages) {
      if (!isContentKind(m.kind)) continue;
      const passes = cleanFilters.every(rule => rulePassesMessage(rule, m.id, ctx));
      if (passes) visibleTextIds.add(m.id);
    }

    // Step 2: 纳入端点都可见的关系消息。
    // 关系消息也可以引用另一条关系消息，不能只检查 visibleTextIds；
    // 用固定点迭代把 relation -> relation 的显示依赖闭包算出来。
    const visibleRelIds = new Set<string>();
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
  }, [cleanMode, cleanFilters, messages, edges, msgMap, stakeCounts, roundCounts, participantCounts, tagCounts]);

  return {
    cleanMode,
    cleanFilters,
    addFilter,
    removeFilter,
    updateFilter,
    clearFilters,
    cleanVisibleIds,
  };
}
