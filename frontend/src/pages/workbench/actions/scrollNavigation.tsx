import React from "react";
import type { Relation } from "../../../types";
import { getPresentationSpec } from "../../../types";
import type { WorkbenchDrawingTask } from '../../../context/WorkbenchDrawingContext';
import { REVEAL_VIRTUAL_MESSAGE } from '../../../hooks/useVirtualMessageMounts';
import { getMessageJumpDisplay } from '../../../utils/messageJumpDisplay';
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

export function scheduleViewNavigation(dependencies: ScheduleViewNavigationDependencies, targetId: string, delay = 100): void {
  const { viewNavigationTimerRef, scrollMsgToCenter } = dependencies;
  if (viewNavigationTimerRef.current !== null) {
    clearTimeout(viewNavigationTimerRef.current);
  }
  viewNavigationTimerRef.current = setTimeout(() => {
    viewNavigationTimerRef.current = null;
    scrollMsgToCenter(targetId);
  }, delay);
}

interface ShowMessagePulseDependencies {
  task?: WorkbenchDrawingTask | null;
  scrollRequestIdRef: React.MutableRefObject<number>;
  messagePulseTimerRef: React.MutableRefObject<number | null>;
  messagePulseRafRef: React.MutableRefObject<number | null>;
  leftPanelRef: React.MutableRefObject<HTMLDivElement | null>;
  findMessageElements: (container: HTMLElement, messageId: string) => HTMLElement[];
  setMessagePulse: React.Dispatch<React.SetStateAction<{ messageId: string; element: HTMLElement; rect: DOMRect; } | null>>;
}

export const MESSAGE_PULSE_DURATION_MS = 400;

export function showMessagePulse(dependencies: ShowMessagePulseDependencies, targetId: string, element: HTMLElement, requestId = dependencies.scrollRequestIdRef.current, onShown?: (shown: boolean) => void): void {
  const { scrollRequestIdRef, messagePulseTimerRef, messagePulseRafRef, leftPanelRef, findMessageElements, setMessagePulse } = dependencies;
  if (messagePulseTimerRef.current) clearTimeout(messagePulseTimerRef.current);
  if (messagePulseRafRef.current) cancelAnimationFrame(messagePulseRafRef.current);
  messagePulseRafRef.current = requestAnimationFrame(() => {
    const show = () => {
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
      const targetRect = targetRects.reduce((bounds, candidateRect) => {
        const left = Math.min(bounds.left, candidateRect.left);
        const top = Math.min(bounds.top, candidateRect.top);
        const right = Math.max(bounds.right, candidateRect.right);
        const bottom = Math.max(bounds.bottom, candidateRect.bottom);
        return new DOMRect(left, top, right - left, bottom - top);
      }, pulseElement.getBoundingClientRect());
      const { rect } = getMessageJumpDisplay(pulseElement, targetId, targetRect);
      setMessagePulse({ messageId: targetId, element: pulseElement, rect });
      messagePulseTimerRef.current = setTimeout(() => {
        if (requestId !== scrollRequestIdRef.current) return;
        setMessagePulse(current => current?.element === pulseElement ? null : current);
        messagePulseTimerRef.current = null;
        leftPanelRef.current?.dispatchEvent(new CustomEvent(REVEAL_VIRTUAL_MESSAGE, { detail: { ids: [] } }));
      }, MESSAGE_PULSE_DURATION_MS);
      onShown?.(true);
    };
    if (dependencies.task?.afterLayout) dependencies.task.afterLayout(show);
    else if (dependencies.task) dependencies.task.run(show);
    else show();
  });
  dependencies.task?.onCancel(() => {
    if (messagePulseRafRef.current !== null) cancelAnimationFrame(messagePulseRafRef.current);
    messagePulseRafRef.current = null;
  });
}

export function findMessageElements(container: HTMLElement, messageId: string): HTMLElement[] {
  const directElements = Array.from(container.querySelectorAll('[data-msgid]'))
    .filter(node => {
      const element = node as HTMLElement;
      if (element.getAttribute('data-msgid') === messageId) return true;
      return element.getAttribute('data-jump-msgids')?.split(/\s+/).includes(messageId) ?? false;
    }) as HTMLElement[];
  // A frame has four border hit strips and a real message header. Center the
  // header so wide/tall frames cannot place the message card outside the view.
  return directElements.sort((a, b) => Number(b.hasAttribute('data-frame-header')) - Number(a.hasAttribute('data-frame-header')));
}

