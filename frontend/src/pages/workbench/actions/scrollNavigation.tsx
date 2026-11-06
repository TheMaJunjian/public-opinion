import React from "react";
import type { Relation } from "../../../types";
import { getPresentationSpec } from "../../../types";
import type { WorkbenchDrawingTask } from '../../../context/WorkbenchDrawingContext';
import { REVEAL_VIRTUAL_MESSAGE, type VirtualMessageRevealDetail } from '../../../hooks/useVirtualMessageMounts';
import { getMessageJumpAnchor, getMessageJumpDisplay } from '../../../utils/messageJumpDisplay';
import { nearestScrollDelta } from '../../../utils/scrollVisibility';
import { LOCATE_RELATED_MESSAGE, type RelatedMessageLocation } from '../../../utils/relatedMessageNavigation';
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

export type MessagePulse = { messageId: string; element: HTMLElement; rect: DOMRect };

interface ShowMessagePulseDependencies {
  task?: WorkbenchDrawingTask | null;
  releaseVirtualMessage?: boolean;
  scrollRequestIdRef: React.MutableRefObject<number>;
  messagePulseTimerRef: React.MutableRefObject<number | null>;
  messagePulseRafRef: React.MutableRefObject<number | null>;
  leftPanelRef: React.MutableRefObject<HTMLDivElement | null>;
  findMessageElements: (container: HTMLElement, messageId: string) => HTMLElement[];
  setMessagePulse: React.Dispatch<React.SetStateAction<MessagePulse | null>>;
}

export const MESSAGE_PULSE_DURATION_MS = 400;

export function showMessagePulse(dependencies: ShowMessagePulseDependencies, targetId: string, element: HTMLElement, requestId = dependencies.scrollRequestIdRef.current, onShown?: (shown: boolean) => void): void {
  if (element.hasAttribute('data-related-messages-trigger')) {
    const detail: RelatedMessageLocation = { messageId: targetId, onLocated: row => {
      if (!row || requestId !== dependencies.scrollRequestIdRef.current) { onShown?.(false); return; }
      showMessagePulse({ ...dependencies, releaseVirtualMessage: false }, targetId, row, requestId, onShown);
    } };
    element.dispatchEvent(new CustomEvent(LOCATE_RELATED_MESSAGE, { detail }));
    if (!detail.handled) onShown?.(false);
    return;
  }
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
        pulseElement = currentCandidates.find(candidate=>candidate.hasAttribute('data-directed-edge-label')) ?? currentCandidates.find(candidate=>candidate.hasAttribute('data-directed-edge-start')) ?? currentCandidates.find(candidate =>
          candidate.hasAttribute('data-rel-overlay') && candidate.getAttribute('data-msgid') === targetId,
        ) ?? currentCandidates[0];
      }
      if (!pulseElement?.isConnected) { onShown?.(false); return; }
      pulseElement=getMessageJumpAnchor(pulseElement,targetId);
      const targetElements = pulseElement.closest('[data-related-messages-popup]') ? [pulseElement] : pulseElement.hasAttribute('data-rel-overlay')
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
        if (dependencies.releaseVirtualMessage !== false) leftPanelRef.current?.dispatchEvent(new CustomEvent(REVEAL_VIRTUAL_MESSAGE, { detail: { ids: [] } }));
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
  const directElements = Array.from(container.querySelectorAll('[data-msgid], [data-directed-edge-start], [data-related-messages-trigger]'))
    .filter(node => {
      const element = node as HTMLElement;
      if (element.getAttribute('data-msgid') === messageId) return true;
      return element.getAttribute('data-jump-msgids')?.split(/\s+/).includes(messageId) ?? false;
    }) as HTMLElement[];
  // A frame has four border hit strips and a real message header. Center the
  // header so wide/tall frames cannot place the message card outside the view.
  return directElements.sort((a, b) => Number(b.hasAttribute('data-frame-header')) - Number(a.hasAttribute('data-frame-header')));
}

function visibleViewport(element: HTMLElement, container: HTMLElement, includeSelf = false) {
  const viewport = window.visualViewport;
  let left = viewport?.offsetLeft ?? 0;
  let top = viewport?.offsetTop ?? 0;
  let right = left + (viewport?.width ?? window.innerWidth);
  let bottom = top + (viewport?.height ?? window.innerHeight);
  // A card can be inside the browser viewport while still clipped by its pane
  // or a nested comparison viewport.
  for (let parent: HTMLElement | null = includeSelf ? element : element.parentElement; parent; parent = parent.parentElement) {
    const style = getComputedStyle(parent);
    const clipsX = parent === container || /auto|scroll|hidden|clip/.test(style.overflowX || style.overflow);
    const clipsY = parent === container || /auto|scroll|hidden|clip/.test(style.overflowY || style.overflow);
    if (!clipsX && !clipsY) continue;
    const bounds = parent.getBoundingClientRect();
    if (clipsX) { left = Math.max(left, bounds.left); right = Math.min(right, bounds.right); }
    if (clipsY) { top = Math.max(top, bounds.top); bottom = Math.min(bottom, bounds.bottom); }
  }
  return { left, top, right, bottom };
}

