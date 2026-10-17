import React, { useEffect, useRef, useState } from 'react';
import {
  handleLeftPanelTouchEnd as runHandleLeftPanelTouchEnd,
  handleLeftPanelTouchMove as runHandleLeftPanelTouchMove,
  handleLeftPanelTouchStart as runHandleLeftPanelTouchStart,
  handlePanelWheel,
  handleSplitterPointerDown as runHandleSplitterPointerDown,
} from './actions/panelGestures';
import type { LeftPanelTouchGesture } from './actions/panelGestures';
import type { ViewMode } from './types';

export interface WorkbenchViewportInput {
  comparisonReviewed: boolean;
  viewMode: ViewMode;
  loading: boolean;
}

type FixedHorizontalScroll = { left: number; bottom: number; width: number; contentWidth: number; scale: number };

/** Owns panel sizing, scrollbars and pointer/touch gestures; selections and view history stay outside. */
export function useWorkbenchViewport({ comparisonReviewed, viewMode, loading }: WorkbenchViewportInput) {
  const leftPanelRef = useRef<HTMLDivElement | null>(null);

  const leftPanelTouchRef = useRef<LeftPanelTouchGesture | null>(null);

  const fixedHorizontalScrollRef = useRef<HTMLDivElement | null>(null);

  const [fixedHorizontalScroll, setFixedHorizontalScroll] = useState<FixedHorizontalScroll | null>(null);
  const fixedHorizontalScrollValueRef = useRef<FixedHorizontalScroll | null>(null);

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
      const hideFixedScroll = () => {
        if (fixedHorizontalScrollValueRef.current === null) return;
        fixedHorizontalScrollValueRef.current = null;
        setFixedHorizontalScroll(null);
      };
      const panel = leftPanelRef.current;
      const isTouchDevice = navigator.maxTouchPoints > 0
        || window.matchMedia('(hover: none) and (pointer: coarse), (max-width: 768px)').matches;
      if (!panel || isTouchDevice) {
        hideFixedScroll();
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
        hideFixedScroll();
        return;
      }
      const next = {
        left: visibleLeft,
        bottom: 0,
        width: visibleWidth,
        contentWidth,
        scale,
      };
      const current = fixedHorizontalScrollValueRef.current;
      if (current
        && current.left === next.left
        && current.bottom === next.bottom
        && current.width === next.width
        && current.contentWidth === next.contentWidth
        && current.scale === next.scale) return;
      fixedHorizontalScrollValueRef.current = next;
      setFixedHorizontalScroll(next);
    };
    let frame: number | null = null;
    const scheduleUpdate = () => {
      if (frame !== null) return;
      frame = window.requestAnimationFrame(() => {
        frame = null;
        updateFixedHorizontalScroll();
      });
    };
    scheduleUpdate();
    window.addEventListener('resize', scheduleUpdate);
    window.addEventListener('scroll', scheduleUpdate, { passive: true });
    const observer = new ResizeObserver(scheduleUpdate);
    if (leftPanelRef.current) {
      observer.observe(leftPanelRef.current);
      Array.from(leftPanelRef.current.children).forEach(element => observer.observe(element));
      leftPanelRef.current.querySelectorAll<HTMLElement>('[data-comparison-viewport], [data-jump-canvas]')
        .forEach(element => observer.observe(element));
    }
    const mutationObserver = new MutationObserver(scheduleUpdate);
    if (leftPanelRef.current) mutationObserver.observe(leftPanelRef.current, { childList: true, subtree: true });
    return () => {
      window.removeEventListener('resize', scheduleUpdate);
      window.removeEventListener('scroll', scheduleUpdate);
      observer.disconnect();
      mutationObserver.disconnect();
      if (frame !== null) window.cancelAnimationFrame(frame);
    };
  }, [comparisonReviewed, viewMode, containerWidth, leftFlex, loading]);

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
    // Both panels use their natural height and the page scrollbar. Nested
    // lists and horizontal canvas overflow keep their own scroll handling.
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

  return { leftPanelRef, fixedHorizontalScrollRef, fixedHorizontalScroll, rightPanelRef, viewModeScrollRef, TOTAL_FLEX, MIN_LEFT_PX, MIN_RIGHT_PX, MAX_RIGHT_PX, leftFlex, effectiveContainerWidth, splitterActive, panelContainerRef, handleSplitterPointerDown, handleLeftPanelTouchStart, handleLeftPanelTouchMove, handleLeftPanelTouchEnd };
}
