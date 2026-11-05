import { describe, expect, it } from 'vitest';
import { routeGraphEdges } from '../utils/graphEdgeRouting';
import type { DemoMessage } from '../utils/modelBridge';
import { crossedNonEndpointCards, curvePassesPoint, longAnswerReplies, pathCrossesRect, pointOnRect, routingEdge, routingFixture } from './graph-routing-fixtures';

describe('final graph paths around sibling cards', () => {
  it.each([false,true])('curves aligned facing-side edges without entering the endpoint cards (mirror: %s)',mirror=>{
    const layout={source:{x:mirror?900:0,y:100,width:200,height:100},target:{x:mirror?0:900,y:100,width:200,height:100}};
    const [path]=routeGraphEdges(routingFixture(layout,[routingEdge('edge','source','target')]));
    expect(path.start.y).toBe(path.end.y);
    expect(Math.abs(path.ctrl.y-path.start.y)).toBeGreaterThan(20);
    expect(pathCrossesRect(path,layout.source)).toBe(false);
    expect(pathCrossesRect(path,layout.target)).toBe(false);
  });

  it('keeps a displaced ordinary tag attached at its edge without crossing its text', () => {
    const layout={source:{x:0,y:100,width:200,height:100},target:{x:900,y:100,width:200,height:100}};
    const input=routingFixture(layout,[routingEdge('edge','source','target')]);
    const [before]=routeGraphEdges(input);
    const decoration={x:200,y:100,width:700,height:100};
    const [after]=routeGraphEdges({...input,globalForbiddenRects:[...input.globalForbiddenRects,decoration]});
    expect(after.start).toEqual(before.start);expect(after.end).toEqual(before.end);
    expect(after.ctrl).not.toEqual(before.ctrl);
    expect(curvePassesPoint(after,after.labelAnchor!)).toBe(true);
    expect(pathCrossesRect(after,{x:after.labelX-21,y:after.labelY-8,width:42,height:16})).toBe(false);
    expect(crossedNonEndpointCards(after,layout)).toEqual([]);
  });

  it.each([{ mirror: false, sameColumn: false }, { mirror: true, sameColumn: false }, { mirror: false, sameColumn: true }, { mirror: true, sameColumn: true }])('keeps ten replies clear of earlier sibling cards (mirror: $mirror, same column index: $sameColumn)', options => {
      const fixture = longAnswerReplies(options), original = structuredClone(fixture.edges);
      const paths = routeGraphEdges(routingFixture(fixture.layout, fixture.edges, fixture));
      expect(paths).toHaveLength(10);
      for (const path of paths) {
        expect(curvePassesPoint(path,path.labelAnchor!)).toBe(true);
        expect(pathCrossesRect(path,{x:path.labelX-21,y:path.labelY-8,width:42,height:16}),path.drawId).toBe(false);
        expect(crossedNonEndpointCards(path, fixture.layout), path.drawId).toEqual([]);
        expect(pointOnRect(path.start, fixture.layout[path.edge.from.messageId])).toBe(true);
        expect(pointOnRect(path.end, fixture.layout.answer)).toBe(true);
      }
      expect(fixture.edges).toEqual(original);
    });

  it('keeps the narrowed physical gutter clear after the answer and reply cards become wider', () => {
    const fixture = longAnswerReplies();
    fixture.layout.answer.width = 440;
    fixture.layout['reply-4'].width = 760;
    const paths = routeGraphEdges(routingFixture(fixture.layout, fixture.edges, fixture));
    expect(paths).toHaveLength(10);
    for (const path of paths) expect(crossedNonEndpointCards(path, fixture.layout), path.drawId).toEqual([]);
  });

  it('does not let many unrelated edges bend existing replies into their own column', () => {
    const fixture = longAnswerReplies();
    for (let index = 0; index < 64; index++) {
      const target = `unrelated-target-${index}`, source = `unrelated-source-${index}`, y = 8000 + index * 200;
      fixture.layout[target] = { x: 1800, y, width: 280, height: 110 };
      fixture.layout[source] = { x: 2220, y, width: 300, height: 110 };
      fixture.columns[target] = 2; fixture.columns[source] = 3;
      fixture.edges.push(routingEdge(`unrelated-edge-${index}`, source, target));
    }
    const paths = routeGraphEdges(routingFixture(fixture.layout, fixture.edges, fixture));
    expect(paths).toHaveLength(74);
    for (const path of paths.filter(value => value.edge.to.messageId === 'answer')) {
      expect(crossedNonEndpointCards(path, fixture.layout), path.drawId).toEqual([]);
    }
  });

  it('keeps valid boundary anchors for support above and opposition below a target in the same column', () => {
    const layout = { support: { x: 40, y: 40, width: 360, height: 180 }, target: { x: 40, y: 400, width: 480, height: 240 }, opposition: { x: 40, y: 820, width: 400, height: 180 } };
    const edges = [routingEdge('support-edge', 'support', 'target', 'agree'), routingEdge('opposition-edge', 'opposition', 'target', 'disagree')];
    const paths = routeGraphEdges(routingFixture(layout, edges));
    expect(paths).toHaveLength(2);
    for (const path of paths) {
      expect(pointOnRect(path.start, path.fromBox)).toBe(true);
      expect(pointOnRect(path.end, path.toBox)).toBe(true);
      expect([path.start, path.ctrl, path.end].every(point => Number.isFinite(point.x) && Number.isFinite(point.y))).toBe(true);
      expect(crossedNonEndpointCards(path, layout), path.drawId).toEqual([]);
    }
  });
});

