import type { WorkbenchDrawingTask } from '../../../context/WorkbenchDrawingContext';
import type { Dispatch, SetStateAction } from 'react';
import type { DemoEdge, DemoMessage } from '../../../utils/modelBridge';
import { findMessageElements, scrollMsgToCenter, showMessagePulse, type MessagePulse } from './scrollNavigation';

/** If a message disappears, locate the nearest remaining enclosing frame. */
export function comparisonNavigationTarget(id: string, messages: DemoMessage[], edges: DemoEdge[], hidden?: ReadonlySet<string>) {
  const available = new Set(messages.filter(message => !hidden?.has(message.id)).map(message => message.id));
  if (available.has(id)) return { id, missing: false };
  const parents = new Map<string, string[]>();
  for (const edge of edges) if (['classify', 'summary', 'merge', 'arrange'].includes(edge.relationType)) {
    parents.set(edge.to.messageId, [...parents.get(edge.to.messageId) ?? [], edge.relationMessageId]);
  }
  const visited = new Set([id]), queue = [...parents.get(id) ?? []];
  for (let index = 0; index < queue.length; index++) {
    const parent = queue[index];
    if (visited.has(parent)) continue;
    if (available.has(parent)) return { id: parent, missing: true };
    visited.add(parent);
    queue.push(...parents.get(parent) ?? []);
  }
  // A removed decoration/edge can still be compared at its target message.
  for (const edge of edges.filter(edge => edge.relationMessageId === id)) {
    for (const host of [edge.to.messageId, edge.from.messageId]) if (available.has(host)) return { id: host, missing: true };
  }
  return { id: null, missing: true };
}

/** Each call owns its reveal, scroll request and cancellation; no cross-pane offsets. */
export function navigateComparisonPane(viewport: HTMLDivElement, messageId: string, edges: DemoEdge[],
  startPositioning: () => WorkbenchDrawingTask, missing = false, setPulse?: Dispatch<SetStateAction<MessagePulse | null>>) {
  const request = { current: 0 }, raf = { current: null as number | null };
  const pulseRaf = { current: null as number | null }, pulseTimer = { current: null as number | null };
  let task: WorkbenchDrawingTask | undefined;
  const cancelRaf = () => { if (raf.current !== null) cancelAnimationFrame(raf.current); raf.current = null; };
  const findElements = missing ? (container: HTMLElement) => Array.from(container.querySelectorAll<HTMLElement>('[data-comparison-missing]')) : findMessageElements;
  scrollMsgToCenter({
    startPositioning: () => (task = startPositioning()),
    scrollRequestIdRef: request,
    pendingScrollMsgIdRef: { current: null },
    pendingScrollDependencyIdsRef: { current: [] },
    MAX_SCROLL_ATTEMPTS: 60,
    leftPanelRef: { current: viewport },
    scrollRafRef: raf,
    findMessageElements: findElements,
    relationsRef: { current: [] }, edgesRef: { current: edges },
    showMessagePulse: (id, element, requestId, done) => setPulse ? showMessagePulse({
      task, releaseVirtualMessage: false, scrollRequestIdRef: request, messagePulseRafRef: pulseRaf, messagePulseTimerRef: pulseTimer,
      leftPanelRef: { current: viewport }, findMessageElements: findElements, setMessagePulse: setPulse,
    }, id, element, requestId, done) : done?.(true),
    cancelScrollRafs: cancelRaf,
  }, messageId, { align: 'center' });
  return () => {
    request.current++; cancelRaf(); task?.cancel();
    if (pulseRaf.current !== null) cancelAnimationFrame(pulseRaf.current);
    if (pulseTimer.current !== null) clearTimeout(pulseTimer.current);
    setPulse?.(null);
  };
}
