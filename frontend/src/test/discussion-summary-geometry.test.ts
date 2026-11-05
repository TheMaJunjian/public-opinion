import { expect, it } from 'vitest';
import { layoutDiscussionSummaryEdges } from '../utils/discussionSummaryGeometry';
import { EDGE_LABEL_CLEARANCE,rectsIntersect } from '../utils/graphEdgeGeometry';
import type { DiscussionSummary } from '../utils/discussionSummaries';
import { curvePassesPoint,pathCrossesRect } from './graph-routing-fixtures';

const summary: DiscussionSummary = { region: { key: 'reply-region', type: 'reply', targetId: 'root', collapsed: false,
  directCount: 30, x: 420, y: 200, width: 320, height: 300, headerHeight: 24 }, edges: [], recordIds: [] };
const boxes = { root: { x: 0, y: 200, width: 320, height: 200 } };
const obstacles = [boxes.root, { ...summary.region, height: summary.region.headerHeight }];

it.each([48, 190])('keeps the summary label clear of its tail and arrowhead at measured width %s', width => {
  const [edge] = layoutDiscussionSummaryEdges([summary], boxes, obstacles, { 'reply-region': { width, height: 14 } });
  const plate = { x: edge.labelBox.x - 6, y: edge.labelBox.y - 1, width: edge.labelBox.width + 12, height: edge.labelBox.height + 2 };
  for (const point of [edge.start, edge.end]) expect(rectsIntersect(plate, { x: point.x - 7, y: point.y - 7, width: 14, height: 14 })).toBe(false);
  for (const obstacle of obstacles) expect(rectsIntersect(plate, obstacle)).toBe(false);
  expect(edge.text).toBe('汇总回复');
  expect(curvePassesPoint(edge,edge.labelAnchor)).toBe(true);
  const clearance=Math.hypot(Math.max(plate.x-edge.labelAnchor.x,0,edge.labelAnchor.x-plate.x-plate.width),
    Math.max(plate.y-edge.labelAnchor.y,0,edge.labelAnchor.y-plate.y-plate.height));
  expect(clearance).toBeGreaterThanOrEqual(EDGE_LABEL_CLEARANCE-1e-6);
  expect(clearance).toBeLessThanOrEqual(EDGE_LABEL_CLEARANCE*Math.SQRT2+1e-6);
  expect(pathCrossesRect(edge,plate)).toBe(false);
  if (width > 100) expect(edge.labelY).not.toBe(edge.start.y);
});

it('keeps a displaced tag connected while retaining both original endpoints', () => {
  const [before]=layoutDiscussionSummaryEdges([summary],boxes,obstacles);
  const decoration={x:330,y:190,width:80,height:50};
  const [after]=layoutDiscussionSummaryEdges([summary],boxes,[...obstacles,decoration]);
  expect(after.start).toEqual(before.start);expect(after.end).toEqual(before.end);
  expect(after.ctrl).not.toEqual(before.ctrl);
  expect(curvePassesPoint(after,after.labelAnchor)).toBe(true);
  expect(pathCrossesRect(after,{x:after.labelBox.x-6,y:after.labelBox.y-1,width:after.labelBox.width+12,height:after.labelBox.height+2})).toBe(false);
  expect(rectsIntersect({x:after.labelBox.x-8,y:after.labelBox.y-6,width:after.labelBox.width+16,height:after.labelBox.height+12},decoration)).toBe(false);
});

it('uses a gentle curve even when the summary endpoints are horizontally aligned',()=>{
  const wide={...summary,region:{...summary.region,x:620}};
  const [edge]=layoutDiscussionSummaryEdges([wide],boxes,[boxes.root,{...wide.region,height:24}]);
  expect(edge.start.y).toBe(edge.end.y);
  expect(Math.abs(edge.ctrl.y-edge.start.y)).toBeGreaterThan(20);
  expect(pathCrossesRect(edge,boxes.root)).toBe(false);
  expect(curvePassesPoint(edge,edge.labelAnchor)).toBe(true);
  expect(curvePassesPoint(edge,{x:edge.labelX,y:edge.labelY})).toBe(false);
});

it('places neighboring summary labels without overlap and leaves an unknown target undrawn', () => {
  const other = { ...summary, region: { ...summary.region, key: 'agree-region', type: 'agree' as const, y: 224 } };
  const missing = { ...summary, region: { ...summary.region, key: 'missing', targetId: 'absent' } };
  const edges = layoutDiscussionSummaryEdges([summary, other, missing], boxes, obstacles);
  expect(edges).toHaveLength(2);
  expect(rectsIntersect(edges[0].labelBox, edges[1].labelBox)).toBe(false);
});
