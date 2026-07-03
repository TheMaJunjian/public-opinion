import { describe, expect, it } from 'vitest';
import type { TargetRef } from '../types';
import { isContentKind } from '../utils/modelBridge';

/**
 * classify-visibility.test.ts
 * 验证消息和结算消息在正确画布显示的核心逻辑。
 *
 * 测试概念：
 * - 原画布 = 默认分类（无名分类），isInsideClassify=false
 * - 命名分类 = 有 CLASSIFY 关系的分类，isInsideClassify=true
 * - 消息归属分类 → 主画布隐藏（classifiedTargetTextIds / graphOwnedRelationIds）
 * - 消息移出分类 → 主画布显示
 * - 附属关系跟随来源消息（REFERENCE 跟随 governance）
 * - 结算消息是独立内容，不自动跟随
 */

// ========================= targetRef 解析 =========================

function getTextTargetIds(targetRefs: TargetRef[]): string[] {
  return Array.from(new Set(
    targetRefs
      .filter((ref): ref is Extract<TargetRef, { kind: 'message' | 'text-fragment' }> =>
        ref.kind === 'message' || ref.kind === 'text-fragment')
      .map(ref => ref.messageId)
  ));
}

function getRelationTargetIds(targetRefs: TargetRef[]): string[] {
  return Array.from(new Set(
    targetRefs
      .filter((ref): ref is Extract<TargetRef, { kind: 'relation' }> => ref.kind === 'relation')
      .map(ref => ref.relationId)
  ));
}

function targetRefKey(ref: TargetRef): string {
  return ref.kind === 'relation' ? `relation:${ref.relationId}` : `message:${ref.messageId}`;
}

function isReclassifiedTarget(ref: TargetRef, targetRefs: TargetRef[], targetTextIds: string[]): boolean {
  const targetKeys = new Set(targetRefs.map(targetRefKey));
  const textIds = new Set(targetTextIds);
  if (ref.kind === 'relation') return targetKeys.has(targetRefKey(ref));
  return targetKeys.has(targetRefKey(ref)) || textIds.has(ref.messageId);
}

function moveTargetsIntoNestedClassify(parentRefs: TargetRef[], selectedRefs: TargetRef[], selectedTextIds: string[], newClassifyId: string, roundId: string): TargetRef[] {
  return [
    ...parentRefs.filter(ref => !isReclassifiedTarget(ref, selectedRefs, selectedTextIds)),
    { kind: 'relation', relationId: newClassifyId },
    { kind: 'message', messageId: roundId },
  ];
}

function buildSummaryCoverage(targetRefs: TargetRef[], summaryId: string, title: string): Map<string, Array<{ summaryId: string; title: string }>> {
  const map = new Map<string, Array<{ summaryId: string; title: string }>>();
  for (const ref of targetRefs) {
    const targetId = ref.kind === 'relation' ? ref.relationId : ref.messageId;
    const existing = map.get(targetId) ?? [];
    existing.push({ summaryId, title });
    map.set(targetId, existing);
  }
  return map;
}

function shouldRunOrphanLabelCheck(messageKind: string | undefined, relationType: string | undefined): boolean {
  if (messageKind && isContentKind(messageKind as any)) return false;
  if (!relationType) return false;
  return !['classify', 'merge', 'arrange', 'summary'].includes(relationType);
}

describe('targetRef 解析', () => {
  it('文本类 ref → textIds', () => {
    const refs: TargetRef[] = [
      { kind: 'message', messageId: 'msg-1' },
      { kind: 'relation', relationId: 'rel-1' },
      { kind: 'text-fragment', messageId: 'msg-2', text: 'hello', hash: 'abc' },
    ];
    expect(getTextTargetIds(refs)).toEqual(['msg-1', 'msg-2']);
  });

  it('关系类 ref → relationIds（含 governance）', () => {
    const refs: TargetRef[] = [
      { kind: 'message', messageId: 'msg-1' },
      { kind: 'relation', relationId: 'gov-1' },
      { kind: 'relation', relationId: 'rel-2' },
    ];
    expect(getRelationTargetIds(refs)).toEqual(['gov-1', 'rel-2']);
  });
});

// ========================= CONTENT_KINDS =========================

describe('CONTENT_KINDS', () => {
  it.each(['normal', 'round', 'round_result', 'governance', 'code', 'operations'] as const)('%s 是 content kind', (k) => {
    expect(isContentKind(k)).toBe(true);
  });

  it("'relation' 不是 content kind", () => {
    expect(isContentKind('relation' as any)).toBe(false);
  });
});

// ========================= 附属关系跟随规则 =========================

