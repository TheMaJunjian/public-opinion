import { useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import type { DemoMessage, UnitSelection } from '../../utils/modelBridge';
import type { DiscussionSummary } from '../../utils/discussionSummaries';
import { layoutDiscussionSummaryEdges, type SummaryLabelMetrics } from '../../utils/discussionSummaryGeometry';
import type { Box } from '../../utils/frameLayout';
import { discussionLabels } from '../../utils/discussionTypes';
import { GRAPH_EDGE_LABEL_LAYER, GRAPH_EDGE_PATH_LAYER } from '../../utils/graphPresentationGeometry';
import { useTheme } from '../../theme/theme';
import CrossCanvasRelatedMessages from '../CrossCanvasRelatedMessages';
import DirectedEdgeVisual, { directedEdgeColor } from './DirectedEdgeVisual';
import { clipFrameScene } from './FrameViewport';

/** View-only summaries share the ordinary edge geometry, paint and hit area. */
export default function DiscussionSummaries({ summaries, boxes, labelObstacles = [], messages, selectedUnits, highlightedMessageIds, onView, hiddenRelationIds, onToggleRelationVisibility, clipFor, width, height }: {
  summaries: readonly DiscussionSummary[]; boxes: Readonly<Record<string, Box>>; labelObstacles?: readonly Box[];
  messages: ReadonlyMap<string, DemoMessage>; selectedUnits: readonly UnitSelection[];
  highlightedMessageIds?: ReadonlySet<string>;
  onView?: (id: string) => void; clipFor: (id: string) => Box | undefined; width: number; height: number;
  hiddenRelationIds?: ReadonlySet<string>; onToggleRelationVisibility?: (id: string) => void;
}) {
  const theme = useTheme(), textRefs = useRef<Record<string, SVGTextElement | null>>({});
  const [metrics, setMetrics] = useState<SummaryLabelMetrics>({});
  const [expandedSummaries, setExpandedSummaries] = useState<ReadonlySet<string>>(() => new Set());
  const changeExpanded = (key: string, expanded: boolean) => setExpandedSummaries(previous => {
    if (previous.has(key) === expanded) return previous;
    const next = new Set(previous);
    if (expanded) next.add(key); else next.delete(key);
    return next;
  });
  const connectors = useMemo(() => layoutDiscussionSummaryEdges(summaries, boxes, labelObstacles, metrics), [summaries, boxes, labelObstacles, metrics]);
  useLayoutEffect(() => {
    const measured: Record<string, { width: number; height: number }> = {};
    for (const { region } of connectors) {
      const element = textRefs.current[region.key];
      if (!element) continue;
      try {
        const box = element.getBBox();
        if (Number.isFinite(box.width) && Number.isFinite(box.height) && box.width > 0 && box.height > 0) measured[region.key] = { width: box.width, height: box.height };
      } catch { /* Hidden SVG labels retain their last measured metrics. */ }
    }
    setMetrics(previous => {
      let next = previous;
      for (const [key, value] of Object.entries(measured)) {
        const old = previous[key];
        if (old && Math.abs(old.width - value.width) < 0.5 && Math.abs(old.height - value.height) < 0.5) continue;
        if (next === previous) next = { ...previous };
        (next as Record<string, { width: number; height: number }>)[key] = value;
      }
      return next;
    });
  }, [connectors, theme]);
  if (!connectors.length) return null;
  return <>
    {(['paths', 'labels'] as const).map(layer => <svg key={layer} data-discussion-summary-layer={layer} width={width} height={height}
      style={{ position: 'absolute', left: 0, top: 0, zIndex: layer === 'paths' ? GRAPH_EDGE_PATH_LAYER : GRAPH_EDGE_LABEL_LAYER, pointerEvents: 'none', overflow: 'visible' }}>
      {connectors.map(({ region, start, ctrl, end, text, labelX, labelY, labelBox }) => clipFrameScene(
        <g key={region.key} className="graph-edge-label" data-discussion-summary-edge={layer === 'paths' ? region.key : undefined}
          data-discussion-summary-text={layer === 'labels' ? region.key : undefined} data-relation-type={region.type} data-label-hidden="false"
          data-label-selection={expandedSummaries.has(region.key) ? 'whole' : undefined}
          data-jump-visual-msgids={region.targetId} style={{ '--edge-base-width': region.type === 'reply' ? '1px' : '1.2px' } as CSSProperties}>
          <DirectedEdgeVisual layer={layer} relationType={region.type} start={start} ctrl={ctrl} end={end} text={text} labelX={labelX} labelY={labelY} labelBox={labelBox}
            color={directedEdgeColor(region.type)} strokeWidth={region.type === 'reply' ? 1 : 1.2} opacity={expandedSummaries.has(region.key) ? 1 : region.type === 'reply' ? 0.65 : 0.9}
            selection={expandedSummaries.has(region.key) ? 'whole' : undefined}
            textRef={element => { textRefs.current[region.key] = element; }} />
        </g>, clipFor, true))}
    </svg>)}
    {connectors.map(({ region, recordIds, labelBox, text }) => clipFrameScene(
      <div key={region.key} data-jump-visual-msgids={region.targetId} data-discussion-summary-label={region.key} data-system-summary="true" data-rel-overlay="true"
        data-label-selection={expandedSummaries.has(region.key) ? 'whole' : undefined}
        title={`${text}：${recordIds.length}条关系；点击查看原关系`}
        style={{ position: 'absolute', left: labelBox.x - 8, top: labelBox.y - 6, width: labelBox.width + 16, height: labelBox.height + 12,
          zIndex: 13, pointerEvents: 'auto' }}>
        <CrossCanvasRelatedMessages groups={{ outgoing: {}, incoming: { [discussionLabels[region.type]]: recordIds } }} messages={messages}
          selectedUnits={selectedUnits} highlightedMessageIds={highlightedMessageIds} onView={onView} summarizedRelationIds={new Set(recordIds)} hiddenRelationIds={hiddenRelationIds ?? new Set(recordIds)}
          onToggleRelationVisibility={onToggleRelationVisibility} triggerLabel={`${text}：${recordIds.length}`} hideTriggerText
          onExpandedChange={expanded => changeExpanded(region.key, expanded)}
          triggerClassName="graph-edge-label-hit" triggerStyle={{ position: 'absolute', inset: 0, width: '100%', height: '100%',
            background: 'transparent', border: '1px solid transparent', borderRadius: 6, boxShadow: 'none' }} />
      </div>, clipFor))}
  </>;
}
