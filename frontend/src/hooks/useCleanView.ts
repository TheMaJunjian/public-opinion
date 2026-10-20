// useCleanView.ts — 清爽视图过滤器 hook
// 提供可组合的多维过滤器规则，输出过滤后的消息/关系 ID 集合。
// 架构：与焦点模式同层级，都是"同一批消息的不同投影"，不改变消息模型。

import { useMemo, useState, useCallback } from 'react';
import type { CleanFilterRule } from '../types';
import type { DemoMessage, DemoEdge } from '../utils/modelBridge';
import { deriveCleanVisibleIds } from '../utils/cleanProjection';

interface UseCleanViewInput {
  defer?: boolean;
  messages: DemoMessage[];
  edges: DemoEdge[];
  stakeCounts: Record<string, { truth: { pro: number; con: number }; value: { pro: number; con: number } }>;
  /** per-message tag counts: messageId → { SPAM: n, OFFTOPIC: n, ..., recommend: n, archive: n } */
  tagCounts: Record<string, Record<string, number>>;
}

export interface CleanVisibleIds {
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

export function useCleanView({ messages, edges, stakeCounts, tagCounts, defer = false }: UseCleanViewInput): UseCleanViewOutput {
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

  const cleanVisibleIds = useMemo(() => defer ? null : deriveCleanVisibleIds(
    { messages, edges, stakeCounts, tagCounts }, cleanFilters), [defer, cleanFilters, messages, edges, stakeCounts, tagCounts]);

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
