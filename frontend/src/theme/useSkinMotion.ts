import { useEffect } from 'react';

/** One observer for the workbench, not a timer/observer per message.
 * Only a known tier changing on a visible carrier may animate; mounting/loading never celebrates. */
export function useSkinMotion() {
  useEffect(() => {
    const active = new Map<Element, ReturnType<typeof setTimeout>>();
    const motion = window.matchMedia('(prefers-reduced-motion: reduce)');
    const stop = (element: Element) => {
      clearTimeout(active.get(element));
      active.delete(element);
      element.removeAttribute('data-skin-motion');
    };
    const stopAll = () => { for (const element of active.keys()) stop(element); };
    const observer = new MutationObserver(records => {
      if (motion.matches || document.documentElement.dataset.appearance === 'gpt') { stopAll(); return; }
      if (document.querySelectorAll('.themed-message').length > 200) return;
      for (const record of records) {
        const element = record.target as Element;
        if (!element.matches('.themed-message, .graph-edge-label, [data-frame-visual], [data-skin-decoration], [data-skin-tag]')) continue;
        const current = element.getAttribute('data-stake-level');
        if (record.oldValue === null || current === null || current === record.oldValue || active.has(element) || active.size >= 4) continue;
        const box = element.getBoundingClientRect();
        const viewport = element.closest('[data-workbench-scroll-panel]')?.getBoundingClientRect();
        if (!box.width || !box.height || box.bottom <= Math.max(0, viewport?.top ?? 0) || box.top >= Math.min(innerHeight, viewport?.bottom ?? innerHeight)
          || box.right <= Math.max(0, viewport?.left ?? 0) || box.left >= Math.min(innerWidth, viewport?.right ?? innerWidth)) continue;
        const up = Number(current) > Number(record.oldValue);
        element.setAttribute('data-skin-motion', up ? 'upgrade' : 'downgrade');
        active.set(element, setTimeout(() => stop(element), up ? 900 : 200));
      }
    });
    observer.observe(document.body, { subtree: true, attributes: true, attributeFilter: ['data-stake-level'], attributeOldValue: true });
    motion.addEventListener('change', stopAll);
    return () => { observer.disconnect(); motion.removeEventListener('change', stopAll); stopAll(); };
  }, []);
}
