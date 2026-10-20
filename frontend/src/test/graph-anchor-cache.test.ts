import { expect, it } from 'vitest';
import { measureGraphOverlays, type GraphOverlayInput } from '../utils/graphOverlays';
import type { DemoMessage, DemoEdge } from '../utils/modelBridge';

it('routes a fragment reference to its cached anchor after its target card has unmounted or moved', () => {
  const canvas = document.createElement('div');
  const messages: DemoMessage[] = ['source', 'target'].map(id => ({ id, kind: 'normal', content: '文字片段', author: 'tester', createdAt: '' }));
  const edge: DemoEdge = { id: 'reference', relationMessageId: 'reference', relationType: 'reference',
    from: { messageId: 'source', selection: { kind: 'whole' } },
    to: { messageId: 'target', selection: { kind: 'text', start: 0, len: 2, text: '文字' } }, relationLabel: '引用' };
  const input: GraphOverlayInput = {
    canvasRef: { current: canvas }, normalIds: ['source', 'target'], msgMap: new Map(messages.map(message => [message.id, message])),
    relationCardMsgIds: new Set(), cardRefs: { current: {} }, colOf: { source: 0, target: 1 },
    layout: { source: { x: 0, y: 0, width: 200, height: 100 }, target: { x: 300, y: 1200, width: 200, height: 100 } },
    normals: messages, headerRefs: { current: {} }, contentRefs: { current: {} }, edges: [edge], messages,
    isTraceWindow: false, anonCorrectedRelMsgIds: new Set(), finalFrameRects: {}, traceExpandedFrameIds: new Set(),
    edgesByRelMsg: new Map([['reference', [edge]]]), labelBboxes: {}, comparisonSuppressedRelIds: new Set(), correctedEdgeIdsByRelMsg: new Map(),
    anchorCache: new Map([['target', { obstacles: [{ x: 10, y: 20, width: 180, height: 40 }], fragments: { 'reference::0:2': { x: 20, y: 25, width: 16, height: 14 } } }]]),
  };
  const before = measureGraphOverlays(input)!.positionedEdges[0].fragRectCanvas!;
  expect([before.x, before.y, before.width, before.height]).toEqual([320, 1225, 16, 14]);
  const after = measureGraphOverlays({ ...input, layout: { ...input.layout, target: { ...input.layout.target, y: 1800 } } })!.positionedEdges[0].fragRectCanvas!;
  expect([after.x, after.y, after.width, after.height]).toEqual([320, 1825, 16, 14]);
});