function viewportContainsTarget(element: HTMLElement, container: HTMLElement): boolean {
  const rect = element.getBoundingClientRect();
  const viewport = window.visualViewport;
  let left = viewport?.offsetLeft ?? 0;
  let top = viewport?.offsetTop ?? 0;
  let right = left + (viewport?.width ?? window.innerWidth);
  let bottom = top + (viewport?.height ?? window.innerHeight);
  // A card can be inside the browser viewport while still clipped by its pane
  // or a nested comparison viewport.
  for (let parent = element.parentElement; parent; parent = parent.parentElement) {
    const style = getComputedStyle(parent);
    const clipsX = parent === container || /auto|scroll|hidden|clip/.test(style.overflowX);
    const clipsY = parent === container || /auto|scroll|hidden|clip/.test(style.overflowY);
    if (!clipsX && !clipsY) continue;
    const bounds = parent.getBoundingClientRect();
    if (clipsX) { left = Math.max(left, bounds.left); right = Math.min(right, bounds.right); }
    if (clipsY) { top = Math.max(top, bounds.top); bottom = Math.min(bottom, bounds.bottom); }
  }
  // Oversized messages cannot fit in full; their center must still be visible.
  const axisVisible = (start: number, end: number, min: number, max: number) => max > min && (end - start <= max - min
    ? start >= min - 1 && end <= max + 1
    : (start + end) / 2 >= min && (start + end) / 2 <= max);
  return rect.width > 0 && rect.height > 0
    && axisVisible(rect.left, rect.right, left, right) && axisVisible(rect.top, rect.bottom, top, bottom);
}

function scrollScale(element: HTMLElement, rect: DOMRect) {
  return {
    x: element.offsetWidth > 0 ? rect.width / element.offsetWidth : 1,
    y: element.offsetHeight > 0 ? rect.height / element.offsetHeight : 1,
  };
}

