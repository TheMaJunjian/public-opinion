import { describe, expect, it } from 'vitest';
import type { ExportData } from '../api/client';
import { prepareZhihuForViewing } from '../utils/zhihuArchive';
import { nativeZhihuDocument, sendNativeZhihuRelation } from '../utils/nativeZhihuEditor';
import { isNativeLocalMessage, mergeNativeZhihuUpdate, type NativeZhihuView } from '../utils/nativeZhihuView';
import { createZhihuStructuralViewer } from '../utils/zhihuStructuralViewer';
import { archiveToWorkbenchSnapshot, projectWorkbenchSnapshot } from '../utils/workbenchProjection';
import { deriveContainerEffect } from '../pages/workbench/model/containerEffect';
import { buildTraceProjection } from '../utils/traceProjection';
import { projectContainerCanvas } from '../pages/workbench/projections/containerCanvas';
import { planChronologicalMessageUnits } from '../utils/messageStructurePlan';
import { computeCorrectionVersions, isReviewRecord, isReviewDiscussion, isSettlementRecord } from '../utils/modelBridge';

const user = '本地整理者';
const item = (id: string) => `zhihu:item:answer:${id}`;
const question = (id: string) => `zhihu:question:q${id}`;
const comment = (id: string) => `zhihu:comment:answer%3A${id}:c${id}`;
export function structuralFixture(extra = false): NativeZhihuView {
  const { zhihu: _index, ...data } = prepareZhihuForViewing({ format: 'gonglun-zhihu-archive', version: 1,
    items: ['a', 'b', 'c'].map(id => ({ id, type: 'answer', text: `测试正文 ${id}`, question: { id: `q${id}`, title: `测试问题 ${id}`, text: '' } })),
    comments: [...['a', 'b', 'c'].map(id => ({ id: `c${id}`, sourceId: `c${id}`, threadId: `answer:${id}`,
      text: `测试评论 ${id}`, parentCommentId: null, rootCommentId: `c${id}` })),
      ...(extra ? [{ id: 'new', sourceId: 'new', threadId: 'answer:a', text: '同步后的测试评论', parentCommentId: null, rootCommentId: 'new' }] : [])],
  });
  return { ...data, viewerUsername: user, source: { provider: 'zhihu', version: 1, scope: 'own', ownerId: 'test-structure', ownerUrl: null } };
}
function fullEffect(data: ExportData, username: string | null = user) {
  const projected = projectWorkbenchSnapshot(archiveToWorkbenchSnapshot(data));
  return deriveContainerEffect({ ...projected, username, stakeCounts: projected.counts });
}
function assertCounts(data: NativeZhihuView, username: string | null = user) {
  const full = fullEffect(data, username), index = createZhihuStructuralViewer(data, username);
  for (const relation of data.relations) if (['CLASSIFY', 'SUMMARY', 'MERGE', 'ARRANGE'].includes(relation.relationType ?? ''))
    expect(index.memberCounts(relation.id), relation.id).toEqual(full.ownership.memberCounts(relation.id));
  return index;
}
function stanceToJoin(data: NativeZhihuView, joinId: string, type: 'AGREE' | 'DISAGREE'): NativeZhihuView {
  const id = `test:${type}:${data.messages.length}`;
  const parts: NonNullable<ExportData['messages'][number]['parts']> = [{ id: 'relation', type: 'relation',
    relation: type === 'AGREE' ? 'agree' : 'disagree', roles: { target: [{ id: 'target', reference: { messageId: joinId } }] } }];
  const row = { id, revision: 1, sequence: data.messages.length + 1, kind: 'RELATION', contentType: 'TEXT', content: '', parts,
    relationType: type, targetRefs: [{ kind: 'message', messageId: joinId }], sourceMessageId: null,
    authorId: 'test-actor', author: user, createdAt: new Date().toISOString(), relationPayload: {} };
  return { ...data, messages: [...data.messages, row], relations: [...data.relations, { ...row, payload: {}, supersededBy: null }] };
}

