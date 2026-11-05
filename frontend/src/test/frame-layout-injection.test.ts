import { afterEach, expect, it, vi } from 'vitest';
import { computeSceneLayout, type SceneLayoutInput } from '../utils/frameLayout';
import * as frameLayoutCore from '../utils/frameLayoutCore';
import { layoutDiscussion } from '../utils/discussionLayout';
import { planMessageStructures } from '../utils/messageStructurePlan';
import type { DemoEdge, DemoMessage } from '../utils/modelBridge';

const messages: DemoMessage[] = ['target', 'source', 'separate'].map((id, sequence) => ({ id, sequence, createdAt: '', author: 'structure-fixture', kind: 'normal', content: `fixture:${id}` }));
const edges: DemoEdge[] = [{ id: 'reply-edge', relationMessageId: 'reply-record', relationType: 'reply', relationLabel: 'reply',
  from: { messageId: 'source', selection: { kind: 'whole' } }, to: { messageId: 'target', selection: { kind: 'whole' } } }];
const input: SceneLayoutInput = { normals: messages, allMessages: messages, edges, colOf: {}, maxCol: 0,
  measuredHeights: { target: 180, source: 240 }, measuredWidths: { source: 410 } };
afterEach(() => vi.restoreAllMocks());

it.each([false, true])('keeps the base layout and public entry equivalent without discussion (organization: %s)', organization => {
  const value: SceneLayoutInput = { ...input, frameBlocks: organization ? [{ relMsgId: 'group', cardIds: new Set(['target', 'source']),
    directCardIds: new Set(['target', 'source']), childRelMsgIds: [], isMerge: false, hasGroupHeader: true }] : [] };
  const discussionComputer = vi.fn(layoutDiscussion);
  expect(frameLayoutCore.computeFrameSceneLayout(value)).toEqual(computeSceneLayout(value));
  expect(frameLayoutCore.computeFrameSceneLayout(value, discussionComputer)).toEqual(computeSceneLayout(value));
  expect(discussionComputer).not.toHaveBeenCalled();
});

it('only enables automatic regions when the public graph entry injects the discussion calculator', () => {
  const value: SceneLayoutInput = { ...input, discussionLayout: true,
    discussionRegions: [{ key: 'reply-region', targetId: 'target', type: 'reply', collapsed: false, directCount: 1 }] };
  const discussionComputer = vi.fn(layoutDiscussion);
  expect(frameLayoutCore.computeFrameSceneLayout(value, discussionComputer)).toEqual(computeSceneLayout(value));
  expect(discussionComputer).toHaveBeenCalledOnce();
  expect(computeSceneLayout(value).discussionRegions?.[0].key).toBe('reply-region');
  expect(() => frameLayoutCore.computeFrameSceneLayout(value)).toThrow('讨论布局需要提供计算器');
});

it.each(['placement', 'time'] as const)('preserves %s paging order using only the base layout path', order => {
  const base = vi.spyOn(frameLayoutCore, 'computeFrameSceneLayout');
  const plan = planMessageStructures({ messages, edges, order });
  expect(plan.order).toEqual(['target', 'source', 'separate']);
  expect(plan.placementOrder).toEqual(['target', 'source', 'separate']);
  if (order === 'placement') expect(plan.byId.get('target')).toBe(plan.byId.get('source'));
  else expect(plan.byId.get('target')).not.toBe(plan.byId.get('source'));
  expect(plan.byId.get('separate')).not.toBe(plan.byId.get('target'));
  expect(base).toHaveBeenCalledOnce();
  expect(base.mock.calls[0][0].discussionLayout).toBeUndefined();
  expect(base.mock.calls[0][1]).toBeUndefined();
});
