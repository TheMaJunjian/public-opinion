import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { useLocation, useNavigate } from 'react-router-dom';
import { useTheme } from '../theme/theme';
import { applyDocumentTheme } from '../theme/documentTheme';
import { ABOUT_HISTORY_KEY, ABOUT_HOME_STATE_KEY, aboutDocumentUrl, aboutHistoryEntry, replaceAboutDocument, scrollAboutDocument, type AboutHistoryEntry } from '../utils/aboutNavigation';

/** The static document stays isolated from app styles; the workbench and loaded document stay mounted. */
export default function AboutViewer({ appRoot }: { appRoot: RefObject<HTMLDivElement> }) {
  const theme = useTheme();
  const location = useLocation();
  const navigate = useNavigate();
  const locationRef = useRef(location);
  locationRef.current = location;
  const initialEntry = useRef(aboutHistoryEntry(window.history.state));
  const [prepared, setPrepared] = useState(Boolean(initialEntry.current));
  const [open, setOpen] = useState(Boolean(initialEntry.current));
  const frameRef = useRef<HTMLIFrameElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const documentCleanup = useRef<() => void>();
  const activeEntry = useRef(initialEntry.current);
  const documentUrl = useRef(initialEntry.current?.url ?? '/about.html');
  const initialUrl = useRef(documentUrl.current);
  const closing = useRef(false);
  const scrollPositions = useRef(new Map<string, { x: number; y: number }>());
  const pendingScroll = useRef<{ x: number; y: number }>();
  const pendingAnchor = useRef(Boolean(initialEntry.current));

  const saveScroll = useCallback(() => {
    const entry = activeEntry.current;
    const frameWindow = frameRef.current?.contentWindow;
    if (entry && frameWindow && aboutDocumentUrl(new URL(frameWindow.location.href)) === entry.url) {
      scrollPositions.current.set(entry.id, { x: frameWindow.scrollX, y: frameWindow.scrollY });
    }
  }, []);

  const restoreScroll = useCallback(() => {
    const frame = frameRef.current;
    if (!frame || frame.closest('[hidden]')) return;
    const frameWindow = frame.contentWindow;
    if (!frameWindow || aboutDocumentUrl(new URL(frameWindow.location.href)) !== documentUrl.current) return;
    if (pendingScroll.current) {
      frameWindow.scrollTo(pendingScroll.current.x, pendingScroll.current.y);
      pendingScroll.current = undefined;
    } else if (pendingAnchor.current && scrollAboutDocument(frame, documentUrl.current)) {
      pendingAnchor.current = false;
    }
  }, []);

  const loadDocument = useCallback((url: string, position?: { x: number; y: number }, focusAnchor = true) => {
    documentUrl.current = url;
    pendingScroll.current = position;
    pendingAnchor.current = !position && focusAnchor;
    const frame = frameRef.current;
    if (!frame?.contentWindow) return;
    if (aboutDocumentUrl(new URL(frame.contentWindow.location.href)) !== url) replaceAboutDocument(frame, url);
    restoreScroll();
  }, [restoreScroll]);

  const pushEntry = useCallback((url: string, depth: number, focusAnchor = true) => {
    saveScroll();
    const entry: AboutHistoryEntry = { id: crypto.randomUUID(), depth, url };
    // Keep the route, route key and offline-viewer state intact while the workbench stays mounted.
    window.history.pushState({ ...window.history.state, [ABOUT_HISTORY_KEY]: entry }, '');
    activeEntry.current = entry;
    if (!frameRef.current) initialUrl.current = url;
    setPrepared(true); setOpen(true);
    loadDocument(url, undefined, focusAnchor);
  }, [loadDocument, saveScroll]);

  const close = useCallback(() => {
    if (closing.current) return;
    const entry = aboutHistoryEntry(window.history.state);
    if (!entry) { activeEntry.current = null; setOpen(false); return; }
    saveScroll(); closing.current = true;
    window.history.go(-entry.depth);
  }, [saveScroll]);

  useEffect(() => {
    const prepare = () => setPrepared(true);
    const show = (event: Event) => {
      if (activeEntry.current || closing.current) return;
      let url = documentUrl.current;
      const requested = (event as CustomEvent<{ url?: unknown }>).detail?.url;
      if (typeof requested === 'string') {
        try { url = aboutDocumentUrl(new URL(requested, window.location.href)) ?? url; }
        catch { /* Keep the last public document if an entry supplies an invalid URL. */ }
      }
      pushEntry(url, 1, typeof requested === 'string');
    };
    const pop = (event: PopStateEvent) => {
      saveScroll();
      const entry = aboutHistoryEntry(event.state);
      activeEntry.current = entry;
      closing.current = false;
      setOpen(Boolean(entry));
      if (entry) {
        setPrepared(true);
        // Parent pushState entries do not restore an iframe navigated with replace.
        // Synchronize it explicitly on both Back and Forward, then restore this visit's scroll.
        loadDocument(entry.url, scrollPositions.current.get(entry.id));
      }
    };
    window.addEventListener('prepare-about-viewer', prepare);
    window.addEventListener('open-about-viewer', show);
    window.addEventListener('popstate', pop);
    return () => {
      window.removeEventListener('prepare-about-viewer', prepare);
      window.removeEventListener('open-about-viewer', show);
      window.removeEventListener('popstate', pop);
      documentCleanup.current?.();
    };
  }, [pushEntry, loadDocument, saveScroll]);

  useLayoutEffect(() => {
    const doc = frameRef.current?.contentDocument;
    if (doc) applyDocumentTheme(doc, theme);
    // A preloaded iframe has no layout while hidden. Position it only after it is visible.
    if (open) restoreScroll();
  }, [theme, prepared, open, restoreScroll]);

  useLayoutEffect(() => {
    if (!open) return;
    const root = appRoot.current;
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const wasInert = root?.inert ?? false;
    if (root) root.inert = true;
    closeRef.current?.focus({ preventScroll: true });
    const escape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault(); event.stopImmediatePropagation(); close();
    };
    window.addEventListener('keydown', escape, true);
    return () => {
      window.removeEventListener('keydown', escape, true);
      if (root) root.inert = wasInert;
      if (previousFocus?.isConnected) previousFocus.focus({ preventScroll: true });
    };
  }, [open, appRoot, close]);

  const connectDocument = () => {
    documentCleanup.current?.();
    const frame = frameRef.current;
    const doc = frame?.contentDocument;
    if (!frame || !doc) return;
    applyDocumentTheme(doc, theme);
    if (frame.contentWindow) frame.contentWindow.history.scrollRestoration = 'manual';
    restoreScroll();
    for (const anchor of doc.querySelectorAll<HTMLAnchorElement>('a[href]')) {
      if (new URL(anchor.href).origin !== window.location.origin) {
        anchor.target = '_blank'; anchor.rel = 'noopener noreferrer';
      }
    }
    const click = (event: MouseEvent) => {
      if (event.defaultPrevented || event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
      const target = event.target as Element | null;
      const anchor = target?.closest?.('a[href]') as HTMLAnchorElement | null;
      if (!anchor || (anchor.target && anchor.target !== '_self') || anchor.hasAttribute('download')) return;
      const url = new URL(anchor.href);
      if (url.origin !== window.location.origin) return;
      const route = url.hash.startsWith('#/') ? new URL(url.hash.slice(1), url.origin) : url;
      const nextUrl = aboutDocumentUrl(url);
      if (!nextUrl) {
        event.preventDefault();
        if (closing.current) return;
        saveScroll();
        activeEntry.current = null;
        setOpen(false);
        const pathname = route.pathname === '/index.html' ? '/' : route.pathname;
        const current = locationRef.current;
        const state = pathname === '/' ? { [ABOUT_HOME_STATE_KEY]: true }
          : pathname === current.pathname ? current.state : undefined;
        // A link adds a visit, including when it returns to the retained workbench.
        navigate(pathname + route.search + route.hash, { state });
        return;
      }
      if (nextUrl) {
        event.preventDefault();
        if (closing.current || !activeEntry.current) return;
        if (nextUrl === documentUrl.current) {
          scrollAboutDocument(frame, nextUrl);
          return;
        }
        pushEntry(nextUrl, activeEntry.current.depth + 1);
      }
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); close(); }
    };
    doc.addEventListener('click', click);
    doc.addEventListener('keydown', escape);
    frame.contentWindow?.addEventListener('hashchange', restoreScroll);
    frame.contentWindow?.addEventListener('scroll', saveScroll, { passive: true });
    documentCleanup.current = () => {
      doc.removeEventListener('click', click);
      doc.removeEventListener('keydown', escape);
      frame.contentWindow?.removeEventListener('hashchange', restoreScroll);
      frame.contentWindow?.removeEventListener('scroll', saveScroll);
    };
  };

  if (!prepared) return null;
  return createPortal(<div role="dialog" aria-label="公论介绍" aria-modal={open ? true : undefined} hidden={!open}
    style={{ display: open ? 'flex' : 'none', position: 'fixed', inset: 0, zIndex: 4000, flexDirection: 'column', background: 'var(--surface-page)' }}>
    <div className="about-viewer-toolbar">
      <span>公论介绍与文档</span>
      <button ref={closeRef} type="button" onClick={close} className="about-viewer-close" aria-label="关闭介绍" title="返回原页面（Esc）">
        <span aria-hidden="true">×</span>关闭
      </button>
    </div>
    <iframe ref={frameRef} title="公论介绍与文档" src={initialUrl.current} onLoad={connectDocument}
      sandbox="allow-same-origin allow-popups allow-popups-to-escape-sandbox"
      style={{ width: '100%', flex: 1, minHeight: 0, border: 0, background: 'var(--surface-page)' }} />
  </div>, document.body);
}
