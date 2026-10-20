import { useMemo, useRef, type ReactNode } from 'react';
import { useCardMeasurements } from '../hooks/useCardMeasurements';
import { useVirtualMessageMounts } from '../hooks/useVirtualMessageMounts';
import type { Box } from '../utils/frameLayout';

/** Cached row sizes preserve the scroll range while offscreen rows leave the DOM. */
export default function VirtualMessageList({ ids, pinned, children }: {
  ids: string[]; pinned: ReadonlySet<string>; children(id: string): ReactNode;
}) {
  const surface = useRef<HTMLDivElement>(null);
  const refs = useRef<Record<string, HTMLDivElement | null>>({});
  const heights = useCardMeasurements(surface, refs);
  const { boxes, height } = useMemo(() => {
    let top = 0;
    const boxes: Record<string, Box> = {};
    for (const id of ids) {
      const height = heights[id] ?? 86;
      boxes[id] = { x: 0, y: top, width: 1, height };
      top += height + 6;
    }
    return { boxes, height: Math.max(0, top - 6) };
  }, [ids, heights]);
  const virtual = useVirtualMessageMounts(surface, ids, boxes, heights, pinned, true);
  return <div ref={surface} data-virtual-message-list="true" style={{ position: 'relative', height, width: '100%' }}>
    {ids.filter(id => virtual.mounted.has(id)).map(id => <div key={id} data-measure-id={id} data-measure-min-height="1"
      ref={element => { refs.current[id] = element; }} aria-hidden={!virtual.isOnscreen(id) || undefined}
      style={{ position: 'absolute', top: boxes[id].y, left: 0, width: '100%', visibility: virtual.isOnscreen(id) ? undefined : 'hidden' }}>
      {children(id)}
    </div>)}
  </div>;
}
