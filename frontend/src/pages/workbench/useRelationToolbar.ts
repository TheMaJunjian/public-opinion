import { useCallback, useLayoutEffect, useRef, useState } from 'react';
import { useInterfaceZoom } from '../../context/InterfaceZoomContext';
import { useWorkbenchDrawingTask } from '../../context/WorkbenchDrawingContext';

/** Measures the fixed relation toolbar independently of the workbench model. */
export function useRelationToolbar(loading: boolean) {
  const startMeasurement = useWorkbenchDrawingTask('measurement');
  const interfaceZoom = useInterfaceZoom();
  // The toolbar mounts inside a deferred subtree, after this hook's first effects.
  const [relationBar, relationBarRef] = useState<HTMLDivElement | null>(null);
  const relationLeftControlsRef = useRef<HTMLDivElement>(null);
  const relationRightControlsRef = useRef<HTMLDivElement>(null);
  const [relationBarHeight, setRelationBarHeight] = useState(0);
  const [relationBarMinWidth, setRelationBarMinWidth] = useState(0);
  const [relationControlsRightOffset, setRelationControlsRightOffset] = useState(16);

  const measureRelationBar = useCallback(() => {
    if (!relationBar) return;
    const task = startMeasurement();
    task.run(() => {
      setRelationBarHeight(relationBar.getBoundingClientRect().height / interfaceZoom);
      const leftRect = relationLeftControlsRef.current?.getBoundingClientRect();
      const rightRect = relationRightControlsRef.current?.getBoundingClientRect();
      const contentWidth = ((leftRect?.width ?? 0) + (rightRect?.width ?? 0)) / interfaceZoom + 32;
      setRelationBarMinWidth(current => current === contentWidth ? current : contentWidth);
      if (leftRect && rightRect) {
        const viewportWidth = document.documentElement.clientWidth || window.innerWidth;
        const nextRightOffset = Math.min(16, (viewportWidth - leftRect.right - rightRect.width) / interfaceZoom - 16);
        setRelationControlsRightOffset(current => current === nextRightOffset ? current : nextRightOffset);
      }
      task.complete();
    });
  }, [relationBar, interfaceZoom, startMeasurement]);

  useLayoutEffect(() => {
    if (!relationBar) { setRelationBarHeight(0); setRelationBarMinWidth(0); setRelationControlsRightOffset(16); return; }
    const updatePinnedState = () => measureRelationBar();
    updatePinnedState();
    const observer = new ResizeObserver(updatePinnedState);
    observer.observe(relationBar);
    observer.observe(document.documentElement);
    if (relationLeftControlsRef.current) observer.observe(relationLeftControlsRef.current);
    if (relationRightControlsRef.current) observer.observe(relationRightControlsRef.current);
    window.addEventListener('resize', updatePinnedState);
    window.addEventListener('scroll', updatePinnedState, { passive: true });
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', updatePinnedState);
      window.removeEventListener('scroll', updatePinnedState);
    };
  }, [loading, relationBar, measureRelationBar]);


  return { relationBarRef, relationLeftControlsRef, relationRightControlsRef, relationBarHeight, relationBarMinWidth, relationControlsRightOffset };
}
