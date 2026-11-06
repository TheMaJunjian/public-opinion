import { useCallback, useEffect, useRef, useState } from 'react';

/** The same handler serves the app and its same-origin document viewer. */
export function useFullscreenShortcut() {
  const [notice, setNotice] = useState<{ message: string } | null>(null);
  const pending = useRef(false);
  const mounted = useRef(true);

  const onKeyDown = useCallback(async (event: KeyboardEvent) => {
    if (event.defaultPrevented || event.isComposing || event.ctrlKey || event.metaKey || event.shiftKey) return;
    const toggle = event.key === 'Enter' && event.altKey;
    // Browsers normally consume Esc themselves. If it reaches the page, exit
    // fullscreen before a dialog or editor can handle the same key press.
    const escapeFullscreen = event.key === 'Escape' && !event.altKey && Boolean(document.fullscreenElement);
    if (!toggle && !escapeFullscreen) return;
    // Consume the combination before an editor or focused control can submit it.
    event.preventDefault();
    event.stopImmediatePropagation();
    if (event.repeat || pending.current) return;

    const entering = !document.fullscreenElement;
    setNotice(null);
    if (entering && (typeof document.documentElement.requestFullscreen !== 'function' || document.fullscreenEnabled === false)) {
      setNotice({ message: '当前页面无法使用全屏快捷键，可尝试浏览器菜单中的全屏。' });
      return;
    }

    pending.current = true;
    try {
      // Call before yielding so the real key press still supplies user activation.
      // The document root also contains dialogs portalled outside the app root.
      if (entering) await document.documentElement.requestFullscreen({ navigationUI: 'hide' });
      else await document.exitFullscreen();
    } catch {
      if (mounted.current) setNotice({ message: entering
        ? '浏览器未允许进入全屏。请先让公论页面处于前台，再按 Alt + Enter 重试。'
        : '未能退出全屏，请按 Esc 或使用浏览器菜单退出全屏。' });
    } finally {
      pending.current = false;
    }
  }, []);

  useEffect(() => {
    mounted.current = true;
    window.addEventListener('keydown', onKeyDown, true);
    return () => {
      mounted.current = false;
      window.removeEventListener('keydown', onKeyDown, true);
    };
  }, [onKeyDown]);

  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(null), 8000);
    return () => window.clearTimeout(timer);
  }, [notice]);

  return { onKeyDown, notice };
}
