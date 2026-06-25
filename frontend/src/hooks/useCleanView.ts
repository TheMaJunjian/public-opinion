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
  stakeCounts: Record<string, { pro: number; con: number }>;
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
    stakeCounts: Record<string, { pro: number; con: number }>;
    edges: DemoEdge[];
    roundCounts: Record<string, number>;
    participantCounts: Record<string, number>;
  },
): boolean {
  switch (rule.kind) {
    case 'sender': {
      const msg = ctx.msgMap.get(msgId);
      return msg?.author === rule.username;
    }
    case 'stake': {
      const sc = ctx.stakeCounts[msgId];
      if (rule.side === 'PRO') return (sc?.pro ?? 0) >= rule.minAmount;
      if (rule.side === 'CON') return (sc?.con ?? 0) >= rule.minAmount;
      return ((sc?.pro ?? 0) + (sc?.con ?? 0)) >= rule.minAmount;
    }
    case 'rounds': {
      return (ctx.roundCounts[msgId] ?? 0) >= rule.minRounds;
    }
    case 'participants': {
      return (ctx.participantCounts[msgId] ?? 0) >= rule.minCount;
    }
    case 'tag': {
      // tag 规则：统计对该消息的特定类型关系消息数量
      const tagType = rule.tagType.toUpperCase();
      const count = ctx.edges.filter(
        e => e.relationType.toUpperCase() === tagType && e.to.messageId === msgId,
      ).length;
      return count >= rule.minCount;
    }
    default:
      return true;
  }
}

export function useCleanView({ messages, edges, stakeCounts }: UseCleanViewInput): UseCleanViewOutput {
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

    const ctx = { msgMap, stakeCounts, edges, roundCounts, participantCounts };

    // Step 1: 找出通过所有规则的内容消息
    const visibleTextIds = new Set<string>();
    for (const m of messages) {
      if (!isContentKind(m.kind)) continue;
      const passes = cleanFilters.every(rule => rulePassesMessage(rule, m.id, ctx));
      if (passes) visibleTextIds.add(m.id);
    }

    // Step 2: 纳入两端文本都可见的关系消息
    const visibleRelIds = new Set<string>();
    for (const e of edges) {
      const fromOk = e.from.messageId.startsWith('anon:') || visibleTextIds.has(e.from.messageId);
      const toOk = visibleTextIds.has(e.to.messageId);
      if (fromOk && toOk) {
        visibleRelIds.add(e.relationMessageId);
      }
    }

    return { visibleTextIds, visibleRelIds };
  }, [cleanMode, cleanFilters, messages, edges, msgMap, stakeCounts, roundCounts, participantCounts]);

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
