import { Suspense, useCallback, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { WorkbenchPortalContext } from '../context/WorkbenchPortalContext';
import { DEFAULT_VIEW_CACHE_LIMIT, useViewCacheSettings } from '../context/ViewCacheSettingsContext';

export const RECENT_WORKBENCH_VIEW_LIMIT = DEFAULT_VIEW_CACHE_LIMIT;
type Entry = { key: string; host: HTMLDivElement; overlays: HTMLDivElement; content: ReactNode };

/** Suspension retains component state and disconnects layout effects while parked. */
function RetainedView({ active, children }: { active: boolean; children: ReactNode }) {
  const [parked] = useState(() => new Promise<void>(() => {}));
  if (!active) throw parked;
  return children;
}

/** Only the active portal is attached, so navigation never measures a cached scene. */
export default function RecentWorkbenchViews({ viewKey, children, limit, ownerKey }: {
  viewKey: string; children: ReactNode; limit?: number; ownerKey?:unknown;
}) {
  const settings = useViewCacheSettings();
  const capacity = limit ?? settings.limit;
  const committed = useRef(new Map<string, Entry>());
  const owner = useRef(ownerKey);
  const attached = useRef<Entry>();
  const entries = new Map(owner.current===ownerKey?committed.current:[]);
  const active = entries.get(viewKey) ?? { key: viewKey, host: document.createElement('div'), overlays: document.createElement('div'), content: children };
  const current = { ...active, content: children };
  current.host.style.display = 'contents';
  current.overlays.style.display = 'contents';
  entries.delete(viewKey);
  entries.set(viewKey, current);
  while (entries.size > Math.max(1, capacity)) entries.delete(entries.keys().next().value!);
  useLayoutEffect(() => { committed.current = entries; owner.current=ownerKey; });
  // This ref precedes portal layout effects, including on the first mount.
  const attach = useCallback((node: HTMLDivElement | null) => {
    attached.current?.overlays.remove();
    attached.current = node ? current : undefined;
    if (node) { node.replaceChildren(current.host); document.body.appendChild(current.overlays); }
  }, [current.host]);
  return <>
    <div ref={attach} data-workbench-view-cache data-cached-view-count={entries.size} style={{ display: 'contents' }} />
    {[...entries.values()].map(entry => createPortal(
      <WorkbenchPortalContext.Provider value={entry.overlays}>
        <Suspense fallback={null}><RetainedView active={entry.key === viewKey}>{entry.content}</RetainedView></Suspense>
      </WorkbenchPortalContext.Provider>,
      entry.host, entry.key,
    ))}
  </>;
}
