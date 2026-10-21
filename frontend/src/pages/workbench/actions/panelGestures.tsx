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
  const scale = panelContainer && panelContainer.offsetWidth > 0 && containerRect
    ? containerRect.width / panelContainer.offsetWidth
    : 1;
  const containerW = (containerRect?.width ?? 0) / scale;
  const startLeftPx = containerRect
    ? (splitterRect.left - containerRect.left) / scale
    : 0;
  splitterDragRef.current = { startX: e.clientX, startLeftPx, containerW };
  function onPointerMove(ev: PointerEvent) {
    if (!splitterDragRef.current || !panelContainerRef.current) return;
    const pointerDelta = ev.clientX - splitterDragRef.current.startX;
    // A click (including small pointer jitter) must not normalize the current
    // layout, especially while the right panel is already at its width limit.
    if (Math.abs(pointerDelta) < 3) return;
    const dx = pointerDelta / scale;
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

export interface LeftPanelTouchGesture {
  x: number;
  startX: number;
  startY: number;
  axis: 'horizontal' | 'vertical' | null;
}

interface HandleLeftPanelTouchStartDependencies {
  leftPanelTouchRef: React.MutableRefObject<LeftPanelTouchGesture | null>;
}

export function handleLeftPanelTouchStart(dependencies: HandleLeftPanelTouchStartDependencies, e: React.TouchEvent<HTMLDivElement>): void {
  const { leftPanelTouchRef } = dependencies;
  leftPanelTouchRef.current = e.touches.length === 1 ? {
    x: e.touches[0].clientX,
    startX: e.touches[0].clientX,
    startY: e.touches[0].clientY,
    axis: null,
  } : null;
}

interface HandleLeftPanelTouchMoveDependencies {
  leftPanelTouchRef: React.MutableRefObject<LeftPanelTouchGesture | null>;
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
  const gesture = leftPanelTouchRef.current;
  if (!gesture.axis) {
    const totalX = touch.clientX - gesture.startX;
    const totalY = touch.clientY - gesture.startY;
    if (Math.max(Math.abs(totalX), Math.abs(totalY)) < 6) return;
    gesture.axis = Math.abs(totalX) > Math.abs(totalY) ? 'horizontal' : 'vertical';
  }
  if (gesture.axis === 'vertical') return;
  const deltaX = touch.clientX - gesture.x;
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
  gesture.x = touch.clientX;
}

interface HandleLeftPanelTouchEndDependencies {
  leftPanelTouchRef: React.MutableRefObject<LeftPanelTouchGesture | null>;
}

export function handleLeftPanelTouchEnd(dependencies: HandleLeftPanelTouchEndDependencies): void {
  const { leftPanelTouchRef } = dependencies;
  leftPanelTouchRef.current = null;
}

type ScrollPosition = { requested: number; actual: number };
const wheelPositions = new WeakMap<HTMLElement, { top?: ScrollPosition; left?: ScrollPosition }>();

/** Consume only the distance available here and return the remainder. */
function consumeWheelDelta(element: HTMLElement, delta: number, axis: 'top' | 'left'): number {
  if (delta === 0) return 0;
  const key = axis === 'top' ? 'scrollTop' : 'scrollLeft';
  const max = Math.max(0, axis === 'top' ? element.scrollHeight - element.clientHeight : element.scrollWidth - element.clientWidth);
  const positions = wheelPositions.get(element) ?? {};
  const previous = positions[axis];
  // A scrollbar drag or navigation takes precedence over the previous wheel position.
  const start = Math.max(0, Math.min(max, previous?.actual === element[key] ? previous.requested : element[key]));
  const next = Math.max(0, Math.min(max, start + delta));
  if (next === start) return delta;
  element[key] = next;
  positions[axis] = { requested: next, actual: element[key] };
  wheelPositions.set(element, positions);
  return delta - (next - start);
}

/** Own the entire wheel sequence so handoff does not depend on the browser's latched scroll target. */
export function handlePanelWheel(panel: HTMLElement, otherPanel: HTMLElement | null, event: WheelEvent, page: HTMLElement | null = null): void {
  if (event.defaultPrevented || !event.cancelable || event.ctrlKey || (event.deltaX === 0 && event.deltaY === 0)) return;
  event.preventDefault();
  const unitY = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? panel.clientHeight : 1;
  const unitX = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? panel.clientWidth : 1;
  const shiftedWheel = event.shiftKey && event.deltaX === 0;
  let remainingY = shiftedWheel ? 0 : event.deltaY * unitY;
  let remainingX = (event.deltaX + (shiftedWheel ? event.deltaY : 0)) * unitX;
  const visited = new Set<HTMLElement>();
  const consume = (element: HTMLElement, force = false) => {
    if (visited.has(element)) return;
    visited.add(element);
    const style = getComputedStyle(element);
    if (force || /^(auto|scroll)$/.test(style.overflowY || style.overflow)) remainingY = consumeWheelDelta(element, remainingY, 'top');
    if (force || /^(auto|scroll)$/.test(style.overflowX || style.overflow)) remainingX = consumeWheelDelta(element, remainingX, 'left');
  };
  // Start under the pointer on every input, including a direction reversal.
  // A toolbar can contain scrollable content beside, rather than inside, its canvas.
  const surface = panel.closest('[data-workbench-panel-surface]') ?? panel;
  const target = event.composedPath()[0] ?? event.target;
  let ancestor = target instanceof Element ? target : target instanceof Node ? target.parentElement : null;
  if (!ancestor || !surface.contains(ancestor)) ancestor = panel;
  while (ancestor && ancestor !== page) {
    if (ancestor instanceof HTMLElement) consume(ancestor, ancestor === panel);
    if (ancestor === surface) break;
    ancestor = ancestor.parentElement;
  }
  consume(panel, true);
  if (otherPanel) consume(otherPanel, true);
  if (page) consume(page, true);
}
