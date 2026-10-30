import { useId } from 'react';
import { CLOUD_CORNER } from './StakeTierBadge';

type Point = { x: number; y: number };
type Box = Point & { width: number; height: number };

/** Decorative SVG siblings follow the actual geometry; hit areas and endpoints stay with GraphView. */
export function EdgeSkin({ path, start, end, ctrl }: { path: string; start: Point; end: Point; ctrl: Point }) {
  const id = useId();
  const angle = Math.atan2(end.y - ctrl.y, end.x - ctrl.x) * 180 / Math.PI;
  return <g className="skin-edge-art" aria-hidden="true" pointerEvents="none">
    <path id={id} className="skin-edge-core" d={path} fill="none" />
    <text className="skin-edge-braid" dy="2"><textPath href={`#${id}`} startOffset="12%">{'›\u3000'.repeat(11)}›</textPath></text>
    <circle className="skin-edge-origin" cx={start.x} cy={start.y} r={4} />
    <path className="skin-edge-tip" transform={`translate(${end.x} ${end.y}) rotate(${angle})`} d="M-15 -7 L0 0 L-15 7 L-11 0 Z" />
  </g>;
}

export function EdgeLabelSkin({ box }: { box: Box }) {
  const { x, y, width, height } = box;
  return <g className="skin-edge-label-art" aria-hidden="true" pointerEvents="none">
    <rect className="skin-label-inner" x={x - 3} y={y + 2} width={width + 6} height={Math.max(1, height - 4)} rx={1} />
    {[x - 9, x + width + 3].map(left => <rect key={left} className="skin-scroll-knob" x={left} y={y - 4} width={6} height={height + 8} rx={1} />)}
  </g>;
}

export function FrameSkin({ box }: { box: Box }) {
  const id = useId();
  const { x, y, width, height } = box;
  return <g className="skin-frame-art" aria-hidden="true" pointerEvents="none">
    <defs><pattern id={id} width={8} height={8} patternUnits="userSpaceOnUse">
      <rect width={8} height={8} className="skin-frame-weave-base" />
      <path d="M0 0L8 8M8 0L0 8" className="skin-frame-weave-thread" fill="none" />
    </pattern></defs>
    <rect className="skin-frame-mount" x={x + 2} y={y + 2} width={Math.max(0, width - 4)} height={Math.max(0, height - 4)} fill="none" stroke={`url(#${id})`} />
    <rect className="skin-frame-seam" x={x + 8} y={y + 8} width={Math.max(0, width - 16)} height={Math.max(0, height - 16)} fill="none" />
    {[[x, y, 0], [x + width, y, 90], [x + width, y + height, 180], [x, y + height, 270]].map(([cx, cy, rotation], i) =>
      <g key={i} transform={`translate(${cx} ${cy}) rotate(${rotation})`}><path className="skin-frame-cloud" d={CLOUD_CORNER} /><path className="skin-frame-armor" d="M0 34V0H34V8H8V34Z" /></g>)}
  </g>;
}
