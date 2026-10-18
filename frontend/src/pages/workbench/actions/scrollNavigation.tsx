import React from "react";
import type { Relation } from "../../../types";
import { getPresentationSpec } from "../../../types";
import type {
  DemoEdge
} from "../../../utils/modelBridge";

interface CancelScrollRafsDependencies {
  scrollRafRef: React.MutableRefObject<number | null>;
  scrollRaf2Ref: React.MutableRefObject<number | null>;
}

export function cancelScrollRafs(dependencies: CancelScrollRafsDependencies): void {
  const { scrollRafRef, scrollRaf2Ref } = dependencies;
  if (scrollRafRef.current !== null) { cancelAnimationFrame(scrollRafRef.current); scrollRafRef.current = null; }
  if (scrollRaf2Ref.current !== null) { cancelAnimationFrame(scrollRaf2Ref.current); scrollRaf2Ref.current = null; }
}

interface ScheduleViewNavigationDependencies {
  viewNavigationTimerRef: React.MutableRefObject<number | null>;
  scrollMsgToCenter: (msgId: string, options?: { dependencyIds?: string[]; }) => void;
}

export function scheduleViewNavigation(dependencies: ScheduleViewNavigationDependencies, targetId: string): void {
  const { viewNavigationTimerRef, scrollMsgToCenter } = dependencies;
  if (viewNavigationTimerRef.current !== null) {
    clearTimeout(viewNavigationTimerRef.current);
  }
  viewNavigationTimerRef.current = setTimeout(() => {
    viewNavigationTimerRef.current = null;
    scrollMsgToCenter(targetId);
  }, 100);
}

interface ShowMessagePulseDependencies {
  scrollRequestIdRef: React.MutableRefObject<number>;
  messagePulseTimerRef: React.MutableRefObject<number | null>;
  messagePulseRafRef: React.MutableRefObject<number | null>;
  leftPanelRef: React.MutableRefObject<HTMLDivElement | null>;
  findMessageElements: (container: HTMLElement, messageId: string) => HTMLElement[];
  setMessagePulse: React.Dispatch<React.SetStateAction<{ element: HTMLElement; rect: DOMRect; visualRoot: HTMLElement | null; visualRect: DOMRect; } | null>>;
}

export const MESSAGE_PULSE_DURATION_MS = 400;

export function showMessagePulse(dependencies: ShowMessagePulseDependencies, targetId: string, element: HTMLElement, requestId = dependencies.scrollRequestIdRef.current, onShown?: (shown: boolean) => void): void {
  const { scrollRequestIdRef, messagePulseTimerRef, messagePulseRafRef, leftPanelRef, findMessageElements, setMessagePulse } = dependencies;
  if (messagePulseTimerRef.current) clearTimeout(messagePulseTimerRef.current);
  if (messagePulseRafRef.current) cancelAnimationFrame(messagePulseRafRef.current);
  messagePulseRafRef.current = requestAnimationFrame(() => {
    messagePulseRafRef.current = null;
    if (requestId !== scrollRequestIdRef.current) { onShown?.(false); return; }
    let pulseElement = element;
    if (!pulseElement.isConnected) {
      const currentCandidates = leftPanelRef.current
        ? findMessageElements(leftPanelRef.current, targetId)
        : [];
      pulseElement = currentCandidates.find(candidate =>
        candidate.hasAttribute('data-rel-overlay') && candidate.getAttribute('data-msgid') === targetId,
      ) ?? currentCandidates[0];
    }
    if (!pulseElement?.isConnected) { onShown?.(false); return; }
    const targetElements = pulseElement.hasAttribute('data-rel-overlay')
      ? findMessageElements(leftPanelRef.current!, targetId)
        .filter(candidate => candidate.hasAttribute('data-rel-overlay'))
      : findMessageElements(leftPanelRef.current!, targetId);
    const targetRects = targetElements
      .map(candidate => (candidate as HTMLElement).getBoundingClientRect())
      .filter(candidateRect => candidateRect.width > 0 && candidateRect.height > 0);
    const rect = targetRects.reduce((bounds, candidateRect) => {
      const left = Math.min(bounds.left, candidateRect.left);
      const top = Math.min(bounds.top, candidateRect.top);
      const right = Math.max(bounds.right, candidateRect.right);
      const bottom = Math.max(bounds.bottom, candidateRect.bottom);
      return new DOMRect(left, top, right - left, bottom - top);
    }, pulseElement.getBoundingClientRect());
    const visualRoot = pulseElement.hasAttribute('data-rel-overlay')
      ? pulseElement.closest('[data-jump-canvas]') as HTMLElement | null
      : null;
    const visualRect = rect;
    setMessagePulse({ element: pulseElement, rect, visualRoot, visualRect });
    messagePulseTimerRef.current = setTimeout(() => {
      setMessagePulse(current => current?.element === pulseElement ? null : current);
      if (requestId === scrollRequestIdRef.current) messagePulseTimerRef.current = null;
    }, MESSAGE_PULSE_DURATION_MS);
    onShown?.(true);
  });
}

