import { expect, it } from 'vitest';
import { createSceneComputationInput, type SceneComputationJob } from '../utils/sceneComputationInput';
import { sceneComputationKey } from '../utils/sceneComputationKey';
import { planMessageStructures } from '../utils/messageStructurePlan';
import { computeSceneLayout } from '../utils/frameLayout';
import { projectGraphScene } from '../utils/graphProjection';
import type { DemoMessage, DemoEdge } from '../utils/modelBridge';

const body = '技术测试正文'.repeat(20000);
const base: DemoMessage = { id: 'body', kind: 'normal', author: 'test', createdAt: '2026-01-01', revision: 2,
  content: body, parts: [{ id: 'text', type: 'text', text: body }, { id: 'evidence', type: 'data', value: { html: body } }] };

it.each(['reply', 'annotation', 'reference', 'agree', 'correct', 'classify', 'merge', 'arrange'] as const)(
  'preserves %s placement, attachments and measured layout without transferring source bodies', type => {
    const relation: DemoMessage = { id: 'relation', kind: 'relation', relationType: type, author: 'test', createdAt: '2026-01-02',
      content: body, relationPayload: { note: body, targetLayout: 'single-column', correctionBeforeContent: body },
      sourceMessageId: 'body', targetRefs: [{ kind: 'message', messageId: 'other' }],
      ...(type === 'agree' ? { executedStance: { target: { messageId: 'other', revision: 1 }, side: 'pro' as const, partId: 'relation', sourceRevision: 1 } } : {}),
      parts: [{ id: 'text', type: 'text', text: body }, { id: 'relation', type: 'relation', relation: type,
        roles: { source: [{ id: 's', reference: { messageId: 'body' } }], target: [{ id: 't', reference: { messageId: 'other' } }] } }] };
    const messages = [base, { ...base, id: 'other', createdAt: '2026-01-03' }, relation];
    const edges: DemoEdge[] = [{ id: 'edge', relationMessageId: 'relation', relationType: type, relationLabel: type,
      from: { messageId: 'body', selection: { kind: 'whole' } }, to: { messageId: 'other', selection: { kind: 'whole' } } }];
    const compact = createSceneComputationInput();
    for (const order of ['time', 'placement'] as const) {
      const original = { kind: 'structures' as const, input: { messages, edges, order } };
      const reduced = compact(original);
      expect(JSON.stringify(reduced).length).toBeLessThan(JSON.stringify(original).length / 100);
      expect(sceneComputationKey(reduced)).toBe(sceneComputationKey(original));
      if (reduced.kind !== 'structures') throw new Error('Unexpected job');
      expect(planMessageStructures(reduced.input)).toEqual(planMessageStructures(original.input));
    }
    const scene = projectGraphScene({ messages, edges, traceExpandedFrameIds: new Set(), isTraceWindow: false });
    const original: SceneComputationJob = { kind: 'layout', input: { normals: scene.normals, allMessages: messages,
      edges: scene.layoutEdges, frameBlocks: scene.frameBlocks, colOf: scene.pipelineCol, maxCol: scene.pipelineMaxCol,
      correctedTargetIds: scene.hiddenTargetIds, measuredWidths: {}, measuredHeights: { body: 320, other: 150, relation: 200 } } };
    const reduced = compact(original);
    if (reduced.kind !== 'layout') throw new Error('Unexpected job');
    expect(computeSceneLayout(reduced.input)).toEqual(computeSceneLayout(original.input));
    expect(base.content).toBe(body);
    expect(base.parts![1]).toEqual({ id: 'evidence', type: 'data', value: { html: body } });
    const resized = compact({ ...original, input: { ...original.input, measuredHeights: { body: 700 } } });
    if (resized.kind !== 'layout') throw new Error('Unexpected job');
    expect(resized.input.allMessages).toBe(reduced.input.allMessages);
    expect(resized.input.normals).toBe(reduced.input.normals);
  });

it('preserves whitespace-only bodies and explicit display declarations', () => {
  const messages: DemoMessage[] = [base, { ...base, id: 'dependent', kind: 'relation', relationType: 'annotation',
    content: '   ', parts: [{ id: 'text', type: 'text', text: '   ' },
      { id: 'display', type: 'display', relationPartId: 'relation', layout: 'relation', target: { messageId: 'body' } }] }];
  const original = { kind: 'structures' as const, input: { messages, edges: [] } };
  const reduced = createSceneComputationInput()(original);
  if (reduced.kind !== 'structures') throw new Error('Unexpected job');
  expect(sceneComputationKey(reduced)).toBe(sceneComputationKey(original));
  expect(planMessageStructures(reduced.input)).toEqual(planMessageStructures(original.input));
});
