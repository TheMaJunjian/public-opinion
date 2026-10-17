import React, { useEffect, useRef, useState } from 'react';
import {
  handleLeftPanelTouchEnd as runHandleLeftPanelTouchEnd,
  handleLeftPanelTouchMove as runHandleLeftPanelTouchMove,
  handleLeftPanelTouchStart as runHandleLeftPanelTouchStart,
  handlePanelWheel,
  handleSplitterPointerDown as runHandleSplitterPointerDown,
} from './actions/panelGestures';
import type { ViewMode } from './types';

export interface WorkbenchViewportInput {
  comparisonReviewed: boolean;
  viewMode: ViewMode;
  loading: boolean;
}

/** Owns panel sizing, scrollbars and pointer/touch gestures; selections and view history stay outside. */
export function useWorkbenchViewport({ comparisonReviewed, viewMode, loading }: WorkbenchViewportInput) {
  const leftPanelRef = useRef<HTMLDivElement | null>(null);

  const leftPanelTouchRef = useRef<{ x: number } | null>(null);

  const fixedHorizontalScrollRef = useRef<HTMLDivElement | null>(null);

  const [fixedHorizontalScroll, setFixedHorizontalScroll] = useState<{ left: number; bottom: number; width: number; contentWidth: number; scale: number } | null>(null);

  const [leftPanelMinHeight, setLeftPanelMinHeight] = useState(0);

  const rightPanelRef = useRef<HTMLDivElement | null>(null);

  const viewModeScrollRef = useRef<{ graph: { top: number; left: number } | null; list: { top: number; left: number } | null }>({ graph: null, list: null });

  const TOTAL_FLEX = 4;

  const MIN_LEFT_PX = 560;

  const MIN_RIGHT_PX = 280;

  const MAX_RIGHT_PX = 700;

  const BASE_WIDTH = 1024;

  const SAVED_LEFT_FLEX_KEY = 'workbenchLeftFlex';

  const savedLeftFlex = Number(localStorage.getItem(SAVED_LEFT_FLEX_KEY));

  const initialLeftFlex = Number.isFinite(savedLeftFlex) && savedLeftFlex > 0 && savedLeftFlex < TOTAL_FLEX
    ? savedLeftFlex
    : TOTAL_FLEX / 2;

  const [leftFlex, setLeftFlex] = useState(initialLeftFlex);

  const MOBILE_DEFAULT_WIDTH = 1240;

  const getAvailableWidth = () => document.documentElement.clientWidth || window.innerWidth;

  const getMinimumContainerWidth = () => Math.max(
    getAvailableWidth(),
    MIN_LEFT_PX + MIN_RIGHT_PX + 12,
    window.matchMedia('(max-width: 768px), (hover: none) and (pointer: coarse)').matches
      ? MOBILE_DEFAULT_WIDTH
      : 0,
  );

  const [containerWidth, setContainerWidth] = useState(() => {
    const saved = localStorage.getItem('workbenchWidth');
    const savedWidth = saved ? Number(saved) : 0;
    const maxWidthForRightPanel = Math.ceil(MAX_RIGHT_PX * TOTAL_FLEX / (TOTAL_FLEX - initialLeftFlex) + 12);
    return Math.max(
      savedWidth > 0 ? Math.min(savedWidth, maxWidthForRightPanel) : BASE_WIDTH,
      getMinimumContainerWidth(),
    );
  });

  const effectiveContainerWidth = Math.max(containerWidth, getMinimumContainerWidth());

  const [splitterActive, setSplitterActive] = useState(false);

  const panelContainerRef = useRef<HTMLDivElement | null>(null);

  const splitterDragRef = useRef<{ startX: number; startLeftPx: number; containerW: number } | null>(null);

  useEffect(() => { localStorage.setItem('workbenchWidth', String(containerWidth)); }, [containerWidth]);

  useEffect(() => { localStorage.setItem(SAVED_LEFT_FLEX_KEY, String(leftFlex)); }, [leftFlex]);

  useEffect(() => {
    const syncContainerWidth = () => {
      setContainerWidth(currentWidth => Math.max(currentWidth, getMinimumContainerWidth()));
    };
    const frame = requestAnimationFrame(() => requestAnimationFrame(syncContainerWidth));
    window.addEventListener('resize', syncContainerWidth);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener('resize', syncContainerWidth);
    };
  }, []);

  useEffect(() => {
    const updateFixedHorizontalScroll = () => {
      const panel = leftPanelRef.current;
      const isTouchDevice = window.matchMedia('(hover: none) and (pointer: coarse)').matches;
      if (!panel || isTouchDevice) {
        setFixedHorizontalScroll(null);
        return;
      }
      const rect = panel.getBoundingClientRect();
      const visibleTop = Math.max(rect.top, 0);
      const visibleBottom = Math.min(rect.bottom, window.innerHeight);
      const scale = panel.offsetWidth > 0 ? rect.width / panel.offsetWidth : 1;
      const visibleLeft = Math.max(rect.left, 0);
      const visibleRight = Math.min(rect.right, document.documentElement.clientWidth || window.innerWidth);
      const visibleWidth = Math.max(0, visibleRight - visibleLeft);
      const comparisonWidths = Array.from(panel.querySelectorAll<HTMLElement>('[data-comparison-viewport]'))
        .map(viewport => viewport.scrollWidth);
      const contentWidth = Math.max(panel.scrollWidth, ...comparisonWidths, 0) * scale;
      if (visibleBottom <= visibleTop || visibleWidth <= 0 || contentWidth <= rect.width + 1) {
        setFixedHorizontalScroll(null);
        return;
      }
      setFixedHorizontalScroll({
        left: visibleLeft,
        bottom: 0,
        width: visibleWidth,
        contentWidth,
        scale,
      });
    };
    const scheduleUpdate = () => window.requestAnimationFrame(updateFixedHorizontalScroll);
    updateFixedHorizontalScroll();
    scheduleUpdate();
    window.addEventListener('resize', updateFixedHorizontalScroll);
    window.addEventListener('scroll', updateFixedHorizontalScroll, { passive: true });
    const observer = new ResizeObserver(updateFixedHorizontalScroll);
    if (leftPanelRef.current) {
      observer.observe(leftPanelRef.current);
      Array.from(leftPanelRef.current.children).forEach(element => observer.observe(element));
      leftPanelRef.current.querySelectorAll<HTMLElement>('[data-comparison-viewport], [data-jump-canvas]')
        .forEach(element => observer.observe(element));
    }
    const mutationObserver = new MutationObserver(() => {
      updateFixedHorizontalScroll();
    });
    mutationObserver.observe(document.body, {
      childList: true,
      subtree: true,
    });
    return () => {
      window.removeEventListener('resize', updateFixedHorizontalScroll);
      window.removeEventListener('scroll', updateFixedHorizontalScroll);
      observer.disconnect();
      mutationObserver.disconnect();
    };
  }, [comparisonReviewed, viewMode, containerWidth, leftFlex]);

  useEffect(() => {
    const panel = leftPanelRef.current;
    const fixedScroll = fixedHorizontalScrollRef.current;
    if (!panel || !fixedScroll) return;
    const getHorizontalMax = (element: HTMLElement) => Math.max(0, element.scrollWidth - element.clientWidth);
    const getScrollProgress = (element: HTMLElement) => {
      const max = getHorizontalMax(element);
      return max > 0 ? element.scrollLeft / max : 0;
    };
    const getFixedProgress = () => {
      const max = getHorizontalMax(fixedScroll);
      return max > 0 ? fixedScroll.scrollLeft / max : 0;
    };
    const syncPanelToFixedScroll = () => {
      const progress = Math.max(0, Math.min(1, getFixedProgress()));
      panel.scrollLeft = getHorizontalMax(panel) * progress;
      for (const viewport of panel.querySelectorAll<HTMLElement>('[data-comparison-viewport]')) {
        viewport.scrollLeft = getHorizontalMax(viewport) * progress;
      }
    };
    const syncFixedScrollToPanel = () => {
      const comparisonViewport = panel.querySelector<HTMLElement>('[data-comparison-viewport]');
      const source = comparisonViewport && getHorizontalMax(comparisonViewport) > 0
        ? comparisonViewport
        : panel;
      if (!source) return;
      const progress = Math.max(0, Math.min(1, getScrollProgress(source)));
      fixedScroll.scrollLeft = getHorizontalMax(fixedScroll) * progress;
    };
    fixedScroll.addEventListener('scroll', syncPanelToFixedScroll, { passive: true });
    panel.addEventListener('scroll', syncFixedScrollToPanel, { passive: true });
    const comparisonViewports = Array.from(panel.querySelectorAll<HTMLElement>('[data-comparison-viewport]'));
    comparisonViewports.forEach(viewport => viewport.addEventListener('scroll', syncFixedScrollToPanel, { passive: true }));
    syncFixedScrollToPanel();
    return () => {
      fixedScroll.removeEventListener('scroll', syncPanelToFixedScroll);
      panel.removeEventListener('scroll', syncFixedScrollToPanel);
      comparisonViewports.forEach(viewport => viewport.removeEventListener('scroll', syncFixedScrollToPanel));
    };
  }, [fixedHorizontalScroll]);

  useEffect(() => {
    const updatePanelHeights = () => {
      const panel = leftPanelRef.current;
      if (!panel) return;
      const panelRect = panel.getBoundingClientRect();
      const scale = panel.offsetWidth > 0 ? panelRect.width / panel.offsetWidth : 1;
      const viewportHeight = document.documentElement.clientHeight || window.innerHeight;
      // Measure from the document origin. A viewport-relative top moves while
      // dragging the page scrollbar and would continuously grow the page.
      const panelDocumentTop = panelRect.top + window.scrollY;
      const bottomPadding = panel.parentElement ? parseFloat(getComputedStyle(panel.parentElement).paddingBottom) || 0 : 0;
      const minHeight = Math.max(0, Math.floor((viewportHeight - panelDocumentTop) / Math.max(scale, 0.01)) - bottomPadding);
      setLeftPanelMinHeight(current => current === minHeight ? current : minHeight);
    };
    updatePanelHeights();
    window.addEventListener('resize', updatePanelHeights);
    const zoomObserver = new MutationObserver(updatePanelHeights);
    const zoomRoot = document.querySelector('[style*="scale("]');
    if (zoomRoot) zoomObserver.observe(zoomRoot, { attributes: true, attributeFilter: ['style'] });
    return () => {
      window.removeEventListener('resize', updatePanelHeights);
      zoomObserver.disconnect();
    };
  }, [loading]);

  function handleSplitterPointerDown(e: React.PointerEvent<HTMLDivElement>): void {
    return runHandleSplitterPointerDown({ setSplitterActive, panelContainerRef, splitterDragRef, MIN_LEFT_PX, MIN_RIGHT_PX, MAX_RIGHT_PX, BASE_WIDTH, getMinimumContainerWidth, setContainerWidth, setLeftFlex, TOTAL_FLEX }, e);
  }

  function handleLeftPanelTouchStart(e: React.TouchEvent<HTMLDivElement>): void {
    return runHandleLeftPanelTouchStart({ leftPanelTouchRef }, e);
  }

  function handleLeftPanelTouchMove(e: React.TouchEvent<HTMLDivElement>): void {
    return runHandleLeftPanelTouchMove({ leftPanelTouchRef, leftPanelRef }, e);
  }

  function handleLeftPanelTouchEnd(): void {
    return runHandleLeftPanelTouchEnd({ leftPanelTouchRef });
  }

  useEffect(() => {
    const left = leftPanelRef.current;
    const right = rightPanelRef.current;
    if (!left || !right) return;
    // The right panel keeps its natural height and is browsed with the page
    // scrollbar. Only the left canvas and nested lists have their own scroll.
    const page = document.scrollingElement as HTMLElement | null ?? document.documentElement;
    const scrollLeft = (event: WheelEvent) => handlePanelWheel(left, right, event, page);
    const scrollRight = (event: WheelEvent) => handlePanelWheel(right, left, event, page);
    // React delegates wheel events passively, so preventDefault must run here.
    left.addEventListener('wheel', scrollLeft, { passive: false });
    right.addEventListener('wheel', scrollRight, { passive: false });
    return () => {
      left.removeEventListener('wheel', scrollLeft);
      right.removeEventListener('wheel', scrollRight);
    };
  }, [loading]);

  return { leftPanelRef, fixedHorizontalScrollRef, fixedHorizontalScroll, leftPanelMinHeight, rightPanelRef, viewModeScrollRef, TOTAL_FLEX, MIN_LEFT_PX, MIN_RIGHT_PX, MAX_RIGHT_PX, leftFlex, effectiveContainerWidth, splitterActive, panelContainerRef, handleSplitterPointerDown, handleLeftPanelTouchStart, handleLeftPanelTouchMove, handleLeftPanelTouchEnd };
}