export function findMessageElements(container: HTMLElement, messageId: string): HTMLElement[] {
  const directElements = Array.from(container.querySelectorAll('[data-msgid]'))
    .filter(node => {
      const element = node as HTMLElement;
      if (element.getAttribute('data-msgid') === messageId) return true;
      return element.getAttribute('data-jump-msgids')?.split(/\s+/).includes(messageId) ?? false;
    }) as HTMLElement[];
  return directElements;
}

interface ScrollMsgToCenterDependencies {
  scrollRequestIdRef: React.MutableRefObject<number>;
  pendingScrollMsgIdRef: React.MutableRefObject<string | null>;
  MAX_SCROLL_ATTEMPTS: 60;
  pendingScrollDependencyIdsRef: React.MutableRefObject<string[]>;
  leftPanelRef: React.MutableRefObject<HTMLDivElement | null>;
  scrollRafRef: React.MutableRefObject<number | null>;
  findMessageElements: (container: HTMLElement, messageId: string) => HTMLElement[];
  relationsRef: React.MutableRefObject<Relation[]>;
  edgesRef: React.MutableRefObject<DemoEdge[]>;
  showMessagePulse: (targetId: string, element: HTMLElement, requestId?: number, onShown?: (shown: boolean) => void) => void;
  cancelScrollRafs: () => void;
}

export interface ScrollMessageOptions {
  dependencyIds?: string[];
  onComplete?: (located: boolean) => void;
}

