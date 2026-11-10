import { useEffect, useRef } from 'react';
import { useLocation, useSearchParams } from 'react-router-dom';

/** Keep shareable IDs in the URL; a cold start must wait for its data source. */
export function useMessageLinkNavigation(ready: boolean,
  navigate: (id: string, options: { recordHistory: false; enterCategory: boolean }) => void,
  handlesCurrentLocation?: () => boolean) {
  const [params] = useSearchParams();
  const { pathname } = useLocation();
  const target = params.get('msg')?.trim() || null;
  const locateOnly = params.get('locate') === '1';
  const settlement = params.get('settlement');
  const active = useRef<string | null>(null);
  const latest = useRef({ navigate, handlesCurrentLocation }); latest.current = { navigate, handlesCurrentLocation };
  useEffect(() => {
    const key = target && JSON.stringify([pathname, target, locateOnly]);
    if (!key || settlement) { active.current = null; return; }
    if (!ready || active.current === key) return;
    active.current = key;
    // Browser traversal restores the complete workbench snapshot, including its
    // viewport and draft selection. Its URL must not trigger a second navigation.
    if (!latest.current.handlesCurrentLocation?.()) latest.current.navigate(target!, { recordHistory: false, enterCategory: !locateOnly });
  }, [ready, pathname, target, locateOnly, settlement]);
}
