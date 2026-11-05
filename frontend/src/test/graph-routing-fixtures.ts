import type { GraphRoutingInput } from '../utils/graphEdgeRouting';
import { quadAt, type Point } from '../utils/graphEdgeGeometry';
import type { PositionedEdge } from '../utils/graphOverlays';
import type { DemoEdge, DemoMessage } from '../utils/modelBridge';
import type { Rect } from '../utils/layout';

export const routingEdge = (id: string, source: string, target: string, relationType: DemoEdge['relationType'] = 'reply'): DemoEdge => ({
  id, relationMessageId: `record:${id}`, relationType, relationLabel: relationType,
  from: { messageId: source, selection: { kind: 'whole' } }, to: { messageId: target, selection: { kind: 'whole' } },
});

/** Structural rectangles only: no generated discussion, mounted cards or real data. */
export function routingFixture(layout: Record<string, Rect>, edges: DemoEdge[], options: {
  columns?: Record<string, number>; messages?: DemoMessage[]; labelBboxes?: Record<string, Rect>;
  fragments?: Record<string, Record<string, Rect>>;
} = {}): GraphRoutingInput {
  const msgMap = new Map<string, DemoMessage>(Object.keys(layout).map(id => [id, { id, kind: 'normal', content: '', author: 'geometry-fixture', createdAt: '' }]));
  for (const message of options.messages ?? []) msgMap.set(message.id, message);
  const edgesByRelMsg = new Map<string, DemoEdge[]>();
  for (const edge of edges) { const own = edgesByRelMsg.get(edge.relationMessageId) ?? []; own.push(edge); edgesByRelMsg.set(edge.relationMessageId, own); }
  const colOf = options.columns ?? Object.fromEntries(Object.keys(layout).map(id => [id, 0]));
  return {
    newTagDecorationsByMsg: {}, edgesByRelMsg, endpointBoxForNormal: id => layout[id] ? { box: layout[id], col: colOf[id] ?? 0 } : null,
    layout, relationCardMsgIds: new Set(), frameByRelMsgId: new Map(), groupFrameByRelMsgId: new Map(), msgMap,
    labelBboxes: options.labelBboxes ?? {}, relDecByRelMsgId: new Map(), decorationRects: {}, edges,
    comparisonSuppressedRelIds: new Set(), colOf, correctedEdgeIdsByRelMsg: new Map(), normalSet: new Set(Object.keys(layout)),
    contentRefs: { current: {} }, toCanvasRect: rect => ({ x: rect.x, y: rect.y, width: rect.width, height: rect.height }),
    getMessageRects: id => layout[id] ? [layout[id]] : [],
    sampleQuad: (start, control, end, count = 40) => Array.from({ length: count + 1 }, (_, index) => quadAt(start, control, end, index / count)),
    penScore: (samples, rectangles) => samples.filter(point => rectangles.some(rect => pointInsideRect(point, rect))).length,
    globalForbiddenRects: Object.values(layout), getCachedFragment: (messageId, key) => options.fragments?.[messageId]?.[key],
  };
}

export function longAnswerReplies({ mirror = false, sameColumn = false, count = 10 } = {}) {
  const layout: Record<string, Rect> = { answer: { x: 40, y: 40, width: 360, height: 1400 } }, columns: Record<string, number> = { answer: 0 };
  const edges: DemoEdge[] = [];
  for (let index = 0; index < count; index++) {
    const id = `reply-${index}`;
    layout[id] = { x: 520, y: 80 + index * 240, width: index % 3 === 1 ? 500 : 320, height: 130 + index % 3 * 30 };
    columns[id] = 1; edges.push(routingEdge(`edge-${index}`, id, 'answer'));
  }
  if (mirror) for (const [id, rect] of Object.entries(layout)) { rect.x = 1100 - rect.x - rect.width; columns[id] = 1 - columns[id]; }
  if (sameColumn) for (const id of Object.keys(columns)) columns[id] = 0;
  return { layout, edges, columns };
}

export function pointInsideRect(point: Point, rect: Rect, epsilon = 1e-6) {
  return point.x > rect.x + epsilon && point.x < rect.x + rect.width - epsilon
    && point.y > rect.y + epsilon && point.y < rect.y + rect.height - epsilon;
}

export function pointOnRect(point: Point, rect: Rect, epsilon = 1e-5) {
  return point.x >= rect.x - epsilon && point.x <= rect.x + rect.width + epsilon
    && point.y >= rect.y - epsilon && point.y <= rect.y + rect.height + epsilon
    && (Math.abs(point.x - rect.x) <= epsilon || Math.abs(point.x - rect.x - rect.width) <= epsilon
      || Math.abs(point.y - rect.y) <= epsilon || Math.abs(point.y - rect.y - rect.height) <= epsilon);
}

/** Solve a coordinate of the rendered quadratic, then verify the other one. */
export function curvePassesPoint(path: Pick<PositionedEdge, 'start' | 'ctrl' | 'end'>, point: Point, epsilon = 1e-6) {
  const axis = (['x','y'] as const).find(axis => Math.abs(path.start[axis]-path.ctrl[axis])+Math.abs(path.ctrl[axis]-path.end[axis])>epsilon);
  if (!axis) return Math.hypot(path.start.x-point.x,path.start.y-point.y)<epsilon;
  const a=path.start[axis]-2*path.ctrl[axis]+path.end[axis],b=2*(path.ctrl[axis]-path.start[axis]),c=path.start[axis]-point[axis];
  const discriminant=b*b-4*a*c;
  const roots=Math.abs(a)<epsilon?[-c/b]:discriminant<0?[]:[(-b-Math.sqrt(discriminant))/(2*a),(-b+Math.sqrt(discriminant))/(2*a)];
  return roots.some(t=>t>=0&&t<=1&&Math.hypot(quadAt(path.start,path.ctrl,path.end,t).x-point.x,quadAt(path.start,path.ctrl,path.end,t).y-point.y)<epsilon);
}

/** Split the final quadratic at rectangle-boundary crossings, then sample each
 * open interval. A thin crossing cannot fall between an arbitrary fixed grid. */
export function pathCrossesRect(path: Pick<PositionedEdge, 'start' | 'ctrl' | 'end'>, rect: Rect) {
  const roots: number[] = [0, 1];
  const solve = (start: number, control: number, end: number, boundary: number) => {
    const a = start - 2 * control + end, b = 2 * (control - start), c = start - boundary;
    if (Math.abs(a) < 1e-10) { if (Math.abs(b) > 1e-10) roots.push(-c / b); return; }
    const discriminant = b * b - 4 * a * c;
    if (discriminant < 0) return;
    const distance = Math.sqrt(discriminant);
    roots.push((-b - distance) / (2 * a), (-b + distance) / (2 * a));
  };
  for (const value of [rect.x, rect.x + rect.width]) solve(path.start.x, path.ctrl.x, path.end.x, value);
  for (const value of [rect.y, rect.y + rect.height]) solve(path.start.y, path.ctrl.y, path.end.y, value);
  const times = [...new Set(roots.filter(value => value >= 0 && value <= 1))].sort((a, b) => a - b);
  for (let index = 1; index < times.length; index++) {
    if (pointInsideRect(quadAt(path.start, path.ctrl, path.end, (times[index - 1] + times[index]) / 2), rect)) return true;
  }
  return false;
}

export function crossedNonEndpointCards(path: PositionedEdge, layout: Record<string, Rect>) {
  return Object.entries(layout).filter(([id, rect]) => id !== path.edge.from.messageId && id !== path.edge.to.messageId && pathCrossesRect(path, rect)).map(([id]) => id);
}