describe('structural Zhihu message loading', () => {
  it('loads only the overview cards while keeping full deduplicated membership counts', () => {
    const data = structuralFixture(), original = structuredClone(data);
    let bodyReads = 0;
    const hidden = data.messages.find(row => row.id === comment('c'))!;
    const body = hidden.content;
    Object.defineProperty(hidden, 'content', { enumerable: true, configurable: true, get: () => { bodyReads++; return body; } });
    const index = createZhihuStructuralViewer(data, user);
    const root = index.window({ classificationId: null });
    // Locating an overview category must not enter itself via one of its children.
    expect(index.containingClassification('zhihu:type:answer')).toBeNull();
    const projected = projectWorkbenchSnapshot(archiveToWorkbenchSnapshot(root.data));
    expect(root.data.messages.map(row => row.id)).toEqual(['zhihu:type:answer']);
    expect(projected.messages).toHaveLength(1);
    expect(bodyReads).toBe(0);
    expect(index.memberCounts('zhihu:type:answer').total).toBeGreaterThan(6);
    expect(root.unloadedContainers.has('zhihu:type:answer')).toBe(true);
    const parent = index.window({ classificationId: 'zhihu:type:answer' });
    expect(parent.data.messages.some(row => row.id === question('a'))).toBe(true);
    expect(parent.data.messages.some(row => row.id === comment('c'))).toBe(false);
    expect(bodyReads).toBe(0);
    const inside = index.window({ classificationId: question('c') });
    projectWorkbenchSnapshot(archiveToWorkbenchSnapshot(inside.data));
    expect(bodyReads).toBeGreaterThan(0);
    expect(inside.data.messages.some(row => row.id === comment('a'))).toBe(false);
    expect(data).toEqual(original);
  });

  it('uses effective JOIN history for moved messages, old/new counts and rejection fallback', () => {
    const original = structuralFixture();
    const moved = nativeZhihuDocument(sendNativeZhihuRelation(original, {
      relationType: 'CLASSIFY', sourceMessageIds: [question('b')], targetMessageIds: [comment('a')],
    }));
    const join = moved.messages.find(row => isNativeLocalMessage(row) && row.relationType === 'JOIN')!;
    expect(join).toBeDefined();
    const rejected = stanceToJoin(moved, join.id, 'DISAGREE');
    const restored = stanceToJoin(rejected, join.id, 'AGREE');
    for (const data of [original, moved, rejected, restored]) for (const username of [user, null]) {
      const index = assertCounts(data, username), full = fullEffect(data, username);
      for (const category of [question('a'), question('b')]) {
        const partial = fullEffect(index.window({ classificationId: category }).data, username);
        expect(partial.ownership.direct(category), `${category}: ${data.messages.length}`).toEqual(full.ownership.direct(category));
        expect(partial.joinByTarget.get(comment('a'))).toBe(full.joinByTarget.get(comment('a')));
      }
    }
    expect(createZhihuStructuralViewer(moved, user).containingClassification(comment('a'))).toBe(question('b'));
    expect(createZhihuStructuralViewer(rejected, user).containingClassification(comment('a'))).toBe(question('a'));
  });

  it('publishes synchronized source membership and existing local edits as one revision', () => {
    const original = structuralFixture();
    const edited = nativeZhihuDocument(sendNativeZhihuRelation(original, { relationType: 'CLASSIFY',
      sourceMessageIds: [question('b')], targetMessageIds: [comment('a')] }));
    const before = assertCounts(edited), beforeCount = before.memberCounts(question('a'));
    const incoming = structuralFixture(true), updated = mergeNativeZhihuUpdate(edited, incoming);
    const after = assertCounts(updated), opened = after.window({ classificationId: question('a') });
    expect(opened.data.messages.some(row => row.id === 'zhihu:comment:answer%3Aa:new')).toBe(true);
    expect(after.memberCounts(question('a')).total).toBeGreaterThan(beforeCount.total);
    expect(after.containingClassification(comment('a'))).toBe(question('b'));
    expect(before.memberCounts(question('a'))).toEqual(beforeCount);
    expect(before.has('zhihu:comment:answer%3Aa:new')).toBe(false);
    expect(updated.messages.filter(isNativeLocalMessage)).toHaveLength(edited.messages.filter(isNativeLocalMessage).length);
  });

  it.each([{ up: 0, down: 1 }, { up: 1, down: 0 }, { up: 2, down: 2 }])('traces across classification boundaries with the same range at %j', depths => {
    const initial = structuralFixture();
    const data = nativeZhihuDocument(sendNativeZhihuRelation(initial, { relationType: 'REPLY',
      sourceMessageIds: [comment('a')], targetMessageIds: [item('b')] }));
    const index = createZhihuStructuralViewer(data, user), full = fullEffect(data);
    const request = { classificationId: null, trace: { ids: [comment('a')], depths, expandedIds: [] } };
    const loaded = index.window(request), partial = fullEffect(loaded.data);
    const trace = (effect: ReturnType<typeof fullEffect>) => buildTraceProjection({ messages: effect.messages,
      edges: effect.traceEdges, containerMemberships: effect.memberships, excludedRelationIds: effect.suppressed,
      startIds: request.trace.ids, depths, distance: Math.max(depths.up, depths.down), expandedContainerIds: new Set(request.trace.ids) });
    const expected = trace(full), actual = trace(partial);
    expect(actual.messages.map(row => row.id).sort()).toEqual(expected.messages.map(row => row.id).sort());
    expect([...actual.semanticMessageIds!].sort()).toEqual([...expected.semanticMessageIds!].sort());
    expect(loaded.data.messages.some(row => row.id === comment('c'))).toBe(false);
    expect(index.window({ classificationId: null }).data.messages.some(row => row.id === comment('b'))).toBe(false);
  });

  it('loads an ID navigation target from an unopened category without changing the source', () => {
    const data = structuralFixture(), index = createZhihuStructuralViewer(data, user);
    const window = index.window({ classificationId: null, extraIds: [comment('b')] });
    expect(window.data.messages.find(row => row.id === comment('b'))?.content).toBe('测试评论 b');
    expect(index.containingClassification(comment('b'))).toBe(question('b'));
    expect(window.data.messages.some(row => row.id === comment('c'))).toBe(false);
    expect(index.window({ classificationId: question('c') }).data.messages.some(row => row.id === comment('b'))).toBe(false);
  });

  it('does not hydrate a closed local group through its unowned JOIN history', () => {
    const data = nativeZhihuDocument(sendNativeZhihuRelation(structuralFixture(), { relationType: 'CLASSIFY',
      title: '技术测试分组', targetMessageIds: [comment('a'), comment('b'), comment('c')] }));
    const group = data.messages.find(row => isNativeLocalMessage(row) && row.relationType === 'CLASSIFY')!;
    const index = assertCounts(data), root = index.window({ classificationId: null });
    expect(root.data.messages.some(row => row.id === group.id)).toBe(true);
    expect(root.data.messages.filter(row => row.kind === 'TEXT')).toHaveLength(0);
    expect(root.data.messages.some(row => row.relationType === 'JOIN')).toBe(false);
    expect(index.memberCounts(group.id).total).toBe(3);
    const records = index.joinRecordIds(group.id, 'outgoing');
    expect(records).toHaveLength(3);
    const history = index.window({ classificationId: null, recordIds: records, includeJoinRecords: true });
    expect(history.data.messages.filter(row => row.relationType === 'JOIN').map(row => row.id).sort()).toEqual([...records].sort());
    expect(history.data.messages.filter(row => row.kind === 'TEXT').map(row => row.id).sort()).toEqual(['a', 'b', 'c'].map(comment).sort());
    expect(index.window({ classificationId: group.id }).data.messages.some(row => row.id === comment('a'))).toBe(true);
  });

  it('matches full canvases and directional traces through nested frames, moves, suppression and corrections', () => {
    const source = structuralFixture();
    const arranged = nativeZhihuDocument(sendNativeZhihuRelation(source, { relationType: 'ARRANGE',
      targetMessageIds: [comment('a'), comment('b')], currentClassificationId: question('a'), targetLayout: 'single-row' }));
    const frame = arranged.messages.find(row => isNativeLocalMessage(row) && row.relationType === 'ARRANGE')!.id;
    const connected = nativeZhihuDocument(sendNativeZhihuRelation(arranged, { relationType: 'REPLY',
      sourceMessageIds: [item('b')], targetMessageIds: [item('c')], note: '测试关系正文' }));
    const corrected = nativeZhihuDocument(sendNativeZhihuRelation(connected, { relationType: 'CORRECT',
      targetMessageIds: [item('c')], content: '技术测试更正', correctionField: 'body' }));
    const rejected = nativeZhihuDocument(sendNativeZhihuRelation(corrected, { relationType: 'DISAGREE', targetMessageIds: [frame] }));
    for (const data of [arranged, corrected, rejected]) {
      const full = fullEffect(data), index = assertCounts(data);
      for (const classificationId of [null, 'zhihu:type:answer', question('a'), question('b'), question('c')]) {
        const partial = fullEffect(index.window({ classificationId }).data);
        const scope = classificationId ? { kind: 'inside' as const, id: classificationId } : { kind: 'root' as const };
        const ordinary = (value: ReturnType<typeof fullEffect>) => projectContainerCanvas(value, scope).messages
          .filter(row => row.kind !== 'join').map(row => row.id).sort();
        expect(ordinary(partial), `canvas:${classificationId}`).toEqual(ordinary(full));
        for (const viewMode of ['list', 'graph'] as const) for (const limit of [1, 2, 5]) {
          const paged = index.window({ classificationId, viewMode }, limit), actual = fullEffect(paged.data);
          expect(paged.data.messages.every(row => index.window({ classificationId }).data.messages.some(fullRow => fullRow.id === row.id))).toBe(true);
          const prefix = (value: ReturnType<typeof fullEffect>) => {
            const canvas = projectContainerCanvas(value, scope, viewMode);
            const visible = canvas.messages.filter(row => row.kind !== 'join' && !isSettlementRecord(row) && !isReviewRecord(row) && !isReviewDiscussion(row));
            const plan = planChronologicalMessageUnits(visible, canvas.edges), units = new Set(plan.units.slice(0, limit));
            return plan.order.filter(id => units.has(plan.byId.get(id)!));
          };
          expect(prefix(actual), `paged:${classificationId}:${viewMode}:${limit}`).toEqual(prefix(full));
          const expectedVersions = computeCorrectionVersions(full.messages, full.edges, full.suppressed, user);
          const actualVersions = computeCorrectionVersions(actual.messages, actual.edges, actual.suppressed, user);
          for (const id of prefix(full)) expect(actualVersions.get(id), `correction:${id}`).toEqual(expectedVersions.get(id));
        }
      }
      for (const id of [item('a'), comment('a'), item('b'), item('c'), frame, question('a')]) {
        for (const depths of [{ up: 0, down: 0 }, { up: 1, down: 0 }, { up: 0, down: 1 }, { up: 1, down: 2 }, { up: 3, down: 1 }]) {
          const partial = fullEffect(index.window({ classificationId: null, trace: { ids: [id], depths, expandedIds: [frame] } }).data);
          const trace = (effect: ReturnType<typeof fullEffect>) => buildTraceProjection({ messages: effect.messages, edges: effect.traceEdges,
            containerMemberships: effect.memberships, excludedRelationIds: effect.suppressed, startIds: [id], depths,
            distance: Math.max(depths.up, depths.down), expandedContainerIds: new Set([id, frame]) });
          expect(trace(partial).messages.map(row => row.id).sort(), `${data.messages.length}:${id}:${JSON.stringify(depths)}`)
            .toEqual(trace(full).messages.map(row => row.id).sort());
        }
      }
    }
  });
});
