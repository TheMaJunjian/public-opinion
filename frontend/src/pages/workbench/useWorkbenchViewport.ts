import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useInterfaceZoom } from '../../context/InterfaceZoomContext';
import {
  handleLeftPanelTouchEnd as runHandleLeftPanelTouchEnd,
  handleLeftPanelTouchMove as runHandleLeftPanelTouchMove,
  handleLeftPanelTouchStart as runHandleLeftPanelTouchStart,
  handlePanelWheel,
  handleSplitterPointerDown as runHandleSplitterPointerDown,
} from './actions/panelGestures';
import type { LeftPanelTouchGesture } from './actions/panelGestures';

export interface WorkbenchViewportInput {
  loading: boolean;
}

// clientWidth rounds to an integer. At browser zoom that can add a fraction of
// a pixel to the shell and create a second, page-wide horizontal scrollbar.
const getViewportWidth = () => document.documentElement.getBoundingClientRect().width
  || document.documentElement.clientWidth || window.innerWidth;

/** Owns panel sizing, scrollbars and pointer/touch gestures; selections and view history stay outside. */
export function useWorkbenchViewport({ loading }: WorkbenchViewportInput) {
  const interfaceZoom = useInterfaceZoom();
  const [viewportWidth, setViewportWidth] = useState(getViewportWidth);
  const leftPanelRef = useRef<HTMLDivElement | null>(null);

  const leftPanelTouchRef = useRef<LeftPanelTouchGesture | null>(null);

  const rightPanelRef = useRef<HTMLDivElement | null>(null);

  const viewModeScrollRef = useRef<{ graph: { top: number; left: number } | null; list: { top: number; left: number } | null }>({ graph: null, list: null });

  const TOTAL_FLEX = 4;

  const MIN_LEFT_PX = 560;

  const MIN_RIGHT_PX = 280;

  const MAX_RIGHT_PX = 700;

  const BASE_WIDTH = 1024;

  const SAVED_LEFT_FLEX_KEY = 'workbenchLeftFlex';

  const savedLeftFlex = Number(localStorage.getItem(SAVED_LEFT_FLEX_KEY));

  // Give desktop reading more room; a user's saved splitter position still wins.
  const defaultLeftFlex = window.matchMedia('(min-width: 1024px) and (pointer: fine)').matches
    ? TOTAL_FLEX * (1 - 420 / Math.max(MIN_LEFT_PX + 420, viewportWidth / interfaceZoom - 12))
    : TOTAL_FLEX / 2;

  const initialLeftFlex = Number.isFinite(savedLeftFlex) && savedLeftFlex > 0 && savedLeftFlex < TOTAL_FLEX
    ? savedLeftFlex
    : defaultLeftFlex;

  const [leftFlex, setLeftFlex] = useState(initialLeftFlex);

  const MOBILE_DEFAULT_WIDTH = 1240;

  const getAvailableWidth = () => viewportWidth / interfaceZoom;

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

  const minimumContainerWidth = getMinimumContainerWidth();
  // Also discard the subpixel excess in widths saved by the old rounded measurement.
  const effectiveContainerWidth = Math.abs(containerWidth - minimumContainerWidth) < 1
    ? minimumContainerWidth : Math.max(containerWidth, minimumContainerWidth);

  const [splitterActive, setSplitterActive] = useState(false);

  const panelContainerRef = useRef<HTMLDivElement | null>(null);

  const splitterDragRef = useRef<{ startX: number; startLeftPx: number; containerW: number } | null>(null);
  const splitterCleanupRef = useRef<(() => void) | undefined>(undefined);

  useEffect(() => () => splitterCleanupRef.current?.(), []);

  useEffect(() => { localStorage.setItem('workbenchWidth', String(containerWidth)); }, [containerWidth]);

  useEffect(() => { localStorage.setItem(SAVED_LEFT_FLEX_KEY, String(leftFlex)); }, [leftFlex]);

  useLayoutEffect(() => {
    const syncContainerWidth = () => {
      setViewportWidth(getViewportWidth());
    };
    syncContainerWidth();
    window.addEventListener('resize', syncContainerWidth);
    return () => {
      window.removeEventListener('resize', syncContainerWidth);
    };
  }, []);

  function handleSplitterPointerDown(e: React.PointerEvent<HTMLDivElement>): void {
    if (splitterDragRef.current) return;
    splitterCleanupRef.current = runHandleSplitterPointerDown({ setSplitterActive, panelContainerRef, splitterDragRef, MIN_LEFT_PX, MIN_RIGHT_PX, MAX_RIGHT_PX, BASE_WIDTH, getMinimumContainerWidth, setContainerWidth, setLeftFlex, TOTAL_FLEX }, e);
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
    const container = panelContainerRef.current;
    if (!container) return;
    const page = document.scrollingElement as HTMLElement | null ?? document.documentElement;
    // The operation panel loads lazily. Resolve its current node for every input
    // so the first visit and replacement panels retain the same scroll priority.
    const scrollPanel = (event: WheelEvent) => {
      const left = leftPanelRef.current, right = rightPanelRef.current;
      const target = event.composedPath()[0] ?? event.target;
      if (!(target instanceof Node)) return;
      if (right?.contains(target)) handlePanelWheel(right, event, page);
      else if (left && (left.closest('[data-workbench-panel-surface]') ?? left).contains(target)) handlePanelWheel(left, event, page);
    };
    // React delegates wheel events passively, so preventDefault must run here.
    container.addEventListener('wheel', scrollPanel, { passive: false });
    return () => {
      container.removeEventListener('wheel', scrollPanel);
    };
  }, [loading]);

  return { leftPanelRef, rightPanelRef, viewModeScrollRef, TOTAL_FLEX, MIN_LEFT_PX, MIN_RIGHT_PX, MAX_RIGHT_PX, leftFlex, effectiveContainerWidth, splitterActive, panelContainerRef, handleSplitterPointerDown, handleLeftPanelTouchStart, handleLeftPanelTouchMove, handleLeftPanelTouchEnd };
}
