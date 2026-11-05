import { expect, it } from 'vitest';
import type { Message, Relation } from '../types';
import { convertMessagesToDemoModel } from '../utils/modelBridge';
import { projectGraphScene } from '../utils/graphProjection';
import { deriveContainerEffect } from '../pages/workbench/model/containerEffect';
import { projectContainerCanvas } from '../pages/workbench/projections/containerCanvas';
import { deriveComparisonGraphProjections } from '../pages/workbench/projections/comparisonGraphProjections';
import { hiddenInactiveRelationIds } from '../utils/relatedMessages';

const user = { id: 'writer', username: 'writer', createdAt: '' };
const text = (id: string): Message => ({ id, kind: 'TEXT', contentType: 'TEXT', content: id, createdAt: '', createdBy: user });
const rel = (id: string, type: string, targets: string[] = [], sourceMessageId: string | null = null, day = 1): Relation => ({
  id, relationType: type, sourceMessageId, targetRefs: targets.map(messageId => ({ kind: 'message', messageId })),
  payload: { title: id }, createdBy: user, createdAt: `2026-01-0${day}`,
});
function review(relations: Relation[], targetId: string, scopeId: string | null = null, hidden: string[] = [], contentMessages = ['one', 'two', 'private', 'outside'].map(text)) {
  const model = convertMessagesToDemoModel(contentMessages, relations);
  const sourceEffect = deriveContainerEffect({ ...model, relations, username: null, stakeCounts: {} });
  const base = projectContainerCanvas(sourceEffect, scopeId ? { kind: 'inside', id: scopeId } : { kind: 'root' });
  const before = JSON.stringify({ model, relations });
  const pair = deriveComparisonGraphProjections({ ...model, relations, sourceEffect, username: null,
    comparisonReviewed: true, comparisonTargetId: targetId, showMembershipFrames: true, scopeId, baseScopeId: scopeId,
    traceEntries: [], traceDistance: 1, traceExpandedFrameIds: new Set(), traceRelationMsgIds: new Set(), traceContainerMemberships: [],
    collectExclusiveRelationMsgIds: () => new Set(), replacedRelationMsgIds: new Set(),
    comparisonReviewBaseMessages: base.messages, comparisonReviewBaseEdges: base.edges, isInsideClassify: !!scopeId,
    normalGraphProjection: { ...base, scopedMessages: base.messages },
    filterMessages: messages => messages.filter(message => message.kind !== 'join' && !hidden.includes(message.id)),
  })!;
  expect(JSON.stringify({ model, relations })).toBe(before);
  return pair;
}
function scene(side: ReturnType<typeof review>['agree']) {
  return projectGraphScene({ ...side, ...side.context, isTraceWindow: false, traceExpandedFrameIds: new Set() });
}
function frames(side: ReturnType<typeof review>['agree']) {
  return new Map(scene(side).frameBlocks.map(frame => [frame.relMsgId, frame.directCardIds]));
}

it('changes only the reviewed assumption and retains opposed text in its affected membership paths', () => {
  const relations=[rel('category','CLASSIFY',['one','two']),rel('against-one','DISAGREE',['one']),
    rel('against-two','DISAGREE',['two']),rel('other-category','CLASSIFY',['private']),rel('against-other','DISAGREE',['other-category'])];
  const contentMessages=['one','two','private','outside'].map(id=>({...text(id),state:{messageId:id,revision:1,
    supportCount:0,oppositionCount:1,recommendationTotal:0,suppressed:['one','two'].includes(id)}}));
  const pair=review(relations,'category',null,[],contentMessages);
  for(const side of [pair.agree,pair.disagree]){
    expect(side.suppressed.has('one')).toBe(true);
    expect(side.suppressed.has('two')).toBe(true);
    expect(side.suppressed.has('other-category')).toBe(true);
    const rendered=projectGraphScene({...side,...side.context,isTraceWindow:false,traceExpandedFrameIds:new Set(),
      hiddenMessageIds:hiddenInactiveRelationIds(side.messages,side.suppressed)});
    expect(rendered.normalIds).toEqual(expect.arrayContaining(['one','two']));
    expect(side.messages.some(message=>message.id==='private')).toBe(false);
  }
  expect([...pair.agree.suppressed].filter(id=>id!=='category').sort()).toEqual([...pair.disagree.suppressed].filter(id=>id!=='category').sort());
  expect(pair.agree.suppressed.has('category')).toBe(false);
  expect(pair.disagree.suppressed.has('category')).toBe(true);
  expect(frames(pair.agree).get('category')).toEqual(new Set(['one','two']));
  expect(frames(pair.disagree).has('category')).toBe(false);
});