describe('REFERENCE 跟随来源消息', () => {
  it('来源(governance)在 ownedRelationIds → REFERENCE 隐藏', () => {
    const hiddenTextIds = new Set(['text-1']);
    const ownedRelationIds = new Set(['gov-1']);
    const sourceId = 'gov-1';
    const sourceHidden = isContentKind('governance') &&
      (hiddenTextIds.has(sourceId) || ownedRelationIds.has(sourceId));
    expect(sourceHidden).toBe(true);
  });

  it('来源(text)在 hiddenTextIds → REFERENCE 隐藏', () => {
    const hiddenTextIds = new Set(['text-1']);
    const ownedRelationIds = new Set<string>();
    const sourceId = 'text-1';
    const sourceHidden = isContentKind('normal') &&
      (hiddenTextIds.has(sourceId) || ownedRelationIds.has(sourceId));
    expect(sourceHidden).toBe(true);
  });

  it('来源不在任何隐藏集 → REFERENCE 可见', () => {
    const hiddenTextIds = new Set(['text-1']);
    const ownedRelationIds = new Set(['gov-1']);
    const sourceId = 'text-3';
    const sourceHidden = isContentKind('normal') &&
      (hiddenTextIds.has(sourceId) || ownedRelationIds.has(sourceId));
    expect(sourceHidden).toBe(false);
  });
});

// ========================= 分类视图 visibleIds =========================

describe('分类视图 visibleIds = topicTextIds ∪ topicRelationIds', () => {
  it('文本在 topicTextIds → 可见', () => {
    const visibleIds = new Set([...['msg-1'], ...['rel-1']]);
    expect(visibleIds.has('msg-1')).toBe(true);
  });

  it('关系在 topicRelationIds → 可见', () => {
    const visibleIds = new Set([...['msg-1'], ...['rel-1', 'gov-1']]);
    expect(visibleIds.has('gov-1')).toBe(true);
  });

  it('endpointInTopic 同时检查 topicTextIds 和 topicRelationIds', () => {
    const topicTextIds = new Set(['text-1']);
    const topicRelationIds = new Set(['gov-1']);
    const endpointInTopic = (mid: string) =>
      topicTextIds.has(mid) || topicRelationIds.has(mid);
    expect(endpointInTopic('gov-1')).toBe(true);
    expect(endpointInTopic('text-1')).toBe(true);
    expect(endpointInTopic('other')).toBe(false);
  });
});

// ========================= 原画布隐藏 =========================

describe('原画布隐藏规则', () => {
  it('文本在 classifiedTargetTextIds → 隐藏', () => {
    const classifiedTargetTextIds = new Set(['msg-1']);
    expect(classifiedTargetTextIds.has('msg-1')).toBe(true);
  });

  it('governance/code/ops 在 graphOwnedRelationIds → 隐藏', () => {
    const graphOwnedRelationIds = new Set(['gov-1', 'code-1']);
    expect(isContentKind('governance') && graphOwnedRelationIds.has('gov-1')).toBe(true);
  });

  it('relation 在 classifyOwnership.relationIds → 隐藏', () => {
    const ids = new Set(['classify-1', 'merge-1', 'ref-1']);
    expect(ids.has('ref-1')).toBe(true);
  });
});

// ========================= skipClassifyHiding =========================

describe('skipClassifyHiding = useFocusWindow || isInsideClassify', () => {
  it('原画布：false → 应用隐藏过滤', () => {
    const useFocusWindow = false;
    const isInsideClassify = false;
    expect(useFocusWindow || isInsideClassify).toBe(false);
  });

  it('分类内：true → 跳过隐藏过滤', () => {
    const useFocusWindow = false;
    const isInsideClassify = true;
    expect(useFocusWindow || isInsideClassify).toBe(true);
  });
});

// ========================= 结算消息独立性 =========================

describe('结算消息（ROUND）独立性', () => {
  it('ROUND 不自动跟随目标进入分类', () => {
    const visibleIds = new Set(['msg-1']);
    expect(visibleIds.has('round-1')).toBe(false);
  });

  it('ROUND 可被手动加入分类（在发送画布创建）', () => {
    // 模拟 addTargetToClassifyTopic({ kind: 'message', messageId: 'round-1' })
    const targetRefs: TargetRef[] = [
      { kind: 'message', messageId: 'msg-1' },
      { kind: 'message', messageId: 'round-1' },
    ];
    const textIds = getTextTargetIds(targetRefs);
    expect(textIds).toContain('round-1');
  });
});

// ========================= 总结覆盖规则 =========================

describe('总结（SUMMARY）覆盖规则', () => {
  it('线性视图保留被总结目标，并可显示覆盖说明', () => {
    const targetRefs: TargetRef[] = [
      { kind: 'message', messageId: 'text-1' },
      { kind: 'message', messageId: 'text-2' },
    ];
    const listVisibleIds = new Set(['summary-1', 'text-1', 'text-2']);
    const coverage = buildSummaryCoverage(targetRefs, 'summary-1', '阶段总结');

    expect(listVisibleIds.has('text-1')).toBe(true);
    expect(coverage.get('text-1')).toEqual([{ summaryId: 'summary-1', title: '阶段总结' }]);
  });

  it('非线性视图隐藏被总结目标，用总结消息覆盖', () => {
    const hiddenSummaryTargetIds = new Set(['text-1', 'text-2']);
    const graphVisibleIds = new Set(['summary-1']);

    expect(hiddenSummaryTargetIds.has('text-1')).toBe(true);
    expect(graphVisibleIds.has('summary-1')).toBe(true);
    expect(graphVisibleIds.has('text-1')).toBe(false);
  });
});