function viewportContainsTarget(element: HTMLElement, container: HTMLElement): boolean {
  const rect = element.getBoundingClientRect(), { left, top, right, bottom } = visibleViewport(element, container);
  const axisVisible = (start: number, end: number, min: number, max: number) => max > min
    && Math.abs(nearestScrollDelta(start, end, min, max)) <= 1;
  return rect.width > 0 && rect.height > 0
    && axisVisible(rect.left, rect.right, left, right) && axisVisible(rect.top, rect.bottom, top, bottom);
}

function messageNavigationElements(container: HTMLElement, messageId: string, relations: Relation[], edges: DemoEdge[], findElements = findMessageElements): HTMLElement[] {
  const relation = relations.find(relation => relation.id === messageId);
  const edge = edges.find(edge => edge.relationMessageId === messageId);
  const type = relation?.relationType ?? edge?.relationType ?? '';
  const decoration = ['AGREE', 'DISAGREE', 'CORRECT'].includes(type.toUpperCase()) || getPresentationSpec(type).kind === 'inline-badge';
  const mounted = findElements(container, messageId);
  const measurable = mounted.filter(element => { const rect = element.getBoundingClientRect(); return rect.width > 0 && rect.height > 0; });
  const candidates = measurable.length ? measurable : mounted;
  const overlays = candidates.filter(element => element.hasAttribute('data-rel-overlay'));
  const directOverlays = overlays.filter(element => element.getAttribute('data-msgid') === messageId);
  if (decoration) return directOverlays.length ? directOverlays : overlays.length ? overlays : candidates;
  // The label/header is the message's reading anchor. A visible curve start or
  // frame border must not hide the fact that its actual label/card is clipped.
  for (const attribute of ['data-directed-edge-label', 'data-directed-edge-start', 'data-frame-header']) {
    const anchors = candidates.filter(element => element.hasAttribute(attribute));
    if (anchors.length) return anchors;
  }
  const cards = candidates.filter(element => !element.hasAttribute('data-rel-overlay'));
  return cards.length ? cards : candidates;
}

/** Reuse a mounted reading anchor only when its pane and all enclosing clips expose it. */
export function findVisibleMessageElement(container: HTMLElement | null, messageId: string, relations: Relation[] = [], edges: DemoEdge[] = []): HTMLElement | null {
  if (!container) return null;
  const relation = relations.find(relation => relation.id === messageId);
  const candidates = messageNavigationElements(container, messageId, relations, edges);
  const summaries = findMessageElements(container, messageId).filter(element => element.hasAttribute('data-related-messages-trigger'));
  return [...candidates, ...summaries].find(element => {
    if (element.hasAttribute('data-directed-edge-start')) return false;
    if (relation && getPresentationSpec(relation.relationType).isContainer && element.hasAttribute('data-rel-overlay') && !element.hasAttribute('data-frame-header')) return false;
    const visibility = getComputedStyle(element).visibility;
    return visibility !== 'hidden' && visibility !== 'collapse' && viewportContainsTarget(element, container);
  }) ?? null;
}

function scrollScale(element: HTMLElement, rect: DOMRect) {
  return {
    x: element.offsetWidth > 0 ? rect.width / element.offsetWidth : 1,
    y: element.offsetHeight > 0 ? rect.height / element.offsetHeight : 1,
  };
}