it.each([null, 'old'])('shows both locations of a JOIN reviewed from %s', scopeId => {
  const relations = [rel('old', 'CLASSIFY'), rel('new', 'CLASSIFY'), rel('unrelated', 'CLASSIFY', ['private']),
    rel('previous', 'JOIN', ['one'], 'old'), rel('move', 'JOIN', ['one'], 'new', 2)];
  const pair = review(relations, 'move', scopeId);
  expect(frames(pair.agree).get('new')).toEqual(new Set(['one']));
  expect(frames(pair.agree).get('old')).toEqual(new Set());
  expect(frames(pair.disagree).get('old')).toEqual(new Set(['one']));
  expect(frames(pair.disagree).get('new')).toEqual(new Set());
  for (const side of [pair.agree, pair.disagree]) {
    expect(scene(side).normalIds).toContain('one');
    expect(scene(side).normalIds).not.toContain('private');
    expect(frames(side).has('unrelated')).toBe(false);
    expect(side.messages.some(message => ['unrelated', 'private', 'outside', 'two'].includes(message.id))).toBe(false);
  }
  expect(pair.agree.context.joinStatusByMessage.get('move')).toBe('valid');
  expect(pair.disagree.context.joinStatusByMessage.get('move')).toBe('rejected');
});

it('omits unchanged siblings while preserving the old and new enclosing frames', () => {
  const pair = review([rel('outer', 'CLASSIFY', ['old', 'new']), rel('old', 'CLASSIFY', ['private']), rel('new', 'CLASSIFY', ['two']),
    rel('previous', 'JOIN', ['one'], 'old'), rel('move', 'JOIN', ['one'], 'new', 2)], 'move', 'old');
  for (const side of [pair.agree, pair.disagree]) {
    expect(side.messages.map(message => message.id).sort()).toEqual(['new', 'old', 'one', 'outer']);
    expect(side.edges.every(edge => !['private', 'two', 'outside'].includes(edge.to.messageId))).toBe(true);
  }
});

it('retains endpoints of an affected connection and omits unrelated root messages', () => {
  const pair = review([rel('reference', 'REFERENCE', ['two'], 'one')], 'reference');
  for (const side of [pair.agree, pair.disagree]) {
    expect(side.messages.map(message => message.id)).toEqual(expect.arrayContaining(['one', 'two', 'reference']));
    expect(side.messages.some(message => ['private', 'outside'].includes(message.id))).toBe(false);
  }
});

it('does not turn inactive annotations into cards when reviewing their enclosing category', () => {
  const pair = review([rel('category', 'CLASSIFY', ['one', 'two']), rel('annotation', 'ANNOTATION', ['category'], 'one'),
    rel('opposition', 'DISAGREE', ['annotation']), rel('unrelated', 'ANNOTATION', ['outside'], 'private'),
    rel('other-opposition', 'DISAGREE', ['unrelated'])], 'category');
  expect(pair.disagree.messages.some(message => message.id === 'annotation')).toBe(false);
  expect(pair.disagree.edges.some(edge => edge.relationMessageId === 'annotation')).toBe(false);
  expect(pair.disagree.messages.some(message => message.id === 'unrelated')).toBe(false);
});

it('shows an active annotation as its relationship and hides it when its category target is rejected', () => {
  const pair = review([rel('category', 'CLASSIFY', ['one', 'two']), rel('annotation', 'ANNOTATION', ['category'], 'one')], 'category');
  expect(pair.agree.edges.some(edge => edge.relationMessageId === 'annotation')).toBe(true);
  expect(scene(pair.agree).normalIds).not.toContain('annotation');
  expect(pair.disagree.messages.some(message => message.id === 'annotation')).toBe(false);
  expect(pair.disagree.edges.some(edge => edge.relationMessageId === 'annotation')).toBe(false);
});

it('retains ordering peers of mutually exclusive marks without including unrelated roots', () => {
  const pair = review([rel('mark', 'RECOMMEND', ['two'], 'one', 3), rel('peer', 'RECOMMEND', ['two'], 'private')], 'mark');
  for (const side of [pair.agree, pair.disagree]) {
    expect(side.messages.map(message => message.id)).toEqual(expect.arrayContaining(['one', 'two', 'private']));
    expect(side.messages.some(message => message.id === 'outside')).toBe(false);
  }
  expect(pair.agree.edges.find(edge => edge.relationMessageId === 'mark')?.relationType).toBe('recommend');
  expect(pair.disagree.edges.find(edge => edge.relationMessageId === 'mark')?.relationType).toBe('archive');
});

