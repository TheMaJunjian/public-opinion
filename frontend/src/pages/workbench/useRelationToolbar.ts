import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useInterfaceZoom } from '../../context/InterfaceZoomContext';
import { useWorkbenchDrawingTask } from '../../context/WorkbenchDrawingContext';

/** Measures the fixed relation toolbar independently of the workbench model. */
export function useRelationToolbar(loading: boolean) {
  const startMeasurement = useWorkbenchDrawingTask('measurement');
  const interfaceZoom = useInterfaceZoom();
  const relationBarRef = useRef<HTMLDivElement>(null);
  const relationLeftControlsRef = useRef<HTMLDivElement>(null);
  const relationRightControlsRef = useRef<HTMLDivElement>(null);
  const [relationBarHeight, setRelationBarHeight] = useState(0);
  const [relationBarMinWidth, setRelationBarMinWidth] = useState(0);
  const [relationControlsRightOffset, setRelationControlsRightOffset] = useState(16);

  const measureRelationBar = useCallback(() => {
    const task = startMeasurement();
    task.run(() => {
      const relationBar = relationBarRef.current;
      if (relationBar) {
        setRelationBarHeight(relationBar.getBoundingClientRect().height / interfaceZoom);
        const leftWidth = (relationLeftControlsRef.current?.getBoundingClientRect().width ?? 0) / interfaceZoom;
        const rightWidth = (relationRightControlsRef.current?.getBoundingClientRect().width ?? 0) / interfaceZoom;
        const contentWidth = leftWidth + rightWidth + 32;
        setRelationBarMinWidth(current => current === contentWidth ? current : contentWidth);
        const leftControls = relationLeftControlsRef.current;
        const rightControls = relationRightControlsRef.current;
        if (!leftControls || !rightControls) { task.complete(); return; }
        const leftRect = leftControls.getBoundingClientRect();
        const rightRect = rightControls.getBoundingClientRect();
        const viewportWidth = document.documentElement.clientWidth || window.innerWidth;
        const nextRightOffset = Math.min(16, (viewportWidth - leftRect.right - rightRect.width) / interfaceZoom - 16);
        setRelationControlsRightOffset(current => current === nextRightOffset ? current : nextRightOffset);
      }
      task.complete();
    });
  }, [interfaceZoom, startMeasurement]);

  useLayoutEffect(() => {
    measureRelationBar();
  }, [loading, measureRelationBar]);

  useEffect(() => {
    const relationBar = relationBarRef.current;
    if (!relationBar) return;
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
  }, [loading, measureRelationBar]);


  return { relationBarRef, relationLeftControlsRef, relationRightControlsRef, relationBarHeight, relationBarMinWidth, relationControlsRightOffset };
}
