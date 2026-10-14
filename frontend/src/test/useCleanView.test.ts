// useCleanView.test.ts — 清爽视图过滤器 hook 单元测试
import { describe, it, expect } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useCleanView } from '../hooks/useCleanView';
import type { DemoMessage, DemoEdge } from '../utils/modelBridge';

// ── 测试数据工厂 ──

function makeTextMsg(id: string, author: string, overrides?: Partial<DemoMessage>): DemoMessage {
  return {
    id,
    author,
    kind: 'normal',
    content: `消息 ${id} 的内容`,
    createdAt: '2026-06-25T00:00:00Z',
    ...overrides,
  };
}

function makeRoundMsg(id: string, settlementTargetId: string): DemoMessage {
  return {
    id,
    author: 'system',
    kind: 'round',
    content: '',
    createdAt: '2026-06-25T00:00:00Z',
    settlementTargetId,
  };
}

function makeEdge(
  id: string,
  relMsgId: string,
  relType: string,
  fromMsgId: string,
  toMsgId: string,
): DemoEdge {
  return {
    id,
    relationMessageId: relMsgId,
    relationType: relType as any,
    from: { messageId: fromMsgId, selection: { kind: 'whole' } },
    to: { messageId: toMsgId, selection: { kind: 'whole' } },
    relationLabel: relType,
  };
}

// ── 测试 ──