it('shows members returning to different categories and preserves both ancestor paths', () => {
  const pair = review([rel('parent', 'CLASSIFY', ['old-one', 'old-two', 'new']),
    rel('old-one', 'CLASSIFY'), rel('old-two', 'CLASSIFY'), rel('new', 'CLASSIFY'),
    rel('first-one', 'JOIN', ['one'], 'old-one'), rel('first-two', 'JOIN', ['two'], 'old-two'),
    rel('move-one', 'JOIN', ['one'], 'new', 2), rel('move-two', 'JOIN', ['two'], 'new', 2),
  ], 'new', 'parent');
  expect(frames(pair.agree).get('new')).toEqual(new Set(['one', 'two']));
  expect(frames(pair.agree).get('old-one')).toEqual(new Set());
  expect(frames(pair.agree).get('old-two')).toEqual(new Set());
  expect(frames(pair.disagree).has('new')).toBe(false);
  expect(frames(pair.disagree).get('old-one')).toEqual(new Set(['one']));
  expect(frames(pair.disagree).get('old-two')).toEqual(new Set(['two']));
  for (const side of [pair.agree, pair.disagree]) {
    const parent = scene(side).frameBlocks.find(frame => frame.relMsgId === 'parent')!;
    expect(parent.childRelMsgIds).toEqual(expect.arrayContaining(['old-one', 'old-two']));
    expect(side.messages.filter(message => message.id === 'one')).toHaveLength(1);
    expect(side.messages.filter(message => message.id === 'two')).toHaveLength(1);
  }
});

it('releases a rejected category into its parent without retaining the rejected frame', () => {
  const pair = review([rel('parent', 'CLASSIFY', ['category']), rel('category', 'CLASSIFY', ['one', 'two'])], 'category', 'parent');
  expect(frames(pair.agree).get('category')).toEqual(new Set(['one', 'two']));
  expect(frames(pair.disagree).has('category')).toBe(false);
  expect(frames(pair.disagree).get('parent')).toEqual(new Set(['category', 'one', 'two']));
});

it('shares one enclosing frame for multiple differences and retains its nested children', () => {
  const pair=review([rel('outer','CLASSIFY',['old','new']),rel('old','CLASSIFY'),rel('new','CLASSIFY'),
    rel('previous','JOIN',['one','two'],'old'),rel('move','JOIN',['one','two'],'new',2)],'move','old');
  for (const [side, owner] of [[pair.agree,'new'],[pair.disagree,'old']] as const) {
    const result=scene(side);
    expect(result.frameBlocks.filter(frame=>frame.relMsgId==='outer')).toHaveLength(1);
    expect(result.frameBlocks.find(frame=>frame.relMsgId==='outer')!.childRelMsgIds.sort()).toEqual(['new','old']);
    expect(result.frameBlocks.find(frame=>frame.relMsgId===owner)!.directCardIds).toEqual(new Set(['one','two']));
    expect(result.frameDepthMap.get(owner)).toBe(1);
    for(const id of ['outer','old','new','one','two'])expect(side.messages.filter(message=>message.id===id)).toHaveLength(1);
  }
});

it('keeps a member at root when an opposed JOIN has no previous category', () => {
  const pair = review([rel('category', 'CLASSIFY'), rel('move', 'JOIN', ['one'], 'category')], 'move');
  expect(frames(pair.agree).get('category')).toEqual(new Set(['one']));
  expect(frames(pair.disagree).get('category')).toEqual(new Set());
  expect(scene(pair.disagree).normalIds).toContain('one');
  expect(scene(pair.disagree).frameBlocks.every(frame => !frame.cardIds.has('one'))).toBe(true);
});

it('keeps identical membership when another JOIN to the same category takes over',()=>{
  const pair=review([rel('category','CLASSIFY'),rel('previous','JOIN',['one'],'category'),rel('new','JOIN',['one'],'category',2)],'new');
  expect(pair.agree.effect.joinByTarget.get('one')).toBe('new');
  expect(pair.disagree.effect.joinByTarget.get('one')).toBe('previous');
  expect(frames(pair.agree)).toEqual(frames(pair.disagree));
});

it('expands descendants of a moved category while honoring message filters', () => {
  const pair = review([rel('old', 'CLASSIFY'), rel('new', 'CLASSIFY'), rel('nested', 'CLASSIFY', ['one', 'two']),
    rel('previous', 'JOIN', ['nested'], 'old'), rel('move', 'JOIN', ['nested'], 'new', 2)], 'move', null, ['two']);
  for (const side of [pair.agree, pair.disagree]) {
    expect(frames(side).get('nested')).toEqual(new Set(['one']));
    expect(side.messages.some(message => message.id === 'two')).toBe(false);
    expect(side.edges.some(edge => edge.to.messageId === 'two')).toBe(false);
  }
  expect(scene(pair.agree).frameBlocks.find(frame => frame.relMsgId === 'new')!.childRelMsgIds).toContain('nested');
  expect(scene(pair.disagree).frameBlocks.find(frame => frame.relMsgId === 'old')!.childRelMsgIds).toContain('nested');
});