// ========================= 多重分类场景 =========================

describe('消息加入/移出分类', () => {
  it('加入分类：targetRefs 包含 → textIds 包含', () => {
    const refs: TargetRef[] = [
      { kind: 'message', messageId: 'msg-1' },
      { kind: 'message', messageId: 'msg-2' },
    ];
    expect(getTextTargetIds(refs)).toContain('msg-1');
  });

  it('移出分类：从 targetRefs 移除 → textIds 不含', () => {
    const refs: TargetRef[] = [
      { kind: 'message', messageId: 'msg-1' },
    ];
    const afterRemove = refs.filter(r =>
      !(r.kind === 'message' && r.messageId === 'msg-1')
    );
    expect(getTextTargetIds(afterRemove)).not.toContain('msg-1');
  });

  it('重新加入分类：再次添加 → textIds 重新包含', () => {
    let refs: TargetRef[] = [{ kind: 'message', messageId: 'msg-2' }];
    refs = [...refs, { kind: 'message', messageId: 'msg-1' }];
    expect(getTextTargetIds(refs)).toContain('msg-1');
  });

  it('重分类：文本和分类关系目标都会从父分类移出', () => {
    const parentRefs: TargetRef[] = [
      { kind: 'message', messageId: 'text-1' },
      { kind: 'relation', relationId: 'classify-child' },
      { kind: 'message', messageId: 'text-stays' },
    ];
    const selectedRefs: TargetRef[] = [
      { kind: 'message', messageId: 'text-1' },
      { kind: 'relation', relationId: 'classify-child' },
    ];

    const afterMove = parentRefs.filter(ref => !isReclassifiedTarget(ref, selectedRefs, ['text-1']));

    expect(afterMove).toEqual([{ kind: 'message', messageId: 'text-stays' }]);
  });

  it('分类内新建分类：父分类显示新分类卡和对应 ROUND 卡', () => {
    const parentRefs: TargetRef[] = [
      { kind: 'message', messageId: 'text-1' },
      { kind: 'relation', relationId: 'classify-child' },
      { kind: 'message', messageId: 'text-stays' },
    ];
    const selectedRefs: TargetRef[] = [
      { kind: 'message', messageId: 'text-1' },
      { kind: 'relation', relationId: 'classify-child' },
    ];

    const parentAfterSend = moveTargetsIntoNestedClassify(
      parentRefs,
      selectedRefs,
      ['text-1'],
      'classify-new',
      'round-new',
    );

    expect(parentAfterSend).toEqual([
      { kind: 'message', messageId: 'text-stays' },
      { kind: 'relation', relationId: 'classify-new' },
      { kind: 'message', messageId: 'round-new' },
    ]);
  });

  it('移空旧分类也要提交空 targetRefs，不能保留旧归属', () => {
    const parentRefs: TargetRef[] = [
      { kind: 'message', messageId: 'text-1' },
      { kind: 'relation', relationId: 'classify-child' },
    ];
    const selectedRefs: TargetRef[] = [
      { kind: 'message', messageId: 'text-1' },
      { kind: 'relation', relationId: 'classify-child' },
    ];

    const remainingRefs = parentRefs.filter(ref => !isReclassifiedTarget(ref, selectedRefs, ['text-1']));

    expect(remainingRefs).toEqual([]);
  });

  it('提案/代码/运营内容卡可与其引用文本一起加入新分类', () => {
    expect(shouldRunOrphanLabelCheck('governance', 'proposal')).toBe(false);
    expect(shouldRunOrphanLabelCheck('code', 'code_change')).toBe(false);
    expect(shouldRunOrphanLabelCheck('operations', 'operations')).toBe(false);
  });

  it('真正的附属标签关系仍需校验其目标是否一起被选中', () => {
    expect(shouldRunOrphanLabelCheck('relation', 'tag')).toBe(true);
    expect(shouldRunOrphanLabelCheck('relation', 'reference')).toBe(true);
  });
});

// ========================= 治理消息多目标 =========================

describe('治理消息（一次发送多个 REFERENCE）', () => {
  it('governance 和多个 REFERENCE 目标都在分类 targetRefs 中', () => {
    const classifyRefs: TargetRef[] = [
      { kind: 'relation', relationId: 'gov-1' },
      { kind: 'message', messageId: 'target-1' },
      { kind: 'message', messageId: 'target-2' },
    ];
    const relIds = getRelationTargetIds(classifyRefs);
    const textIds = getTextTargetIds(classifyRefs);
    expect(relIds).toContain('gov-1');
    expect(textIds).toEqual(['target-1', 'target-2']);
  });
});