function nearestScrollOffsets(viewport: HTMLElement, target: DOMRect, center = false) {
  const scale = scrollScale(viewport, viewport.getBoundingClientRect());
  const visible = visibleViewport(viewport, viewport, true);
  const delta = (start: number, end: number, min: number, max: number) => center
    ? (end - start > max - min ? start - min : (start + end - min - max) / 2)
    : nearestScrollDelta(start, end, min, max);
  return {
    left: Math.max(0, Math.min(viewport.scrollLeft + delta(target.left, target.right, visible.left, visible.right) / scale.x,
      Math.max(0, viewport.scrollWidth - viewport.clientWidth))),
    top: Math.max(0, Math.min(viewport.scrollTop + delta(target.top, target.bottom, visible.top, visible.bottom) / scale.y,
      Math.max(0, viewport.scrollHeight - viewport.clientHeight))),
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
  align?: 'nearest' | 'center';
  onComplete?: (located: boolean, cancelled?: boolean) => void;
}

/** Locate with minimal scrolling after the destination's layout and measurement commit. */
export function scrollMsgToCenter(dependencies: ScrollMsgToCenterDependencies, msgId: string, options?: ScrollMessageOptions): void {
  const { scrollRequestIdRef, pendingScrollMsgIdRef, MAX_SCROLL_ATTEMPTS, pendingScrollDependencyIdsRef, leftPanelRef, scrollRafRef, findMessageElements, relationsRef, edgesRef, showMessagePulse, cancelScrollRafs } = dependencies;
  const targetId = msgId;
  const dependencyIds = options?.dependencyIds ?? [];
  const requestId = ++scrollRequestIdRef.current;
  pendingScrollMsgIdRef.current = targetId;
  let attempts = 0;
  let completed = false;
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
  const complete = (located: boolean, cancelled = false) => {
    if (completed) return;
    completed = true;
    if (!located && requestId === scrollRequestIdRef.current) {
      pendingScrollMsgIdRef.current = null;
      pendingScrollDependencyIdsRef.current = [];
      leftPanelRef.current?.dispatchEvent(new CustomEvent(REVEAL_VIRTUAL_MESSAGE, { detail: { ids: [] } }));
    }
    task?.complete();
    if (cancelled) options?.onComplete?.(false, true);
    else options?.onComplete?.(located);
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
    const visibleElement = options?.align !== 'center' && dependencyIds.length === 0
      ? findVisibleMessageElement(container, targetId, relationsRef.current, edgesRef.current) : null;
    if (visibleElement) {
      pendingScrollMsgIdRef.current = null;
      showMessagePulse(targetId, visibleElement, requestId, complete);
      return;
    }
    const reveal: VirtualMessageRevealDetail = { ids: [targetId, ...dependencyIds] };
    container.dispatchEvent(new CustomEvent(REVEAL_VIRTUAL_MESSAGE, { detail: reveal }));
    if (reveal.positioningPending) { afterLayout(tryScroll); return; }
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
    const findTargetElement = (scope = container) => messageNavigationElements(scope, targetId, relationsRef.current, edgesRef.current, findMessageElements)[0] ?? null;
    const el = findTargetElement();
    if (!el) { scrollRafRef.current = nextFrame(tryScroll); return; }
    const elRect = el.getBoundingClientRect();
    if (elRect.width === 0 || elRect.height === 0) {
      scrollRafRef.current = nextFrame(tryScroll);
      return;
    }
    // A comparison aligns message identities, never pixel offsets. Each pane
    // may place the same message in a different frame, row or column.
    const pair = container.querySelector('[data-comparison-pair]');
    const scopes = pair ? Array.from(pair.querySelectorAll<HTMLDivElement>('[data-comparison-viewport]')) : [container];
    const destinations = scopes.flatMap(scope => {
      const element = findTargetElement(scope);
      return element ? [{ scope, element }] : [];
    });
    for (const { scope, element } of destinations) {
      const next = nearestScrollOffsets(scope, element.getBoundingClientRect(), options?.align === 'center');
      scope.scrollLeft = next.left;
      scope.scrollTop = next.top;
    }
    // The left panel may itself be only partly visible in the browser viewport.
    // Re-read after the inner scroll, then move the outer page if the target is
    // still outside the actual viewport before creating the jump overlay.
    const verify = (afterNativeScroll = false) => {
      if (requestId !== scrollRequestIdRef.current) { complete(false); return; }
      // Revealing an arrangement can mount its card after the border was
      // already found. Reveal that committed card before showing the pulse.
      const currentElement = findTargetElement();
      if (!currentElement?.isConnected || currentElement !== el || destinations.some(({ scope, element }) => findTargetElement(scope) !== element)) { scrollRafRef.current = nextFrame(tryScroll); return; }
      const clipped = destinations.filter(({ scope, element }) => !viewportContainsTarget(element, scope));
      if (clipped.length) {
        if (afterNativeScroll) { scrollRafRef.current = nextFrame(tryScroll); return; }
        for (const { scope, element } of clipped) {
          const rect = element.getBoundingClientRect(), viewport = visibleViewport(element, scope);
          element.scrollIntoView({ behavior: 'instant',
            block: rect.height > viewport.bottom - viewport.top ? 'start' : 'nearest',
            inline: rect.width > viewport.right - viewport.left ? 'start' : 'nearest' });
        }
        // Native scrolling can also adjust nested panes and the outer page.
        // Verify that result before scrolling again, which could undo it.
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
    complete(false, true);
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