describe('useCleanView', () => {
  it('cleanMode is false when no filters active', () => {
    const { result } = renderHook(() =>
      useCleanView({ messages: [], edges: [], stakeCounts: {}, tagCounts: {} }),
    );
    expect(result.current.cleanMode).toBe(false);
    expect(result.current.cleanVisibleIds).toBeNull();
  });

  it('cleanMode becomes true when a filter is added', () => {
    const { result } = renderHook(() =>
      useCleanView({ messages: [], edges: [], stakeCounts: {}, tagCounts: {} }),
    );
    act(() => {
      result.current.addFilter({ id: 'f1', kind: 'sender', username: '张三' });
    });
    expect(result.current.cleanMode).toBe(true);
    expect(result.current.cleanFilters).toHaveLength(1);
    expect(result.current.cleanVisibleIds).not.toBeNull();
  });

  it('removeFilter removes a rule', () => {
    const { result } = renderHook(() =>
      useCleanView({ messages: [], edges: [], stakeCounts: {}, tagCounts: {} }),
    );
    act(() => { result.current.addFilter({ id: 'f1', kind: 'sender', username: '张三' }); });
    act(() => { result.current.removeFilter('f1'); });
    expect(result.current.cleanMode).toBe(false);
    expect(result.current.cleanFilters).toHaveLength(0);
  });

  it('clearFilters removes all rules', () => {
    const { result } = renderHook(() =>
      useCleanView({ messages: [], edges: [], stakeCounts: {}, tagCounts: {} }),
    );
    act(() => { result.current.addFilter({ id: 'f1', kind: 'sender', username: '张三' }); });
    act(() => { result.current.addFilter({ id: 'f2', kind: 'stake', minAmount: 50 }); });
    act(() => { result.current.clearFilters(); });
    expect(result.current.cleanMode).toBe(false);
  });

  // ── sender 规则 ──

  it('sender filter: only shows messages from specified user', () => {
    const messages: DemoMessage[] = [
      makeTextMsg('m1', '张三'),
      makeTextMsg('m2', '李四'),
      makeTextMsg('m3', '张三'),
    ];
    const stakeCounts = {
      m1: { truth: { pro: 0, con: 0 }, value: { pro: 0, con: 0 } },
      m2: { truth: { pro: 0, con: 0 }, value: { pro: 0, con: 0 } },
      m3: { truth: { pro: 0, con: 0 }, value: { pro: 0, con: 0 } },
    };
    const { result } = renderHook(() =>
      useCleanView({ messages, edges: [], stakeCounts, tagCounts: {} }),
    );
    act(() => {
      result.current.addFilter({ id: 'f1', kind: 'sender', username: '张三' });
    });
    expect(result.current.cleanVisibleIds!.visibleTextIds.has('m1')).toBe(true);
    expect(result.current.cleanVisibleIds!.visibleTextIds.has('m2')).toBe(false);
    expect(result.current.cleanVisibleIds!.visibleTextIds.has('m3')).toBe(true);
  });

  // ── stake 规则 ──

  it('stake filter: hides messages below threshold', () => {
    const messages: DemoMessage[] = [
      makeTextMsg('m1', 'A'),
      makeTextMsg('m2', 'B'),
    ];
    const stakeCounts = {
      m1: { truth: { pro: 100, con: 20 }, value: { pro: 0, con: 0 } },
      m2: { truth: { pro: 5, con: 3 }, value: { pro: 0, con: 0 } },
    };
    const { result } = renderHook(() =>
      useCleanView({ messages, edges: [], stakeCounts, tagCounts: {} }),
    );
    act(() => {
      result.current.addFilter({ id: 'f2', kind: 'stake', minAmount: 50 });
    });
    expect(result.current.cleanVisibleIds!.visibleTextIds.has('m1')).toBe(true);
    expect(result.current.cleanVisibleIds!.visibleTextIds.has('m2')).toBe(false);
  });

  it('stake filter with side: only checks specified side', () => {
    const messages: DemoMessage[] = [makeTextMsg('m1', 'A')];
    const stakeCounts = { m1: { truth: { pro: 10, con: 100 }, value: { pro: 0, con: 0 } } };
    const { result } = renderHook(() =>
      useCleanView({ messages, edges: [], stakeCounts, tagCounts: {} }),
    );
    act(() => {
      result.current.addFilter({ id: 'f3', kind: 'stake', minAmount: 50, side: 'PRO' });
    });
    // PRO=10 < 50, should NOT pass
    expect(result.current.cleanVisibleIds!.visibleTextIds.has('m1')).toBe(false);
  });

  // ── participants 规则 ──

  it('participants filter: counts agree/disagree edges', () => {
    const messages: DemoMessage[] = [
      makeTextMsg('m1', 'A'),
      makeTextMsg('m2', 'B'),
    ];
    const edges: DemoEdge[] = [
      makeEdge('e1', 'r1', 'agree', 'anon:1', 'm1'),
      makeEdge('e2', 'r2', 'disagree', 'anon:2', 'm1'),
      makeEdge('e3', 'r3', 'agree', 'anon:3', 'm1'),
      // m2 has only 1 participant
      makeEdge('e4', 'r4', 'agree', 'anon:4', 'm2'),
    ];
    const { result } = renderHook(() =>
      useCleanView({ messages, edges, stakeCounts: {}, tagCounts: {} }),
    );
    act(() => {
      result.current.addFilter({ id: 'f4', kind: 'participants', minCount: 3 });
    });
    expect(result.current.cleanVisibleIds!.visibleTextIds.has('m1')).toBe(true);
    expect(result.current.cleanVisibleIds!.visibleTextIds.has('m2')).toBe(false);
  });

  // ── rounds 规则 ──

  it('rounds filter: counts ROUND messages targeting the text message', () => {
    const messages: DemoMessage[] = [
      makeTextMsg('m1', 'A'),
      makeTextMsg('m2', 'B'),
      makeRoundMsg('r1', 'm1'),
      makeRoundMsg('r2', 'm1'),
      makeRoundMsg('r3', 'm1'),
      // m2 has only 1 round
      makeRoundMsg('r4', 'm2'),
    ];
    const { result } = renderHook(() =>
      useCleanView({ messages, edges: [], stakeCounts: {}, tagCounts: {} }),
    );
    act(() => {
      result.current.addFilter({ id: 'f5', kind: 'rounds', minRounds: 2 });
    });
    expect(result.current.cleanVisibleIds!.visibleTextIds.has('m1')).toBe(true);
    expect(result.current.cleanVisibleIds!.visibleTextIds.has('m2')).toBe(false);
  });

  // ── tag 规则 ──

  it('tag filter: counts tags by tagCounts', () => {
    const messages: DemoMessage[] = [
      makeTextMsg('m1', 'A'),
      makeTextMsg('m2', 'B'),
    ];
    const tagCounts = {
      m1: { archive: 5 },
      m2: { archive: 2 },
    };
    const { result } = renderHook(() =>
      useCleanView({ messages, edges: [], stakeCounts: {}, tagCounts }),
    );
    act(() => {
      result.current.addFilter({ id: 'f6', kind: 'tag', tagType: 'ARCHIVE', minCount: 5 });
    });
    expect(result.current.cleanVisibleIds!.visibleTextIds.has('m1')).toBe(true);
    expect(result.current.cleanVisibleIds!.visibleTextIds.has('m2')).toBe(false);
  });

  // ── 多规则组合 ──

  it('multiple filters: AND logic', () => {
    const messages: DemoMessage[] = [
      makeTextMsg('m1', '张三'),  // 张三 + enough stake → passes
      makeTextMsg('m2', '张三'),  // 张三 + low stake → fails
      makeTextMsg('m3', '李四'),  // 李四 + enough stake → fails (wrong author)
    ];
    const stakeCounts = {
      m1: { truth: { pro: 100, con: 0 }, value: { pro: 0, con: 0 } },
      m2: { truth: { pro: 5, con: 0 }, value: { pro: 0, con: 0 } },
      m3: { truth: { pro: 100, con: 0 }, value: { pro: 0, con: 0 } },
    };
    const { result } = renderHook(() =>
      useCleanView({ messages, edges: [], stakeCounts, tagCounts: {} }),
    );
    act(() => {
      result.current.addFilter({ id: 'fA', kind: 'sender', username: '张三' });
      result.current.addFilter({ id: 'fB', kind: 'stake', minAmount: 50 });
    });
    expect(result.current.cleanVisibleIds!.visibleTextIds.has('m1')).toBe(true);
    expect(result.current.cleanVisibleIds!.visibleTextIds.has('m2')).toBe(false);
    expect(result.current.cleanVisibleIds!.visibleTextIds.has('m3')).toBe(false);
  });

  // ── 关系消息纳入 ──

  it('includes relation messages when both endpoints are visible', () => {
    const messages: DemoMessage[] = [
      makeTextMsg('m1', '张三'),
      makeTextMsg('m2', '张三'),
    ];
    const edges: DemoEdge[] = [
      makeEdge('e1', 'rel-1', 'reference', 'm1', 'm2'),
    ];
    const { result } = renderHook(() =>
      useCleanView({ messages, edges, stakeCounts: {}, tagCounts: {} }),
    );
    act(() => {
      result.current.addFilter({ id: 'f1', kind: 'sender', username: '张三' });
    });
    // Both m1 and m2 pass → the relation between them should be included
    expect(result.current.cleanVisibleIds!.visibleRelIds.has('rel-1')).toBe(true);
  });

  it('excludes relation messages when an endpoint is not visible', () => {
    const messages: DemoMessage[] = [
      makeTextMsg('m1', '张三'),
      makeTextMsg('m2', '李四'),
    ];
    const edges: DemoEdge[] = [
      makeEdge('e1', 'rel-1', 'reference', 'm1', 'm2'),
    ];
    const { result } = renderHook(() =>
      useCleanView({ messages, edges, stakeCounts: {}, tagCounts: {} }),
    );
    act(() => {
      result.current.addFilter({ id: 'f1', kind: 'sender', username: '张三' });
    });
    // m1 passes but m2 doesn't → relation should NOT be included
    expect(result.current.cleanVisibleIds!.visibleRelIds.has('rel-1')).toBe(false);
  });
});