describe('routing preserves original endpoint evidence', () => {
  it('keeps the exact cached text fragment, reference fields and original edge IDs', () => {
    const layout = { source: { x: 520, y: 900, width: 360, height: 160 }, target: { x: 40, y: 40, width: 360, height: 1400 } };
    const edge = routingEdge('fragment-edge', 'source', 'target', 'reference');
    edge.to = { messageId: 'target', selection: { kind: 'text', start: 1, len: 2, text: '😀' },
      reference: { messageId: 'target', revision: 3, partId: 'body', range: { start: 1, end: 3 } } };
    const fragment = { x: 80, y: 1100, width: 36, height: 18 }, original = structuredClone(edge);
    const [path] = routeGraphEdges(routingFixture(layout, [edge], { columns: { source: 1, target: 0 }, fragments: { target: { 'reference::1:3': fragment } } }));
    expect(path.edge).toBe(edge);
    expect(path.edge).toEqual(original);
    expect(path.drawId).toBe('fragment-edge');
    expect(path.fragRectCanvas).toMatchObject(fragment);
    expect(pointOnRect(path.end, fragment)).toBe(true);
  });

  it('targets the existing relation label without replacing its original target with the underlying answer', () => {
    const layout = { source: { x: 520, y: 700, width: 360, height: 160 }, answer: { x: 40, y: 40, width: 360, height: 1400 }, previousSource: { x: 520, y: 60, width: 320, height: 160 } };
    const previous = routingEdge('previous-edge', 'previousSource', 'answer'), next = routingEdge('relation-target-edge', 'source', previous.relationMessageId, 'reference');
    const record: DemoMessage = { id: previous.relationMessageId, kind: 'relation', relationType: 'reply', content: '', author: 'relation-fixture', createdAt: '' };
    const label = { x: 430, y: 550, width: 60, height: 22 }, original = structuredClone(next);
    const paths = routeGraphEdges(routingFixture(layout, [previous, next], { messages: [record], columns: { source: 1, answer: 0, previousSource: 1 }, labelBboxes: { [previous.id]: label } }));
    const path = paths.find(value => value.edge.id === next.id)!;
    expect(path).toBeDefined();
    expect(path.edge).toEqual(original);
    expect(path.edge.to.messageId).toBe(previous.relationMessageId);
    expect(path.toBox).toEqual(label);
    expect(pointOnRect(path.end, label)).toBe(true);
    expect(path.drawId).toBe(`${next.id}__toRel__${previous.relationMessageId}`);
  });

  it('detects a thin interior crossing while permitting a boundary-only touch in the geometry oracle', () => {
    const path = { start: { x: 0, y: 0 }, ctrl: { x: 50, y: 100 }, end: { x: 100, y: 0 } };
    expect(pathCrossesRect(path, { x: 49.9, y: 49.9, width: 0.2, height: 0.2 })).toBe(true);
    expect(pathCrossesRect(path, { x: 40, y: 50, width: 20, height: 20 })).toBe(false);
  });
});
