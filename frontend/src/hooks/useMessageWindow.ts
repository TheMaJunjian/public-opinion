import { useCallback, useEffect, useMemo, useState } from 'react';
import type { DemoMessage, DemoEdge } from '../utils/modelBridge';

/** Limit mounted cards only; all semantic projections keep the complete catalog. */
export function useMessageWindow(messages: DemoMessage[], edges: DemoEdge[], enabled: boolean, key: string, pinned: string[], retain = false) {
  const [page, setPage] = useState({ key, limit: 50 });
  useEffect(() => {
    if (retain) setPage(previous => previous.key === key && previous.limit >= messages.length ? previous
      : { key, limit: Math.max(50, messages.length) });
  }, [retain, key, messages.length]);
  const limit = page.key === key ? page.limit : 50;
  const pinnedKey = pinned.join('\0');
  const visible = useMemo(() => {
    if (!enabled || messages.length <= limit) return messages;
    const pins = new Set(pinned);
    return messages.filter((message, index) => index < limit || pins.has(message.id));
  }, [messages, enabled, limit, pinnedKey]);
  const visibleEdges = useMemo(() => {
    if (visible === messages) return edges;
    const ids = new Set(visible.map(message => message.id));
    return edges.filter(edge => ids.has(edge.relationMessageId)
      || (ids.has(edge.to.messageId) && (ids.has(edge.from.messageId) || edge.from.messageId.startsWith('anon:'))));
  }, [edges, messages, visible]);
  const more = useCallback(async () => { setPage(previous => ({ key, limit: (previous.key === key ? previous.limit : 50) + 50 })); }, [key]);
  return { messages: visible, edges: visibleEdges, hasMore: visible.length < messages.length, more };
}
