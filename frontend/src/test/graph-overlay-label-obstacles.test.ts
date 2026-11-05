import { expect, it } from 'vitest';
import { measureGraphOverlays, type GraphOverlayInput, type PositionedEdge } from '../utils/graphOverlays';
import { labelRectApprox, rectsIntersect } from '../utils/graphEdgeGeometry';
import { EDGE_HINT_W, EDGE_LABEL_HINT_GAP } from '../utils/graphPresentationGeometry';
import type { DemoMessage, DemoEdge } from '../utils/modelBridge';
import type { Rect } from '../utils/layout';

// Structural geometry only: no fabricated discussion text or mounted message bodies.
function input(mountedEndpoints: boolean): GraphOverlayInput {
  const cards: DemoMessage[] = ['source', 'target'].map(id => ({ id, kind: 'normal', content: '', author: '', createdAt: '' }));
  const messages: DemoMessage[] = [...cards, { id: 'record', kind: 'relation', relationType: 'reference', content: '', author: '', createdAt: '' }];
  const edge: DemoEdge = { id: 'edge', relationMessageId: 'record', relationType: 'reference', relationLabel: 'reference',
    from: { messageId: 'source', selection: { kind: 'whole' } }, to: { messageId: 'target', selection: { kind: 'whole' } } };
  const layout = { source: { x: 0, y: 100, width: 200, height: 100 }, target: { x: 900, y: 100, width: 200, height: 100 } };
  const refs: Record<string, HTMLDivElement> = {};
  if (mountedEndpoints) for (const id of ['source', 'target'] as const) {
    const element = document.createElement('div'), box = layout[id];
    const rectangle = new DOMRect(box.x, box.y, box.width, box.height);
    element.getBoundingClientRect = () => rectangle;
    element.getClientRects = () => [rectangle] as unknown as DOMRectList;
    refs[id] = element;
  }
  return { canvasRef: { current: document.createElement('div') }, normalIds: cards.map(card => card.id), normals: cards, messages,
    msgMap: new Map(messages.map(message => [message.id, message])), relationCardMsgIds: new Set(), edges: [edge],
    colOf: { source: 0, target: 2 }, layout, cardRefs: { current: refs }, headerRefs: { current: {} }, contentRefs: { current: {} },
    isTraceWindow: false, anonCorrectedRelMsgIds: new Set(), finalFrameRects: {}, traceExpandedFrameIds: new Set(),
    edgesByRelMsg: new Map([['record', [edge]]]), labelBboxes: {}, comparisonSuppressedRelIds: new Set(), correctedEdgeIdsByRelMsg: new Map() };
}

function labelFootprint(edge: PositionedEdge): Rect {
  const label = labelRectApprox(edge.labelX, edge.labelY, edge.edgeLabelText);
  return { ...label, width: label.width + EDGE_LABEL_HINT_GAP + EDGE_HINT_W };
}

it.each([true, false])('avoids an unmounted third card using its complete scene box (endpoint DOM mounted: %s)', mountedEndpoints => {
  const original = input(mountedEndpoints);
  const before = measureGraphOverlays(original)!.positionedEdges[0];
  const blocker: Rect = { x: before.labelX - 80, y: before.labelY - 50, width: 160, height: 100 };
  expect(rectsIntersect(labelFootprint(before), blocker)).toBe(true);
  const third: DemoMessage = { id: 'virtual-card', kind: 'normal', content: '', author: '', createdAt: '' };
  const withObstacle: GraphOverlayInput = { ...original, normals: [...original.normals, third], normalIds: [...original.normalIds, third.id],
    messages: [...original.messages, third], msgMap: new Map([...original.msgMap, [third.id, third]]),
    layout: { ...original.layout, [third.id]: blocker }, colOf: { ...original.colOf, [third.id]: 1 },
    // A tiny cached body measurement must not replace the whole card/padding as an obstacle.
    anchorCache: new Map([[third.id, { obstacles: [{ x: 0, y: 0, width: 1, height: 1 }], fragments: {} }]]) };
  const sourceSnapshot = JSON.stringify({ messages: withObstacle.messages, edges: withObstacle.edges, layout: withObstacle.layout });
  expect(withObstacle.cardRefs.current[third.id]).toBeUndefined();
  expect(withObstacle.headerRefs.current).toEqual({}); expect(withObstacle.contentRefs.current).toEqual({});
  if (!mountedEndpoints) expect(withObstacle.cardRefs.current).toEqual({});

  const after = measureGraphOverlays(withObstacle)!.positionedEdges[0];
  expect(rectsIntersect(labelFootprint(after), blocker)).toBe(false);
  expect({ x: after.labelX, y: after.labelY }).not.toEqual({ x: before.labelX, y: before.labelY });
  expect(after.start).toEqual(before.start); expect(after.end).toEqual(before.end);
  expect(after.edge).toBe(original.edges[0]);
  expect(after.drawId).toBe(before.drawId);
  expect(JSON.stringify({ messages: withObstacle.messages, edges: withObstacle.edges, layout: withObstacle.layout })).toBe(sourceSnapshot);
});