interface ScrollMsgToCenterDependencies {
  startPositioning?: () => WorkbenchDrawingTask;
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
  const run = (work: () => void) => { if (task) task.run(work); else work(); };
  const nextFrame = (work: () => void) => {
    const frame = requestAnimationFrame(() => run(work));
    task?.onCancel(() => cancelAnimationFrame(frame));
    return frame;
  };
  const afterLayout = (work: () => void) => {
    if (task?.afterLayout) task.afterLayout(work);
    else scrollRafRef.current = nextFrame(work);
  };
  const complete = (located: boolean) => {
    if (!located && requestId === scrollRequestIdRef.current) leftPanelRef.current?.dispatchEvent(new CustomEvent(REVEAL_VIRTUAL_MESSAGE, { detail: { ids: [] } }));
    task?.complete(); options?.onComplete?.(located);
  };
  const tryScroll = () => {
    attempts++;
    if (requestId !== scrollRequestIdRef.current) { complete(false); return; }
    if (attempts > MAX_SCROLL_ATTEMPTS) {
      pendingScrollMsgIdRef.current = null;
      pendingScrollDependencyIdsRef.current = [];
      complete(false);
      return;
    }
    if (pendingScrollMsgIdRef.current !== targetId) { complete(false); return; }
    const container = leftPanelRef.current;
    if (!container) { scrollRafRef.current = nextFrame(tryScroll); return; }
    container.dispatchEvent(new CustomEvent(REVEAL_VIRTUAL_MESSAGE, { detail: { ids: [targetId, ...dependencyIds] } }));
    const containerRect = container.getBoundingClientRect();
    const viewportWidth = window.visualViewport?.width ?? window.innerWidth;
    const viewportHeight = window.visualViewport?.height ?? window.innerHeight;
    const containerOutsideViewport = containerRect.bottom <= 0
      || containerRect.top >= viewportHeight
      || containerRect.right <= 0
      || containerRect.left >= viewportWidth;
    if (containerOutsideViewport) {
      container.scrollIntoView({ block: 'nearest', inline: 'nearest' });
      scrollRafRef.current = nextFrame(tryScroll);
      return;
    }
    const dependencyReady = dependencyIds.every(dependencyId =>
      findMessageElements(container, dependencyId).some(element => {
        const rect = element.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
      }),
    );
    if (!dependencyReady) { scrollRafRef.current = nextFrame(tryScroll); return; }
    const targetRelation = relationsRef.current.find(relation => relation.id === targetId);
    const targetEdge = edgesRef.current.find(edge => edge.relationMessageId === targetId);
    const isDecorationTarget = targetRelation
      ? ['AGREE', 'DISAGREE', 'CORRECT'].includes(targetRelation.relationType.toUpperCase())
      || getPresentationSpec(targetRelation.relationType).kind === 'inline-badge'
      : ['AGREE', 'DISAGREE', 'CORRECT'].includes(targetEdge?.relationType?.toUpperCase() ?? '');
    const findTargetElement = () => {
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
      return comparisonPair
        ? preferredComparisonCandidates[0] ?? null
        : isDecorationTarget
          ? preferredCandidates[0] ?? null
          : preferredCandidates.find(candidate => !candidate.hasAttribute('data-rel-overlay')) ?? preferredCandidates[0] ?? null;
    };
    const el = findTargetElement();
    if (!el) { scrollRafRef.current = nextFrame(tryScroll); return; }
    const elRect = el.getBoundingClientRect();
    if (elRect.width === 0 || elRect.height === 0) {
      scrollRafRef.current = nextFrame(tryScroll);
      return;
    }
    const comparisonView = el.closest('[data-comparison-view="agree"]');
    const comparisonViewport = comparisonView?.querySelector('[data-comparison-viewport="agree"]') as HTMLDivElement | null;
    const comparisonPairElement = comparisonView?.closest('[data-comparison-pair]');
    if (comparisonViewport && comparisonPairElement) {
      const comparisonViewportRect = comparisonViewport.getBoundingClientRect();
      const scale = scrollScale(comparisonViewport, comparisonViewportRect);
      const comparisonTargetTop = comparisonViewport.scrollTop + (elRect.top - comparisonViewportRect.top + elRect.height / 2) / scale.y - comparisonViewport.clientHeight / 2;
      const comparisonTargetLeft = comparisonViewport.scrollLeft + (elRect.left - comparisonViewportRect.left + elRect.width / 2) / scale.x - comparisonViewport.clientWidth / 2;
      const comparisonTop = Math.max(0, comparisonTargetTop);
      const comparisonLeft = Math.max(0, comparisonTargetLeft);
      const comparisonScrollTargets = comparisonPairElement.querySelectorAll('[data-comparison-viewport], [data-comparison-scroll-vertical]');
      comparisonScrollTargets.forEach(node => { (node as HTMLElement).scrollTop = comparisonTop; });
      const horizontalScroll = comparisonPairElement.querySelector('[data-comparison-scroll-horizontal]') as HTMLElement | null;
      const horizontalTargets = comparisonPairElement.querySelectorAll('[data-comparison-viewport], [data-comparison-scroll-horizontal]');
      horizontalTargets.forEach(node => { (node as HTMLElement).scrollLeft = comparisonLeft; });
      if (horizontalScroll) horizontalScroll.scrollLeft = comparisonLeft;
    } else {
      const scale = scrollScale(container, containerRect);
      const elCenterX = (elRect.left - containerRect.left + elRect.width / 2) / scale.x + container.scrollLeft;
      const elCenterY = (elRect.top - containerRect.top + elRect.height / 2) / scale.y + container.scrollTop;
      container.scrollLeft = Math.max(0, Math.min(elCenterX - container.clientWidth / 2, container.scrollWidth - container.clientWidth));
      container.scrollTop = Math.max(0, Math.min(elCenterY - container.clientHeight / 2, container.scrollHeight - container.clientHeight));
    }
    // The left panel may itself be only partly visible in the browser viewport.
    // Re-read after the inner scroll, then move the outer page if the target is
    // still outside the actual viewport before creating the jump overlay.
    const verify = (afterNativeScroll = false) => {
      if (requestId !== scrollRequestIdRef.current) { complete(false); return; }
      // Revealing an arrangement can mount its card after the border was
      // already found. Center that committed card before showing the pulse.
      const currentElement = findTargetElement();
      if (!currentElement?.isConnected || currentElement !== el) { scrollRafRef.current = nextFrame(tryScroll); return; }
      if (!viewportContainsTarget(currentElement, container)) {
        if (afterNativeScroll) { scrollRafRef.current = nextFrame(tryScroll); return; }
        currentElement.scrollIntoView({ behavior: 'instant', block: 'center', inline: 'center' });
        // Native scrolling can also adjust nested panes and the outer page.
        // Verify that result before centering again, which could undo it.
        afterLayout(() => verify(true));
        return;
      }
      pendingScrollMsgIdRef.current = null;
      showMessagePulse(targetId, currentElement, requestId, complete);
    };
    afterLayout(verify);
    // The left panel handles the inner scroll; the target scrollIntoView above
    // handles the outer page when the panel itself is outside the viewport.
  };
  cancelScrollRafs();
  const task = dependencies.startPositioning?.();
  task?.onCancel(() => {
    if (requestId === scrollRequestIdRef.current) leftPanelRef.current?.dispatchEvent(new CustomEvent(REVEAL_VIRTUAL_MESSAGE, { detail: { ids: [] } }));
  });
  // Measurement can move an already mounted card. Position only after the
  // destination scene has committed, then verify the resulting visible area.
  afterLayout(tryScroll);
}

export function clampAndSetScroll(container: HTMLDivElement | null, top: number | null, left: number | null): void {
  if (!container) return;
  const maxTop = Math.max(0, container.scrollHeight - container.clientHeight);
  const maxLeft = Math.max(0, container.scrollWidth - container.clientWidth);
  if (top !== null) container.scrollTop = Math.min(Math.max(0, top), maxTop);
  if (left !== null) container.scrollLeft = Math.min(Math.max(0, left), maxLeft);
}
