import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';

/** Measures the fixed relation toolbar independently of the workbench model. */
export function useRelationToolbar(loading: boolean) {
  const relationBarRef = useRef<HTMLDivElement>(null);
  const relationLeftControlsRef = useRef<HTMLDivElement>(null);
  const relationRightControlsRef = useRef<HTMLDivElement>(null);
  const [relationBarHeight, setRelationBarHeight] = useState(0);
  const [relationBarMinWidth, setRelationBarMinWidth] = useState(0);
  const [relationControlsRightOffset, setRelationControlsRightOffset] = useState(16);

  const measureRelationBar = useCallback(() => {
    const relationBar = relationBarRef.current;
    if (relationBar) {
      setRelationBarHeight(relationBar.getBoundingClientRect().height);
      const leftWidth = relationLeftControlsRef.current?.getBoundingClientRect().width ?? 0;
      const rightWidth = relationRightControlsRef.current?.getBoundingClientRect().width ?? 0;
      const contentWidth = leftWidth + rightWidth + 32;
      setRelationBarMinWidth(current => current === contentWidth ? current : contentWidth);
      const leftControls = relationLeftControlsRef.current;
      const rightControls = relationRightControlsRef.current;
      if (!leftControls || !rightControls) return;
      const leftRect = leftControls.getBoundingClientRect();
      const rightRect = rightControls.getBoundingClientRect();
      const viewportWidth = document.documentElement.clientWidth || window.innerWidth;
      const nextRightOffset = Math.min(16, viewportWidth - (leftRect.right + 16 + rightRect.width));
      setRelationControlsRightOffset(current => current === nextRightOffset ? current : nextRightOffset);
    }
  }, []);

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
