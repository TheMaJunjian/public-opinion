import { expect, it } from 'vitest';
import type { Message, Relation } from '../types';
import { computeCorrectionVersions, convertMessagesToDemoModel, withCorrectionContent } from '../utils/modelBridge';
import { deriveContainerEffect } from '../pages/workbench/model/containerEffect';
import { deriveComparisonGraphProjections } from '../pages/workbench/projections/comparisonGraphProjections';

const writer = { id: 'writer', username: 'writer', createdAt: '' };
const opponent = { id: 'opponent', username: 'opponent', createdAt: '' };

function fixture() {
  const original: Message = { id: 'original', revision: 1, kind: 'TEXT', contentType: 'TEXT', content: '好玩吗？',
    parts: [{ id: 'body', type: 'text', text: '好玩吗？' }], createdAt: '2026-01-01', createdBy: writer };
  const reference = { messageId: original.id, revision: 1, partId: 'body', range: { start: 2, end: 4 } };
  const correction: Relation = { id: 'correction', revision: 1, relationType: 'CORRECT', sourceMessageId: null,
    targetRefs: [{ kind: 'text-fragment', messageId: original.id, text: '吗？', hash: 'range', reference }],
    parts: [{ id: 'corrected-body', type: 'text', text: '好玩1111' },
      { id: 'relation', type: 'relation', relation: 'correct', roles: { target: [{ id: 't', reference }] } }],
    payload: { correctionKind: 'TEXT', correctionBeforeContent: '好玩吗？', correctionAfterContent: '好玩1111', correctionValue: '1111' },
    state: { messageId: 'correction', revision: 1, suppressed: true, supportCount: 1, oppositionCount: 1, recommendationTotal: 0 },
    createdAt: '2026-01-02', createdBy: writer };
  const approval: Relation = { id: 'approval', relationType: 'AGREE', sourceMessageId: null,
    targetRefs: [{ kind: 'relation', relationId: correction.id }], createdAt: '2026-01-02', createdBy: writer };
  const objection: Relation = { ...approval, id: 'objection', relationType: 'DISAGREE', createdAt: '2026-01-03', createdBy: opponent };
  const relations = [correction, approval, objection], model = convertMessagesToDemoModel([original], relations);
  return { ...model, relations };
}

it.each([null, 'observer', 'writer', 'opponent'].flatMap(username => [false, true].map(shown => ({ username, shown }))))(
  'renders the assumed correction bodies independently for $username (initial corrected display=$shown)', ({ username, shown }) => {
  const model = fixture(), original = model.messages.find(message => message.id === 'original')!;
  const displayedCorrections = computeCorrectionVersions(model.messages, model.edges, new Set(['correction']), username,
    shown ? { previewCorrectionId: 'correction' } : {});
  const current = displayedCorrections.get(original.id)?.current;
  const baseMessages = model.messages.map(message => message.id === original.id && current
    ? withCorrectionContent(message, current.content, current.changes, current.snapshot) : message);
  const sourceEffect = deriveContainerEffect({ ...model, username });
  const before = JSON.stringify(model);
  const pair = deriveComparisonGraphProjections({ ...model, username, sourceEffect, displayedCorrections,
    comparisonReviewed: true, comparisonTargetId: 'correction', scopeId: null, isInsideClassify: false,
    traceEntries: [], traceDistance: 1, traceExpandedFrameIds: new Set(), traceRelationMsgIds: new Set(), traceContainerMemberships: [],
    collectExclusiveRelationMsgIds: () => new Set(), replacedRelationMsgIds: new Set(),
    comparisonReviewBaseMessages: baseMessages, comparisonReviewBaseEdges: model.edges,
    normalGraphProjection: { messages: baseMessages, scopedMessages: baseMessages, edges: model.edges },
  })!;
  const body = (side: typeof pair.agree) => side.messages.find(message => message.id === original.id)!;
  expect(body(pair.agree).content).toBe('好玩1111');
  expect(body(pair.disagree).content).toBe('好玩吗？');
  expect(body(pair.agree).parts?.find(part => part.id === 'body')).toMatchObject({ text: '好玩1111' });
  expect(body(pair.disagree).parts?.find(part => part.id === 'body')).toMatchObject({ text: '好玩吗？' });
  expect(pair.agree.corrections.get(original.id)?.current?.appliedCorrectionIds).toEqual(['correction']);
  expect(pair.disagree.corrections.get(original.id)?.current).toBeUndefined();
  expect(JSON.stringify(model)).toBe(before);
});

it.each([false, true])('compares width adoption with the original or an alternative width (alternative=%s)', alternative => {
  const original: Message = { id: 'original', kind: 'TEXT', contentType: 'TEXT', content: '正文', createdAt: '2026-01-01', createdBy: writer };
  const width: Relation = { id: 'width', relationType: 'CORRECT', sourceMessageId: null,
    targetRefs: [{ kind: 'message', messageId: original.id }], payload: { correctionKind: 'WIDTH', correctionWidth: 640 },
    createdAt: '2026-01-03', createdBy: writer };
  const objection: Relation = { ...width, id: 'objection', relationType: 'DISAGREE', payload: {},
    targetRefs: [{ kind: 'relation', relationId: width.id }], createdAt: '2026-01-04', createdBy: opponent };
  const relations = [...alternative ? [{ ...width, id: 'other-width', payload: { correctionKind: 'WIDTH' as const, correctionWidth: 480 }, createdAt: '2026-01-02' }] : [], width, objection];
  const model = convertMessagesToDemoModel([original], relations), before = JSON.stringify(model);
  const sourceEffect = deriveContainerEffect({ ...model, relations, username: 'opponent' });
  const pair = deriveComparisonGraphProjections({ ...model, relations, username: 'opponent', sourceEffect,
    comparisonReviewed: true, comparisonTargetId: width.id, scopeId: null, isInsideClassify: false,
    traceEntries: [], traceDistance: 1, traceExpandedFrameIds: new Set(), traceRelationMsgIds: new Set(), traceContainerMemberships: [],
    collectExclusiveRelationMsgIds: () => new Set(), replacedRelationMsgIds: new Set(),
    comparisonReviewBaseMessages: null, comparisonReviewBaseEdges: null,
    normalGraphProjection: { ...model, scopedMessages: model.messages },
  })!;
  expect(pair.agree.widths?.original).toBe(640);
  expect(pair.disagree.widths?.original ?? 320).toBe(alternative ? 480 : 320);
  expect(JSON.stringify(model)).toBe(before);
});