export function scrollMsgToCenter(dependencies: ScrollMsgToCenterDependencies, msgId: string, options?: ScrollMessageOptions): void {
  const { scrollRequestIdRef, pendingScrollMsgIdRef, MAX_SCROLL_ATTEMPTS, pendingScrollDependencyIdsRef, leftPanelRef, scrollRafRef, findMessageElements, relationsRef, edgesRef, showMessagePulse, cancelScrollRafs } = dependencies;
  const targetId = msgId;
  const dependencyIds = options?.dependencyIds ?? [];
  const requestId = ++scrollRequestIdRef.current;
  pendingScrollMsgIdRef.current = targetId;
  let attempts = 0;
  const tryScroll = () => {
    attempts++;
    if (requestId !== scrollRequestIdRef.current) { options?.onComplete?.(false); return; }
    if (attempts > MAX_SCROLL_ATTEMPTS) {
      pendingScrollMsgIdRef.current = null;
      pendingScrollDependencyIdsRef.current = [];
      options?.onComplete?.(false);
      return;
    }
    if (pendingScrollMsgIdRef.current !== targetId) { options?.onComplete?.(false); return; }
    const container = leftPanelRef.current;
    if (!container) { scrollRafRef.current = requestAnimationFrame(tryScroll); return; }
    const containerRect = container.getBoundingClientRect();
    const viewportWidth = window.visualViewport?.width ?? window.innerWidth;
    const viewportHeight = window.visualViewport?.height ?? window.innerHeight;
    const containerOutsideViewport = containerRect.bottom <= 0
      || containerRect.top >= viewportHeight
      || containerRect.right <= 0
      || containerRect.left >= viewportWidth;
    if (containerOutsideViewport) {
      container.scrollIntoView({ block: 'nearest', inline: 'nearest' });
      scrollRafRef.current = requestAnimationFrame(tryScroll);
      return;
    }
    const dependencyReady = dependencyIds.every(dependencyId =>
      findMessageElements(container, dependencyId).some(element => {
        const rect = element.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
      }),
    );
    if (!dependencyReady) { scrollRafRef.current = requestAnimationFrame(tryScroll); return; }
    const targetRelation = relationsRef.current.find(relation => relation.id === targetId);
    const targetEdge = edgesRef.current.find(edge => edge.relationMessageId === targetId);
    const isDecorationTarget = targetRelation
      ? ['AGREE', 'DISAGREE', 'CORRECT'].includes(targetRelation.relationType.toUpperCase())
      || getPresentationSpec(targetRelation.relationType).kind === 'inline-badge'
      : ['AGREE', 'DISAGREE', 'CORRECT'].includes(targetEdge?.relationType?.toUpperCase() ?? '');
    const candidates = findMessageElements(container, targetId);
    const comparisonPair = container.querySelector('[data-comparison-pair]');
    const comparisonCandidates = candidates.filter(candidate => candidate.closest('[data-comparison-view="agree"]'));
    const overlayCandidates = candidates.filter(candidate => candidate.hasAttribute('data-rel-overlay'));
    const directOverlayCandidates = overlayCandidates.filter(candidate => candidate.getAttribute('data-msgid') === targetId);
    const overlayComparisonCandidates = comparisonCandidates.filter(candidate => candidate.hasAttribute('data-rel-overlay'));
    const preferredCandidates = isDecorationTarget
      ? (directOverlayCandidates.length > 0 ? directOverlayCandidates : overlayCandidates.length > 0 ? overlayCandidates : candidates)
      : candidates;
    const preferredComparisonCandidates = isDecorationTarget && overlayComparisonCandidates.length > 0
      ? overlayComparisonCandidates
      : comparisonCandidates;
    const el = comparisonPair
      ? preferredComparisonCandidates[0] ?? null
      : isDecorationTarget
        ? preferredCandidates[0] ?? null
        : preferredCandidates.find(candidate => !candidate.hasAttribute('data-rel-overlay')) ?? preferredCandidates[0] ?? null;
    if (!el) { scrollRafRef.current = requestAnimationFrame(tryScroll); return; }
    const elRect = el.getBoundingClientRect();
    if (elRect.width === 0 || elRect.height === 0) {
      scrollRafRef.current = requestAnimationFrame(tryScroll);
      return;
    }
    pendingScrollMsgIdRef.current = null;
    const comparisonView = el.closest('[data-comparison-view="agree"]');
    const comparisonViewport = comparisonView?.querySelector('[data-comparison-viewport="agree"]') as HTMLDivElement | null;
    const comparisonPairElement = comparisonView?.closest('[data-comparison-pair]');
    if (comparisonViewport && comparisonPairElement) {
      const comparisonViewportRect = comparisonViewport.getBoundingClientRect();
      const comparisonTargetTop = comparisonViewport.scrollTop + elRect.top - comparisonViewportRect.top + elRect.height / 2 - comparisonViewport.clientHeight / 2;
      const comparisonTargetLeft = comparisonViewport.scrollLeft + elRect.left - comparisonViewportRect.left + elRect.width / 2 - comparisonViewport.clientWidth / 2;
      const comparisonTop = Math.max(0, comparisonTargetTop);
      const comparisonLeft = Math.max(0, comparisonTargetLeft);
      const comparisonScrollTargets = comparisonPairElement.querySelectorAll('[data-comparison-viewport], [data-comparison-scroll-vertical]');
      comparisonScrollTargets.forEach(node => { (node as HTMLElement).scrollTop = comparisonTop; });
      const horizontalScroll = comparisonPairElement.querySelector('[data-comparison-scroll-horizontal]') as HTMLElement | null;
      const horizontalTargets = comparisonPairElement.querySelectorAll('[data-comparison-viewport], [data-comparison-scroll-horizontal]');
      horizontalTargets.forEach(node => { (node as HTMLElement).scrollLeft = comparisonLeft; });
      if (horizontalScroll) horizontalScroll.scrollLeft = comparisonLeft;
    } else {
      const elCenterX = elRect.left - containerRect.left + container.scrollLeft + elRect.width / 2;
      const elCenterY = elRect.top - containerRect.top + container.scrollTop + elRect.height / 2;
      container.scrollLeft = Math.max(0, Math.min(elCenterX - container.clientWidth / 2, container.scrollWidth - container.clientWidth));
      container.scrollTop = Math.max(0, Math.min(elCenterY - container.clientHeight / 2, container.scrollHeight - container.clientHeight));
    }
    // The left panel may itself be only partly visible in the browser viewport.
    // Re-read after the inner scroll, then move the outer page if the target is
    // still outside the actual viewport before creating the jump overlay.
    requestAnimationFrame(() => {
      if (requestId !== scrollRequestIdRef.current) { options?.onComplete?.(false); return; }
      let currentElement = el;
      if (!currentElement.isConnected) {
        const currentCandidates = findMessageElements(container, targetId);
        currentElement = currentCandidates.find(candidate =>
          isDecorationTarget && candidate.hasAttribute('data-rel-overlay')
          && candidate.getAttribute('data-msgid') === targetId,
        ) ?? currentCandidates.find(candidate => isDecorationTarget && candidate.hasAttribute('data-rel-overlay'))
          ?? currentCandidates[0];
      }
      if (!currentElement?.isConnected) { options?.onComplete?.(false); return; }
      const currentRect = currentElement.getBoundingClientRect();
      const viewportWidth = window.visualViewport?.width ?? window.innerWidth;
      const viewportHeight = window.visualViewport?.height ?? window.innerHeight;
      const targetOutsideViewport = currentRect.bottom <= 0
        || currentRect.top >= viewportHeight
        || currentRect.right <= 0
        || currentRect.left >= viewportWidth;
      if (targetOutsideViewport) {
        currentElement.scrollIntoView({ block: 'center', inline: 'nearest' });
        requestAnimationFrame(() => {
          if (requestId === scrollRequestIdRef.current) {
            showMessagePulse(targetId, currentElement, requestId, options?.onComplete);
          } else options?.onComplete?.(false);
        });
        return;
      }
      showMessagePulse(targetId, currentElement, requestId, options?.onComplete);
    });
    // The left panel handles the inner scroll; the target scrollIntoView above
    // handles the outer page when the panel itself is outside the viewport.
  };
  cancelScrollRafs();
  scrollRafRef.current = requestAnimationFrame(tryScroll);
}

export function clampAndSetScroll(container: HTMLDivElement | null, top: number | null, left: number | null): void {
  if (!container) return;
  const maxTop = Math.max(0, container.scrollHeight - container.clientHeight);
  const maxLeft = Math.max(0, container.scrollWidth - container.clientWidth);
  if (top !== null) container.scrollTop = Math.min(Math.max(0, top), maxTop);
  if (left !== null) container.scrollLeft = Math.min(Math.max(0, left), maxLeft);
}
