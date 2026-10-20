import { useLayoutEffect, useRef, useState } from 'react';
import type { MutableRefObject } from 'react';
import { emptyGraphOverlays, measureGraphOverlays } from '../utils/graphOverlays';
import type { GraphOverlayInput } from '../utils/graphOverlays';
import type { Rect } from '../utils/layout';
import { LABEL_BBOX_STABILITY_THRESHOLD } from '../utils/graphPresentationGeometry';
import { reportWorkbenchDrawingDuration } from '../utils/workbenchActivity';
import { useWorkbenchDrawingTask } from '../context/WorkbenchDrawingContext';
import type { GraphAnchorCache } from '../utils/graphAnchorCache';
type LabelBbox = Rect;

export function useGraphOverlays(input: Omit<GraphOverlayInput, 'labelBboxes'> & {
  textRefs: MutableRefObject<Record<string, SVGTextElement | null>>;
  actualCanvasWidth: number;
  actualCanvasHeight: number;
  pendingMeasurements?: boolean;
}) {
  const startOverlays = useWorkbenchDrawingTask('overlays');
  const { canvasRef, normalIds, msgMap, relationCardMsgIds, cardRefs, colOf, layout, normals, headerRefs, contentRefs, edges, messages, isTraceWindow, anonCorrectedRelMsgIds, finalFrameRects, traceExpandedFrameIds, edgesByRelMsg, comparisonSuppressedRelIds, correctedEdgeIdsByRelMsg, textRefs, actualCanvasWidth, actualCanvasHeight } = input;
  const [overlays, setOverlays] = useState(emptyGraphOverlays);
  const [labelBboxes, setLabelBboxes] = useState<Record<string, LabelBbox>>({});
  const anchorCache = useRef<GraphAnchorCache>(new Map());
  // Capture only mounted cards, but retain fragment/collision anchors for their
  // offscreen counterparts. Routing must not depend on the current DOM window.
  useLayoutEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const bounds = canvas.getBoundingClientRect();
    const scaleX = canvas.offsetWidth ? bounds.width / canvas.offsetWidth || 1 : 1;
    const scaleY = canvas.offsetHeight ? bounds.height / canvas.offsetHeight || 1 : 1;
    for (const [id, card] of Object.entries(cardRefs.current)) {
      if (!card || !canvas.contains(card)) continue;
      const origin = card.getBoundingClientRect();
      if (origin.width <= 1 || origin.height <= 1) continue;
      const relative = (rect: DOMRect): Rect => ({ x: (rect.left - origin.left) / scaleX, y: (rect.top - origin.top) / scaleY,
        width: rect.width / scaleX, height: rect.height / scaleY });
      const elements = [headerRefs.current[id], contentRefs.current[id]].filter((element): element is HTMLDivElement => !!element);
      const obstacles = (elements.length ? elements : [card]).flatMap(element => Array.from(element.getClientRects(), relative));
      const fragments = Object.fromEntries(Array.from(contentRefs.current[id]?.querySelectorAll<HTMLElement>('[data-rel-anchor]') ?? [],
        element => [element.dataset.relAnchor!, relative(element.getBoundingClientRect())]));
      anchorCache.current.set(id, { obstacles, fragments });
    }
    for (const id of anchorCache.current.keys()) if (!msgMap.has(id)) anchorCache.current.delete(id);
  });
  const { positionedEdges } = overlays;
  useLayoutEffect(() => {
    const task = startOverlays();
    task.run(() => {
      const startedAt = performance.now();
      const measured = measureGraphOverlays({ canvasRef, normalIds, msgMap, relationCardMsgIds, cardRefs, colOf, layout, normals, headerRefs, contentRefs, edges, messages, isTraceWindow, anonCorrectedRelMsgIds, finalFrameRects, traceExpandedFrameIds, edgesByRelMsg, labelBboxes, comparisonSuppressedRelIds, correctedEdgeIdsByRelMsg, anchorCache: anchorCache.current, skipRouting: input.pendingMeasurements });
      reportWorkbenchDrawingDuration(performance.now() - startedAt);
      if (measured) setOverlays(measured);
      task.complete();
    });
  }, [canvasRef, normalIds, msgMap, relationCardMsgIds, cardRefs, colOf, layout, normals, headerRefs, contentRefs, edges, messages, isTraceWindow, anonCorrectedRelMsgIds, finalFrameRects, traceExpandedFrameIds, edgesByRelMsg, labelBboxes, comparisonSuppressedRelIds, correctedEdgeIdsByRelMsg, input.pendingMeasurements]);
  useLayoutEffect(() => {
    const canvasEl=canvasRef.current; if (!canvasEl) return;
    const task = startOverlays();
    task.run(() => {
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
      // the overlay measurement depends on labelBboxes, so we must not update state when the
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
      task.complete();
    });
  }, [positionedEdges, actualCanvasWidth, actualCanvasHeight]);
  return { ...overlays, labelBboxes };
}
