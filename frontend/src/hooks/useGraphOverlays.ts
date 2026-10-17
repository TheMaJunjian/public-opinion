import { useEffect, useState } from 'react';
import type { MutableRefObject } from 'react';
import { emptyGraphOverlays, measureGraphOverlays } from '../utils/graphOverlays';
import type { GraphOverlayInput } from '../utils/graphOverlays';
import type { Rect } from '../utils/layout';
import { LABEL_BBOX_STABILITY_THRESHOLD } from '../utils/graphPresentationGeometry';
import { reportWorkbenchDrawingDuration } from '../utils/workbenchActivity';
type LabelBbox = Rect;

export function useGraphOverlays(input: Omit<GraphOverlayInput, 'labelBboxes'> & {
  textRefs: MutableRefObject<Record<string, SVGTextElement | null>>;
  actualCanvasWidth: number;
  actualCanvasHeight: number;
}) {
  const { canvasRef, normalIds, msgMap, relationCardMsgIds, cardRefs, colOf, layout, normals, headerRefs, contentRefs, edges, messages, isTraceWindow, anonCorrectedRelMsgIds, finalFrameRects, traceExpandedFrameIds, edgesByRelMsg, comparisonSuppressedRelIds, correctedEdgeIdsByRelMsg, textRefs, actualCanvasWidth, actualCanvasHeight } = input;
  const [overlays, setOverlays] = useState(emptyGraphOverlays);
  const [labelBboxes, setLabelBboxes] = useState<Record<string, LabelBbox>>({});
  const { positionedEdges } = overlays;
  useEffect(() => {
    const startedAt = performance.now();
    const measured = measureGraphOverlays({ canvasRef, normalIds, msgMap, relationCardMsgIds, cardRefs, colOf, layout, normals, headerRefs, contentRefs, edges, messages, isTraceWindow, anonCorrectedRelMsgIds, finalFrameRects, traceExpandedFrameIds, edgesByRelMsg, labelBboxes, comparisonSuppressedRelIds, correctedEdgeIdsByRelMsg });
    reportWorkbenchDrawingDuration(performance.now() - startedAt);
    if (measured) setOverlays(measured);
  }, [canvasRef, normalIds, msgMap, relationCardMsgIds, cardRefs, colOf, layout, normals, headerRefs, contentRefs, edges, messages, isTraceWindow, anonCorrectedRelMsgIds, finalFrameRects, traceExpandedFrameIds, edgesByRelMsg, labelBboxes, comparisonSuppressedRelIds, correctedEdgeIdsByRelMsg]);
  useEffect(() => {
    const canvasEl=canvasRef.current; if (!canvasEl) return;
    const canvasRect=canvasEl.getBoundingClientRect();
    const scaleX = canvasEl.offsetWidth > 0 ? canvasRect.width / canvasEl.offsetWidth : 1;
    const scaleY = canvasEl.offsetHeight > 0 ? canvasRect.height / canvasEl.offsetHeight : 1;
    const next: Record<string,LabelBbox>={};
    for (const pe of positionedEdges) {
      const t=textRefs.current[pe.drawId]; if (!t) continue;
      const r=t.getBoundingClientRect();
      next[pe.drawId]={
        x:(r.left-canvasRect.left)/scaleX,
        y:(r.top-canvasRect.top)/scaleY,
        width:r.width/scaleX,
        height:r.height/scaleY,
      };
    }
    // Use a functional update with a stability check to avoid infinite re-render cycles:
    // the main useEffect now depends on labelBboxes, so we must not update state when the
    // values haven't meaningfully changed (within 0.5px).
    setLabelBboxes(prev => {
      const prevKeys=Object.keys(prev), nextKeys=Object.keys(next);
      if (prevKeys.length!==nextKeys.length) return next;
      for (const k of nextKeys) {
        if (!prev[k]) return next;
        const p=prev[k], n=next[k];
        if (Math.abs(p.x-n.x)>LABEL_BBOX_STABILITY_THRESHOLD||Math.abs(p.y-n.y)>LABEL_BBOX_STABILITY_THRESHOLD||Math.abs(p.width-n.width)>LABEL_BBOX_STABILITY_THRESHOLD||Math.abs(p.height-n.height)>LABEL_BBOX_STABILITY_THRESHOLD) return next;
      }
      return prev;
    });
  }, [positionedEdges, actualCanvasWidth, actualCanvasHeight]);
  return { ...overlays, labelBboxes };
}
