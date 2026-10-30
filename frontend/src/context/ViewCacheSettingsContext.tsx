import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';

export const VIEW_CACHE_LIMIT_KEY = 'gonglun:view-cache-limit:v1';
export const VIEW_CACHE_LIMIT_OPTIONS = [4, 8, 12, 20] as const;
export const DEFAULT_VIEW_CACHE_LIMIT = 4;
const validLimit = (value: number) => VIEW_CACHE_LIMIT_OPTIONS.some(option => option === value);
function readLimit() {
  try {
    const value = Number(localStorage.getItem(VIEW_CACHE_LIMIT_KEY));
    return validLimit(value) ? value : DEFAULT_VIEW_CACHE_LIMIT;
  } catch { return DEFAULT_VIEW_CACHE_LIMIT; }
}
const ViewCacheSettingsContext = createContext<{ limit: number; setLimit: (value: number) => void }>({ limit: DEFAULT_VIEW_CACHE_LIMIT, setLimit: () => {} });
export const useViewCacheSettings = () => useContext(ViewCacheSettingsContext);

export function ViewCacheSettingsProvider({ children }: { children: ReactNode }) {
  const [limit, setValue] = useState(readLimit);
  const setLimit = useCallback((value: number) => {
    if (!validLimit(value)) return;
    setValue(value);
    try { localStorage.setItem(VIEW_CACHE_LIMIT_KEY, String(value)); } catch { /* Retain the selection for this session. */ }
  }, []);
  useEffect(() => {
    const changed = (event: StorageEvent) => { if (event.key === VIEW_CACHE_LIMIT_KEY || event.key === null) setValue(readLimit()); };
    window.addEventListener('storage', changed);
    return () => window.removeEventListener('storage', changed);
  }, []);
  const value = useMemo(() => ({ limit, setLimit }), [limit, setLimit]);
  return <ViewCacheSettingsContext.Provider value={value}>{children}</ViewCacheSettingsContext.Provider>;
}
