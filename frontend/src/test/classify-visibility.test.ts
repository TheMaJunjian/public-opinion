import { describe, expect, it } from 'vitest';
import type { TargetRef } from '../types';
import { isContentKind } from '../utils/modelBridge';
import { collectContainerVisibleIds, collectOwnedByRelation, expandTextIdsWithSettlementResults, filterContainerEdgesByEffectiveJoins, getActiveJoinRelationsForMessage, getAutoClassifyTargetForSettlementMessage, getEffectiveJoinRelationIds, getJoinRecoveryTargetIds, getJoinRelationsForMessage, getRejectedJoinRelationIds, getSettlementClassifyJoinTarget, getStaleJoinRelationIds, getUserPreferredJoinByTarget, isAppendToExistingClassifyAction, resolveNavigationTargetId } from '../pages/topicDetailHelpers';

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

  it('ROUND_RESULT 在当前分类上下文中应被自动挂载为分类目标', () => {
    const target = getAutoClassifyTargetForSettlementMessage({ id: 'settle-1', kind: 'round_result' });
    expect(target).toEqual({ kind: 'message', messageId: 'settle-1' });
  });

  it('分类通过 JOIN 关系拥有被加入的消息', () => {
    const relationById = new Map<string, any>([
      ['classify-1', { id: 'classify-1', relationType: 'CLASSIFY', targetRefs: [{ kind: 'message', messageId: 'msg-1' }] }],
      ['join-1', { id: 'join-1', relationType: 'JOIN', sourceMessageId: 'classify-1', targetRefs: [{ kind: 'message', messageId: 'msg-1' }] }],
    ]);
    const owned = collectOwnedByRelation('classify-1', relationById as any);
    expect(owned.textIds.has('msg-1')).toBe(true);
  });

  it('结算结果消息会生成用于加入分类的 join 目标', () => {
    expect(getSettlementClassifyJoinTarget({ id: 'settle-1', kind: 'round_result' } as any)).toEqual({ kind: 'message', messageId: 'settle-1' });
    expect(getSettlementClassifyJoinTarget({ id: 'round-1', kind: 'round' } as any)).toBeNull();
  });

  it('结算结果消息会继承目标消息所属分类', () => {
    const owned = new Set(['msg-1']);
    const expanded = expandTextIdsWithSettlementResults(owned, [
      { id: 'settle-1', kind: 'round_result', settlementTargetId: 'msg-1' } as any,
    ]);
    expect(expanded.has('settle-1')).toBe(true);
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

  it('加入分类的消息会生成可反对的加入记录', () => {
    const joinIds = getRejectedJoinRelationIds([
      { id: 'join-1', relationType: 'JOIN' } as any,
      { id: 'join-2', relationType: 'JOIN' } as any,
    ], {
      'join-1': { agreeCount: 0, disagreeCount: 2 },
      'join-2': { agreeCount: 1, disagreeCount: 0 },
    });
    expect(joinIds).toEqual(['join-1']);
  });

  it('被反对的加入记录不会再把消息挂到分类中', () => {
    const relations = [
      { id: 'join-1', relationType: 'JOIN', sourceMessageId: 'classify-1', targetRefs: [{ kind: 'message', messageId: 'msg-1' }] } as any,
    ];
    const rejectedJoinIds = new Set(['join-1']);
    const active = getActiveJoinRelationsForMessage('msg-1', relations, new Set(), rejectedJoinIds);
    expect(active).toEqual([]);
  });

  it('目标消息可查询全部加入记录，包含被反对的记录', () => {
    const relations = [
      { id: 'join-old', relationType: 'JOIN', sourceMessageId: 'classify-1', createdAt: '2026-01-01', targetRefs: [{ kind: 'message', messageId: 'msg-1' }] },
      { id: 'join-new', relationType: 'JOIN', sourceMessageId: 'summary-1', createdAt: '2026-01-02', targetRefs: [{ kind: 'message', messageId: 'msg-1' }] },
      { id: 'join-other', relationType: 'JOIN', sourceMessageId: 'classify-1', createdAt: '2026-01-03', targetRefs: [{ kind: 'message', messageId: 'msg-2' }] },
    ] as any;
    expect(getJoinRelationsForMessage('msg-1', relations).map(r => r.id)).toEqual(['join-new', 'join-old']);
  });

  it('重新分类后由最新 JOIN 决定消息布局', () => {
    const relations = [
      { id: 'classify-b', relationType: 'CLASSIFY', sourceMessageId: null, targetRefs: [] },
      { id: 'classify-c', relationType: 'CLASSIFY', sourceMessageId: null, targetRefs: [{ kind: 'message', messageId: 'msg-1' }] },
      { id: 'join-b-msg', relationType: 'JOIN', sourceMessageId: 'classify-b', createdAt: '2026-01-01', targetRefs: [{ kind: 'message', messageId: 'msg-1' }] },
      { id: 'join-c-msg', relationType: 'JOIN', sourceMessageId: 'classify-c', createdAt: '2026-01-02', targetRefs: [{ kind: 'message', messageId: 'msg-1' }] },
    ] as any;
    expect(getStaleJoinRelationIds(relations)).toEqual([]);
    expect(getActiveJoinRelationsForMessage('msg-1', relations, new Set(), new Set()).map(r => r.id)).toEqual(['join-c-msg']);
  });

  it('JOIN 不依赖来源容器的 targetRefs 才能生效', () => {
    const relations = [
      { id: 'classify-1', relationType: 'CLASSIFY', sourceMessageId: null, targetRefs: [] },
      { id: 'join-1', relationType: 'JOIN', sourceMessageId: 'classify-1', createdAt: '2026-01-01', targetRefs: [{ kind: 'message', messageId: 'msg-1' }] },
    ] as any;
    expect(getStaleJoinRelationIds(relations)).toEqual([]);
    expect(getActiveJoinRelationsForMessage('msg-1', relations, new Set(), new Set()).map(r => r.id)).toEqual(['join-1']);
  });

  it('重新分类后消息不再显示在旧分类中', () => {
    const relations = [
      { id: 'classify-old', relationType: 'CLASSIFY', sourceMessageId: null, targetRefs: [{ kind: 'message', messageId: 'msg-1' }] },
      { id: 'classify-new', relationType: 'CLASSIFY', sourceMessageId: null, targetRefs: [{ kind: 'message', messageId: 'msg-1' }] },
      { id: 'join-old', relationType: 'JOIN', sourceMessageId: 'classify-old', createdAt: '2026-01-01', targetRefs: [{ kind: 'message', messageId: 'msg-1' }] },
      { id: 'join-new', relationType: 'JOIN', sourceMessageId: 'classify-new', createdAt: '2026-01-02', targetRefs: [{ kind: 'message', messageId: 'msg-1' }] },
    ] as any;

    expect(collectContainerVisibleIds('classify-old', relations).textIds.has('msg-1')).toBe(false);
    expect(collectContainerVisibleIds('classify-new', relations).textIds.has('msg-1')).toBe(true);
    expect(collectOwnedByRelation('classify-old', new Map(relations.map((relation: any) => [relation.id, relation]))).textIds.has('msg-1')).toBe(false);
    expect(collectOwnedByRelation('classify-new', new Map(relations.map((relation: any) => [relation.id, relation]))).textIds.has('msg-1')).toBe(true);
  });

  it('最新 JOIN 被反对后回退到上一条有效 JOIN', () => {
    const relations = [
      { id: 'join-old', relationType: 'JOIN', sourceMessageId: 'classify-1', createdAt: '2026-01-01', targetRefs: [{ kind: 'message', messageId: 'msg-1' }] },
      { id: 'join-new', relationType: 'JOIN', sourceMessageId: 'classify-2', createdAt: '2026-01-02', targetRefs: [{ kind: 'message', messageId: 'msg-1' }] },
    ] as any;
    expect(getEffectiveJoinRelationIds(relations, new Set(), new Set(['join-new']))).toEqual(new Set(['join-old']));
  });

  it('当前与会者最新发送或赞同的 JOIN 决定个人布局归属', () => {
    const relations = [
      { id: 'join-b-msg', relationType: 'JOIN', sourceMessageId: 'classify-b', createdAt: '2026-01-01', createdBy: { username: 'alice' }, targetRefs: [{ kind: 'message', messageId: 'msg-1' }] },
      { id: 'join-c-msg', relationType: 'JOIN', sourceMessageId: 'classify-c', createdAt: '2026-01-02', createdBy: { username: 'bob' }, targetRefs: [{ kind: 'message', messageId: 'msg-1' }] },
      { id: 'agree-b-msg', relationType: 'AGREE', createdAt: '2026-01-03', createdBy: { username: 'alice' }, targetRefs: [{ kind: 'relation', relationId: 'join-b-msg' }] },
    ] as any;
    const preferred = getUserPreferredJoinByTarget(
      relations,
      new Map([['join-b-msg', { relMsgId: 'agree-b-msg', type: 'agree' as const }]]),
      'alice',
    );
    expect(getEffectiveJoinRelationIds(relations, new Set(), new Set(), preferred)).toEqual(new Set(['join-b-msg']));
    expect(getEffectiveJoinRelationIds(relations, new Set(), new Set())).toEqual(new Set(['join-c-msg']));
    const relationById = new Map([
      ['classify-b', { id: 'classify-b', relationType: 'CLASSIFY', sourceMessageId: null, targetRefs: [{ kind: 'message', messageId: 'msg-1' }] }],
      ['classify-c', { id: 'classify-c', relationType: 'CLASSIFY', sourceMessageId: null, targetRefs: [] }],
      ...relations.map((relation: any) => [relation.id, relation]),
    ]) as any;
    expect(collectOwnedByRelation('classify-b', relationById, new Set(), new Set(), new Set(), preferred).textIds.has('msg-1')).toBe(true);
    expect(collectOwnedByRelation('classify-c', relationById, new Set(), new Set(), new Set(), preferred).textIds.has('msg-1')).toBe(false);
  });

  it('个人偏好的 JOIN 被反对后不能继续决定布局', () => {
    const relations = [
      { id: 'classify-1', relationType: 'CLASSIFY', sourceMessageId: null, targetRefs: [] },
      { id: 'join-1', relationType: 'JOIN', sourceMessageId: 'classify-1', createdAt: '2026-01-01', createdBy: { username: 'alice' }, targetRefs: [{ kind: 'message', messageId: 'msg-1' }] },
      { id: 'classify-2', relationType: 'CLASSIFY', sourceMessageId: null, targetRefs: [{ kind: 'message', messageId: 'msg-1' }] },
      { id: 'join-2', relationType: 'JOIN', sourceMessageId: 'classify-2', createdAt: '2026-01-02', targetRefs: [{ kind: 'message', messageId: 'msg-1' }] },
    ] as any;
    const preferred = new Map([['msg-1', 'join-1']]);
    expect(getEffectiveJoinRelationIds(relations, new Set(), new Set(['join-1']), preferred)).toEqual(new Set(['join-2']));
    expect(getEffectiveJoinRelationIds(relations, new Set(), new Set(), preferred)).toEqual(new Set(['join-1']));
  });

  it('嵌套容器目标也只保留一条生效 JOIN', () => {
    const relations = [
      { id: 'join-old', relationType: 'JOIN', sourceMessageId: 'outer-1', createdAt: '2026-01-01', targetRefs: [{ kind: 'relation', relationId: 'inner-1' }] },
      { id: 'join-new', relationType: 'JOIN', sourceMessageId: 'outer-2', createdAt: '2026-01-02', targetRefs: [{ kind: 'relation', relationId: 'inner-1' }] },
    ] as any;
    expect(getEffectiveJoinRelationIds(relations, new Set(), new Set())).toEqual(new Set(['join-new']));
  });

  it('容器关系目标可以查询指向它的被加入消息', () => {
    const relations = [
      { id: 'join-container', relationType: 'JOIN', sourceMessageId: 'outer-1', createdAt: '2026-01-01', targetRefs: [{ kind: 'relation', relationId: 'inner-1' }] },
      { id: 'join-text', relationType: 'JOIN', sourceMessageId: 'outer-1', createdAt: '2026-01-02', targetRefs: [{ kind: 'message', messageId: 'msg-1' }] },
    ] as any;
    expect(getJoinRelationsForMessage('inner-1', relations).map(relation => relation.id)).toEqual(['join-container']);
    expect(getJoinRelationsForMessage('msg-1', relations).map(relation => relation.id)).toEqual(['join-text']);
  });

  it('排列框架的 JOIN 被反对后不再显示该成员边', () => {
    const edges = [
      { id: 'arrange-edge', relationMessageId: 'arrange-1', relationType: 'arrange', from: { messageId: 'source-1', selection: { kind: 'whole' } }, to: { messageId: 'msg-1', selection: { kind: 'whole' } } },
    ] as any;
    const relations = [
      { id: 'join-arrange', relationType: 'JOIN', sourceMessageId: 'arrange-1', targetRefs: [{ kind: 'message', messageId: 'msg-1' }] },
    ] as any;
    expect(filterContainerEdgesByEffectiveJoins(edges, relations, new Set())).toEqual([]);
    expect(filterContainerEdgesByEffectiveJoins(edges, relations, new Set(['join-arrange']))).toEqual(edges);
  });

  it('分类被反对时，赞同无效 JOIN 还需要同时赞同其分类消息', () => {
    const relations = [
      { id: 'classify-1', relationType: 'CLASSIFY', sourceMessageId: null },
      { id: 'join-1', relationType: 'JOIN', sourceMessageId: 'classify-1' },
      { id: 'join-2', relationType: 'JOIN', sourceMessageId: 'classify-1' },
      { id: 'classify-2', relationType: 'CLASSIFY', sourceMessageId: null },
    ] as any;
    expect(getJoinRecoveryTargetIds(['join-1', 'join-2'], relations, new Set(['classify-1']))).toEqual(['classify-1']);
    expect(getJoinRecoveryTargetIds(['join-1'], relations, new Set(['classify-2']))).toEqual([]);
  });


  it('最新 JOIN 的容器被反对后回退到上一条有效 JOIN', () => {
    const relations = [
      { id: 'join-old', relationType: 'JOIN', sourceMessageId: 'classify-1', createdAt: '2026-01-01', targetRefs: [{ kind: 'message', messageId: 'msg-1' }] },
      { id: 'join-new', relationType: 'JOIN', sourceMessageId: 'classify-2', createdAt: '2026-01-02', targetRefs: [{ kind: 'message', messageId: 'msg-1' }] },
    ] as any;
    expect(getEffectiveJoinRelationIds(relations, new Set(['classify-2']), new Set())).toEqual(new Set(['join-old']));
  });

  it('所有 JOIN 都无效时没有生效 JOIN', () => {
    const relations = [
      { id: 'join-old', relationType: 'JOIN', sourceMessageId: 'classify-1', createdAt: '2026-01-01', targetRefs: [{ kind: 'message', messageId: 'msg-1' }] },
      { id: 'join-new', relationType: 'JOIN', sourceMessageId: 'classify-2', createdAt: '2026-01-02', targetRefs: [{ kind: 'message', messageId: 'msg-1' }] },
    ] as any;
    expect(getEffectiveJoinRelationIds(relations, new Set(['classify-1', 'classify-2']), new Set())).toEqual(new Set());
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

  it('唯一分类来源且文本为空时，候选区或目标集合非空才追加', () => {
    const base = { relationType: 'classify', sourceClassifyCount: 1, text: '' };
    expect(isAppendToExistingClassifyAction({ ...base, draftCount: 0, targetCount: 1 })).toBe(true);
    expect(isAppendToExistingClassifyAction({ ...base, draftCount: 1, targetCount: 0 })).toBe(true);
    expect(isAppendToExistingClassifyAction({ ...base, draftCount: 0, targetCount: 0 })).toBe(false);
    expect(isAppendToExistingClassifyAction({ ...base, text: '新分类', draftCount: 0, targetCount: 1 })).toBe(false);
    expect(isAppendToExistingClassifyAction({ ...base, draftCount: 1, targetCount: 0, sourceClassifyCount: 0 })).toBe(false);
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

describe('分类视图可见性', () => {
  it('兼容历史错误的容器 message ref，并将归并归属到分类', () => {
    const relations = [
      { id: 'merge-1', relationType: 'MERGE', targetRefs: [{ kind: 'message', messageId: 'msg-1' }] },
      { id: 'classify-1', relationType: 'CLASSIFY', targetRefs: [{ kind: 'message', messageId: 'merge-1' }] },
      { id: 'join-1', relationType: 'JOIN', sourceMessageId: 'classify-1', targetRefs: [{ kind: 'message', messageId: 'merge-1' }] },
    ] as any;

    const owned = collectOwnedByRelation('classify-1', new Map(relations.map((relation: any) => [relation.id, relation])));
    const visible = collectContainerVisibleIds('classify-1', relations, new Set(), new Set());

    expect(owned.relationIds.has('merge-1')).toBe(true);
    expect(owned.textIds.has('msg-1')).toBe(true);
    expect(visible.relationIds.has('merge-1')).toBe(true);
  });

  it('JOIN 归属的消息应出现在当前分类视图中', () => {
    const relations = [
      { id: 'classify-1', relationType: 'CLASSIFY', targetRefs: [{ kind: 'message', messageId: 'msg-1' }, { kind: 'message', messageId: 'msg-2' }] },
      { id: 'join-1', relationType: 'JOIN', sourceMessageId: 'classify-1', targetRefs: [{ kind: 'message', messageId: 'msg-2' }] },
    ] as any;

    const visible = collectContainerVisibleIds('classify-1', relations, new Set(), new Set());

    expect(visible.textIds.has('msg-1')).toBe(true);
    expect(visible.textIds.has('msg-2')).toBe(true);
  });
});

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

describe('导航目标解析', () => {
  it('边标签关系消息定位自身，而不是定位其目标消息', () => {
    const relations = [{
      id: 'annotation-1',
      relationType: 'ANNOTATION',
      targetRefs: [{ kind: 'message', messageId: 'target-1' }],
    }] as any;

    expect(resolveNavigationTargetId('annotation-1', [], relations)).toBe('annotation-1');
  });

  it('普通装饰标签定位到目标消息，推荐和冷藏定位到自身，分类关系仍定位自身', () => {
    const relations = [
      {
        id: 'tag-1',
        relationType: 'TAG',
        targetRefs: [{ kind: 'message', messageId: 'target-1' }],
      },
      {
        id: 'recommend-1',
        relationType: 'RECOMMEND',
        targetRefs: [{ kind: 'message', messageId: 'target-1' }],
      },
      {
        id: 'archive-1',
        relationType: 'ARCHIVE',
        targetRefs: [{ kind: 'message', messageId: 'target-1' }],
      },
      {
        id: 'agree-1',
        relationType: 'AGREE',
        targetRefs: [{ kind: 'message', messageId: 'target-1' }],
      },
      {
        id: 'disagree-1',
        relationType: 'DISAGREE',
        targetRefs: [{ kind: 'message', messageId: 'target-1' }],
      },
      {
        id: 'correct-1',
        relationType: 'CORRECT',
        targetRefs: [{ kind: 'message', messageId: 'target-1' }],
      },
      {
        id: 'classify-1',
        relationType: 'CLASSIFY',
        targetRefs: [{ kind: 'message', messageId: 'target-1' }],
      },
    ] as any;

    expect(resolveNavigationTargetId('tag-1', [], relations)).toBe('target-1');
    expect(resolveNavigationTargetId('recommend-1', [], relations)).toBe('recommend-1');
    expect(resolveNavigationTargetId('archive-1', [], relations)).toBe('archive-1');
    expect(resolveNavigationTargetId('agree-1', [], relations)).toBe('agree-1');
    expect(resolveNavigationTargetId('disagree-1', [], relations)).toBe('disagree-1');
    expect(resolveNavigationTargetId('correct-1', [], relations)).toBe('correct-1');
    expect(resolveNavigationTargetId('classify-1', [], relations)).toBe('classify-1');
  });
});
