import { useLayoutEffect, useRef, useState } from 'react';
import type { MutableRefObject } from 'react';
import { emptyGraphOverlays, measureGraphOverlays } from '../utils/graphOverlays';
import type { GraphOverlayInput } from '../utils/graphOverlays';
import type { Rect } from '../utils/layout';
import { LABEL_BBOX_STABILITY_THRESHOLD } from '../utils/graphPresentationGeometry';
import { reportWorkbenchDrawingDuration } from '../utils/workbenchActivity';
import { useWorkbenchDrawingTask } from '../context/WorkbenchDrawingContext';
import type { GraphAnchorCache } from '../utils/graphAnchorCache';
import { useTheme } from '../theme/theme';
type LabelBbox = Rect;

export function useGraphOverlays(input: Omit<GraphOverlayInput, 'labelBboxes'> & {
  labelViewport?: import('../utils/frameLayout').Box | null;
  labelRetainedIds?: ReadonlySet<string>;
  textRefs: MutableRefObject<Record<string, SVGTextElement | null>>;
  actualCanvasWidth: number;
  actualCanvasHeight: number;
  pendingMeasurements?: boolean;
}) {
  const startOverlays = useWorkbenchDrawingTask('overlays');
  const theme = useTheme();
  const { canvasRef, normalIds, msgMap, relationCardMsgIds, cardRefs, colOf, layout, normals, headerRefs, contentRefs, edges, messages, isTraceWindow, anonCorrectedRelMsgIds, finalFrameRects, traceExpandedFrameIds, edgesByRelMsg, comparisonSuppressedRelIds, correctedEdgeIdsByRelMsg, textRefs, actualCanvasWidth, actualCanvasHeight } = input;
  const [overlays, setOverlays] = useState(emptyGraphOverlays);
  const [labelBboxes, setLabelBboxes] = useState<Record<string, LabelBbox>>({});
  const labelMetrics = useRef(new Map<string, { text:string; x:number; y:number; width:number; height:number }>());
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
      const measured = measureGraphOverlays({ canvasRef, normalIds, msgMap, relationCardMsgIds, cardRefs, colOf, layout, normals, headerRefs, contentRefs, edges, messages, isTraceWindow, anonCorrectedRelMsgIds, finalFrameRects, traceExpandedFrameIds, edgesByRelMsg, labelBboxes, comparisonSuppressedRelIds, correctedEdgeIdsByRelMsg, anchorCache: anchorCache.current, skipRouting: input.pendingMeasurements, excludedStanceEdges:input.excludedStanceEdges, visibleDecorationIds:input.visibleDecorationIds, visibleAnnotationIds:input.visibleAnnotationIds });
      reportWorkbenchDrawingDuration(performance.now() - startedAt);
      if (measured) setOverlays(measured);
      task.complete();
    });
  }, [canvasRef, normalIds, msgMap, relationCardMsgIds, cardRefs, colOf, layout, normals, headerRefs, contentRefs, edges, messages, isTraceWindow, anonCorrectedRelMsgIds, finalFrameRects, traceExpandedFrameIds, edgesByRelMsg, labelBboxes, comparisonSuppressedRelIds, correctedEdgeIdsByRelMsg, input.pendingMeasurements,input.excludedStanceEdges,input.visibleDecorationIds,input.visibleAnnotationIds]);
  useLayoutEffect(() => {
    const canvasEl=canvasRef.current; if (!canvasEl) return;
    const task = startOverlays();
    task.run(() => {
      const canvasRect=canvasEl.getBoundingClientRect();
      const scaleX = canvasEl.offsetWidth > 0 ? canvasRect.width / canvasEl.offsetWidth : 1;
      const scaleY = canvasEl.offsetHeight > 0 ? canvasRect.height / canvasEl.offsetHeight : 1;
      const next: Record<string,LabelBbox>={};
      for (const pe of positionedEdges) {
        const t=textRefs.current[pe.drawId];
        if(t){
          const r=t.getBoundingClientRect();
          labelMetrics.current.set(pe.drawId,{text:pe.edgeLabelText,
            x:(r.left-canvasRect.left)/scaleX-pe.labelX,
            y:(r.top-canvasRect.top)/scaleY-pe.labelY,width:r.width/scaleX,height:r.height/scaleY});
        }
        // Virtual scrolling may remove the label DOM. Retain its metrics and
        // project them at the routed position so dependent edges stay anchored.
        const metric=labelMetrics.current.get(pe.drawId);
        if(metric?.text===pe.edgeLabelText)next[pe.drawId]={x:pe.labelX+metric.x,y:pe.labelY+metric.y,width:metric.width,height:metric.height};
      }
      const active=new Set(positionedEdges.map(edge=>edge.drawId));
      for(const id of labelMetrics.current.keys())if(!active.has(id))labelMetrics.current.delete(id);
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
  // Virtual reveal/scroll can mount labels without changing their routed paths.
  // Measure that new DOM as well, so its hit areas and decorations appear.
  }, [positionedEdges, actualCanvasWidth, actualCanvasHeight, input.labelViewport, input.labelRetainedIds, theme]);
  return { ...overlays, labelBboxes };
}
