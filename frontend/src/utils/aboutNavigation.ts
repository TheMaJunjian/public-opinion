export const ABOUT_HISTORY_KEY = '__gonglunAbout';
export const ABOUT_HOME_STATE_KEY = '__gonglunHomeFromAbout';

export interface AboutHistoryEntry {
  id: string;
  depth: number;
  url: string;
}

export function aboutDocumentUrl(url: URL): string | null {
  if (url.origin !== window.location.origin) return null;
  if (url.pathname !== '/about.html' && url.pathname !== '/llms.txt'
    && !/^\/docs\/[a-z0-9-]+\.(html|md)$/.test(url.pathname)) return null;
  return url.pathname + url.search + url.hash;
}

export function aboutHistoryEntry(state: unknown): AboutHistoryEntry | null {
  const entry = (state as Record<string, unknown> | null)?.[ABOUT_HISTORY_KEY] as Partial<AboutHistoryEntry> | undefined;
  if (!entry || typeof entry.id !== 'string' || !Number.isSafeInteger(entry.depth) || entry.depth! < 1
    || typeof entry.url !== 'string') return null;
  try {
    if (aboutDocumentUrl(new URL(entry.url, window.location.href)) !== entry.url) return null;
  } catch { return null; }
  return entry as AboutHistoryEntry;
}

export function scrollAboutDocument(frame: HTMLIFrameElement, url: string): boolean {
  const destination = new URL(url, window.location.href);
  const fragment = destination.hash.slice(1);
  if (!fragment) { frame.contentWindow?.scrollTo(0, 0); return true; }
  let id = fragment;
  try { id = decodeURIComponent(fragment); } catch { /* A literal percent can be part of an ID. */ }
  const target = frame.contentDocument?.getElementById(id);
  if (!target) return false;
  target.scrollIntoView({ block: 'start' });
  return true;
}

/** Parent history owns navigation. Fragment changes scroll synchronously, without a child navigation. */
export function replaceAboutDocument(frame: HTMLIFrameElement, url: string): void {
  const view = frame.contentWindow;
  if (!view) return;
  const current = new URL(view.location.href);
  const destination = new URL(url, window.location.href);
  if (current.origin === destination.origin && current.pathname === destination.pathname && current.search === destination.search) {
    view.history.replaceState(null, '', url);
    if (!frame.closest('[hidden]')) scrollAboutDocument(frame, url);
  } else view.location.replace(url);
}
