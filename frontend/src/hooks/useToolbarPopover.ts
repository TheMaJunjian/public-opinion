import { useLayoutEffect, useRef } from 'react';

/** Keep a right-aligned menu within the visible toolbar as groups wrap or the divider moves. */
export function useToolbarPopover(open: boolean) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const menu = ref.current;
    const anchor = menu?.offsetParent;
    const toolbar = menu?.closest<HTMLElement>('[data-workbench-view-toolbar]');
    if (!open || !menu || !(anchor instanceof HTMLElement) || !toolbar) return;

    const align = () => {
      const bounds = toolbar.getBoundingClientRect();
      const width = menu.getBoundingClientRect().width;
      if (!width || !menu.offsetWidth) return;
      const scale = width / menu.offsetWidth;
      const start = Math.max(0, bounds.left) + 4 * scale;
      const end = Math.min(document.documentElement.clientWidth, bounds.right) - 4 * scale;
      const anchorEnd = anchor.getBoundingClientRect().right;
      const left = Math.max(start, Math.min(anchorEnd, end) - width);
      menu.style.right = `${(anchorEnd - left - width) / scale}px`;
    };

    align();
    const observer = new ResizeObserver(align);
    observer.observe(toolbar);
    observer.observe(anchor);
    observer.observe(menu);
    window.addEventListener('resize', align);
    window.addEventListener('scroll', align, true);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', align);
      window.removeEventListener('scroll', align, true);
    };
  }, [open]);
  return ref;
}
