import React from "react";

interface HandleSplitterPointerDownDependencies {
  setSplitterActive: React.Dispatch<React.SetStateAction<boolean>>;
  panelContainerRef: React.MutableRefObject<HTMLDivElement | null>;
  splitterDragRef: React.MutableRefObject<{ startX: number; startLeftPx: number; containerW: number; } | null>;
  MIN_LEFT_PX: 560;
  MIN_RIGHT_PX: 280;
  MAX_RIGHT_PX: 700;
  BASE_WIDTH: 1024;
  getMinimumContainerWidth: () => number;
  setContainerWidth: React.Dispatch<React.SetStateAction<number>>;
  setLeftFlex: React.Dispatch<React.SetStateAction<number>>;
  TOTAL_FLEX: 4;
}

export function handleSplitterPointerDown(dependencies: HandleSplitterPointerDownDependencies, e: React.PointerEvent<HTMLDivElement>): void {
  const { setSplitterActive, panelContainerRef, splitterDragRef, MIN_LEFT_PX, MIN_RIGHT_PX, MAX_RIGHT_PX, BASE_WIDTH, getMinimumContainerWidth, setContainerWidth, setLeftFlex, TOTAL_FLEX } = dependencies;
  e.preventDefault();
  e.currentTarget.setPointerCapture(e.pointerId);
  setSplitterActive(true);
  const panelContainer = panelContainerRef.current;
  const containerRect = panelContainer?.getBoundingClientRect();
  const splitterRect = e.currentTarget.getBoundingClientRect();
  const containerW = containerRect?.width ?? 0;
  const startLeftPx = containerRect
    ? splitterRect.left - containerRect.left
    : 0;
  splitterDragRef.current = { startX: e.clientX, startLeftPx, containerW };
  function onPointerMove(ev: PointerEvent) {
    if (!splitterDragRef.current || !panelContainerRef.current) return;
    const dx = ev.clientX - splitterDragRef.current.startX;
    const desiredLeftPx = Math.max(MIN_LEFT_PX, splitterDragRef.current.startLeftPx + dx);
    const naturalRightPx = splitterDragRef.current.containerW - 12 - desiredLeftPx;
    const nextWidth = naturalRightPx < MIN_RIGHT_PX
      ? Math.max(splitterDragRef.current.containerW, desiredLeftPx + MIN_RIGHT_PX + 12)
      : naturalRightPx > MAX_RIGHT_PX
        ? Math.max(BASE_WIDTH, Math.min(splitterDragRef.current.containerW, desiredLeftPx + MAX_RIGHT_PX + 12))
        : splitterDragRef.current.containerW;
    const effectiveNextWidth = Math.max(nextWidth, getMinimumContainerWidth());
    setContainerWidth(nextWidth);
    setLeftFlex(TOTAL_FLEX * desiredLeftPx / (effectiveNextWidth - 12));
  }
  function onPointerUp() {
    setSplitterActive(false);
    splitterDragRef.current = null;
    document.removeEventListener('pointermove', onPointerMove);
    document.removeEventListener('pointerup', onPointerUp);
    document.removeEventListener('pointercancel', onPointerUp);
  }
  document.addEventListener('pointermove', onPointerMove);
  document.addEventListener('pointerup', onPointerUp);
  document.addEventListener('pointercancel', onPointerUp);
}

interface HandleLeftPanelTouchStartDependencies {
  leftPanelTouchRef: React.MutableRefObject<{ x: number; } | null>;
}

export function handleLeftPanelTouchStart(dependencies: HandleLeftPanelTouchStartDependencies, e: React.TouchEvent<HTMLDivElement>): void {
  const { leftPanelTouchRef } = dependencies;
  leftPanelTouchRef.current = e.touches.length === 1 ? { x: e.touches[0].clientX } : null;
}

interface HandleLeftPanelTouchMoveDependencies {
  leftPanelTouchRef: React.MutableRefObject<{ x: number; } | null>;
  leftPanelRef: React.MutableRefObject<HTMLDivElement | null>;
}

export function handleLeftPanelTouchMove(dependencies: HandleLeftPanelTouchMoveDependencies, e: React.TouchEvent<HTMLDivElement>): void {
  const { leftPanelTouchRef, leftPanelRef } = dependencies;
  if (e.touches.length !== 1 || !leftPanelTouchRef.current) {
    leftPanelTouchRef.current = null;
    return;
  }
  const panel = leftPanelRef.current;
  const documentScroller = document.scrollingElement;
  if (!panel || !documentScroller) return;
  const touch = e.touches[0];
  const deltaX = touch.clientX - leftPanelTouchRef.current.x;
  const panelMax = Math.max(0, panel.scrollWidth - panel.clientWidth);
  const documentMax = Math.max(0, documentScroller.scrollWidth - documentScroller.clientWidth);
  const panelAtEdge = (panel.scrollLeft <= 0 && deltaX > 0) || (panel.scrollLeft >= panelMax - 1 && deltaX < 0);
  if (panelAtEdge && documentMax > 0) {
    const next = Math.max(0, Math.min(documentMax, documentScroller.scrollLeft - deltaX));
    if (next !== documentScroller.scrollLeft) {
      e.preventDefault();
      documentScroller.scrollLeft = next;
    }
  }
  leftPanelTouchRef.current = { x: touch.clientX };
}

interface HandleLeftPanelTouchEndDependencies {
  leftPanelTouchRef: React.MutableRefObject<{ x: number; } | null>;
}

export function handleLeftPanelTouchEnd(dependencies: HandleLeftPanelTouchEndDependencies): void {
  const { leftPanelTouchRef } = dependencies;
  leftPanelTouchRef.current = null;
}

interface HandleLeftPanelWheelDependencies {
  rightPanelRef: React.MutableRefObject<HTMLDivElement | null>;
}

export function handleLeftPanelWheel(dependencies: HandleLeftPanelWheelDependencies, event: React.WheelEvent<HTMLDivElement>): void {
  const { rightPanelRef } = dependencies;
  const panel = event.currentTarget;
  if (event.deltaY === 0) return;
  const maxScrollTop = Math.max(0, panel.scrollHeight - panel.clientHeight);
  const previousScrollTop = panel.scrollTop;
  const nextScrollTop = Math.max(0, Math.min(maxScrollTop, previousScrollTop + event.deltaY));
  const consumedDelta = nextScrollTop - previousScrollTop;
  const remainingDelta = event.deltaY - consumedDelta;
  const rightPanel = rightPanelRef.current;
  event.preventDefault();
  if (consumedDelta !== 0) panel.scrollTop = nextScrollTop;
  if (rightPanel && remainingDelta !== 0) {
    const rightMaxScrollTop = Math.max(0, rightPanel.scrollHeight - rightPanel.clientHeight);
    rightPanel.scrollTop = Math.max(0, Math.min(rightMaxScrollTop, rightPanel.scrollTop + remainingDelta));
  }
}
