import type { DiscussionSummary } from './discussionSummaries';
import type { Box } from './frameLayout';
import { discussionLabels } from './discussionTypes';
import { computeLabelPlacementsAlongCurve, attachLabelToCurve, curvedEdgeControl, type LabelSeed } from './graphEdgeGeometry';

export type SummaryLabelMetrics = Readonly<Record<string, { width: number; height: number }>>;

/** Reuse native label placement, reserving a visible tail and arrowhead. */
export function layoutDiscussionSummaryEdges(summaries: readonly DiscussionSummary[], boxes: Readonly<Record<string, Box>>,
  obstacles: readonly Box[] = [], metrics: SummaryLabelMetrics = {}) {
  const connectors = summaries.flatMap(summary => {
    const { region } = summary, target = boxes[region.targetId];
    if (!target) return [];
    const start = { x: region.x, y: region.y + region.headerHeight / 2 };
    const end = { x: target.x + target.width, y: Math.max(target.y + 10, Math.min(start.y, target.y + target.height - 10)) };
    const ctrl = curvedEdgeControl(start,end,true);
    const text = `汇总${discussionLabels[region.type]}`;
    const metric = metrics[region.key] ?? { width: text.length * 12, height: 14 };
    return [{ ...summary, start, ctrl, end, text, metric }];
  });
  const seeds: LabelSeed[] = connectors.map(({ region, start, ctrl, end, text, metric }) => ({
    drawId: region.key, text, p0: start, p1: ctrl, p2: end, measuredWidth: metric.width, measuredHeight: metric.height,labelPlacement:'edge',
  }));
  const endpointRects = connectors.flatMap(({ start, end }) => [start, end].map(point => ({ x: point.x - 10, y: point.y - 9, width: 20, height: 18 })));
  const labels = computeLabelPlacementsAlongCurve({ seeds, forbiddenRects: [...obstacles, ...endpointRects] });
  return connectors.map((connector,index) => {
    const label = labels[connector.region.key];
    const attached=attachLabelToCurve(seeds[index],label,obstacles);
    return { ...connector, ctrl:attached.ctrl,labelAnchor:attached.anchor, labelX: label.x, labelY: label.y,
      labelBox: { x: label.x - connector.metric.width / 2, y: label.y - connector.metric.height / 2,
        width: connector.metric.width, height: connector.metric.height } };
  });
}
