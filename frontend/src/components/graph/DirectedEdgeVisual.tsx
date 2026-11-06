import type { CSSProperties, Ref } from 'react';
import type { Point } from '../../utils/graphEdgeGeometry';
import type { Box } from '../../utils/frameLayout';
import { EdgeLabelSkin, EdgeSkin } from '../../theme/GraphSkin';

export function directedEdgeColor(type: string): string {
  return ({ annotation: 'var(--graph-label-annotation)', reference: 'var(--ink-rgba-80-180-255-0-92)',
    reply: 'var(--ink-rgba-160-255-140-0-72)', agree: 'var(--ink-rgba-2-170-90-0-92)',
    disagree: 'var(--ink-rgba-210-50-50-0-92)', recommend: 'var(--ink-fbbf24)', archive: 'var(--ink-94a3b8)' } as Record<string, string>)[type]
    ?? 'var(--ink-rgba-120-120-120-0-72)';
}

/** Shared native drawing for ordinary relations and view-only summaries. */
export default function DirectedEdgeVisual({ layer, relationType, start, ctrl, end, text, labelX, labelY, labelBox,
  color, strokeWidth, opacity = 0.9, hidden = false, dashed = false, selection, textRef }: {
  layer: 'paths' | 'labels'; relationType: string; start: Point; ctrl: Point; end: Point; text: string;
  labelX: number; labelY: number; labelBox?: Box; color: string; strokeWidth: number;
  opacity?: number; hidden?: boolean; dashed?: boolean; textRef?: Ref<SVGTextElement>;
  selection?: 'whole' | 'fragment';
}) {
  const paint=selection==='whole'?'var(--edge-selection-accent, var(--selection-accent))':selection==='fragment'?'var(--edge-fragment-accent, var(--fragment-accent))':color;
  // Annotation keeps its own hue even when a decorative skin paints the edge.
  const colorOverride=selection||relationType==='annotation'?paint:undefined;
  const path = `M ${start.x} ${start.y} Q ${ctrl.x} ${ctrl.y} ${end.x} ${end.y}`;
  const angle = Math.atan2(end.y - ctrl.y, end.x - ctrl.x), length = 7, spread = Math.PI / 7;
  const ax1 = end.x - length * Math.cos(angle - spread), ay1 = end.y - length * Math.sin(angle - spread);
  const ax2 = end.x - length * Math.cos(angle + spread), ay2 = end.y - length * Math.sin(angle + spread);
  const plate=labelBox?{x:labelBox.x-6,y:labelBox.y-1,width:labelBox.width+12,height:labelBox.height+2}:undefined;
  if (layer === 'paths') return hidden ? null : <>
    <path className="relation-edge-path" d={path} stroke={paint} style={colorOverride?{stroke:colorOverride}:undefined} strokeWidth={strokeWidth} fill="none" strokeDasharray={dashed ? '6 3' : undefined} />
    <path className="relation-edge-arrow" d={`M ${ax1} ${ay1} L ${end.x} ${end.y} L ${ax2} ${ay2}`} fill={paint} style={colorOverride?{fill:colorOverride}:undefined}/>
    <EdgeSkin path={path} start={start} end={end} ctrl={ctrl} color={colorOverride}/>
  </>;
  return <>
    {!hidden && plate && <rect className="graph-edge-label-plate" aria-hidden="true"
      {...plate} rx={3} style={{display:'block',fill:selection==='whole'?'var(--edge-selection-bg, var(--selection-bg))':selection==='fragment'?'var(--edge-fragment-bg, var(--fragment-bg))':'var(--surface-141414)',fillOpacity:0.96,stroke:paint,strokeWidth:selection?2:0.8}} />}
    {!hidden && labelBox && <EdgeLabelSkin box={labelBox} color={colorOverride}/>}
    <text className="graph-edge-label-text" ref={textRef} x={labelX} y={labelY} fill={paint} opacity={hidden ? 0 : opacity}
      fontSize="var(--graph-label-size)" textAnchor="middle" dominantBaseline="central"
      style={{ paintOrder: 'stroke', stroke: 'var(--graph-label-outline)', strokeWidth: 2, whiteSpace: 'pre',...(colorOverride?{fill:colorOverride}:{}) } as CSSProperties}>{text}</text>
  </>;
}
