import { forwardRef, useCallback, useLayoutEffect, useRef, type HTMLAttributes } from 'react';

/**
 * 悬浮可视区域与内容高度分开：内容始终自然展开，不设置 height/maxHeight。
 * 只有外层原生滚动视口跟随实际可见区域；不能用 vh/dvh 截断手机缩放后的内容。
 */
const WorkbenchScrollViewport = forwardRef<HTMLDivElement, HTMLAttributes<HTMLDivElement>>(
  function WorkbenchScrollViewport({ style, children, ...props }, forwardedRef) {
    const viewportRef = useRef<HTMLDivElement | null>(null);
    const measureRef = useRef<(() => void) | null>(null);
    const attachRef = useCallback((element: HTMLDivElement | null) => {
      viewportRef.current = element;
      if (typeof forwardedRef === 'function') forwardedRef(element);
      else if (forwardedRef) forwardedRef.current = element;
    }, [forwardedRef]);

    useLayoutEffect(() => {
      const element = viewportRef.current;
      if (!element) return;
      const visual = window.visualViewport;
      let frame = 0;
      const measure = () => {
        const bounds = element.getBoundingClientRect();
        // offsetWidth rounds fractional flex widths, which can falsely look like
        // interface scaling and make the viewport taller than the screen.
        const layoutWidth = parseFloat(getComputedStyle(element).width) || element.offsetWidth;
        const scale = layoutWidth > 0 && bounds.width > 0 ? bounds.width / layoutWidth : 1;
        const top = visual?.offsetTop ?? 0;
        const bottom = top + (visual?.height ?? window.innerHeight);
        // Keep a small target when the toolbar/keyboard temporarily fills the
        // screen, so page scrolling can still bring the viewport into view.
        // Leave 8px for the pane footer and 1px for rounding/hysteresis. Never
        // turn a harmless subpixel measurement error into page overflow.
        // Pinch zoom can pan the visual viewport below this element's top.
        // Its box still starts at bounds.top, so include the hidden upper part
        // or the bottom ends early by visual.offsetTop - bounds.top.
        const height = Math.max(64, (bottom - bounds.top) / scale - 9);
        const currentHeight = parseFloat(element.style.getPropertyValue('--workbench-viewport-height'));
        // 浏览器缩放和滚动条会产生亚像素测量误差。忽略半像素内的变化，
        // 避免 ResizeObserver 因反复写回尺寸而抖动；真正的可视区域变化仍跟随。
        if (Math.abs(currentHeight - height) < 0.5) return;
        const value = `${height}px`;
        if (element.style.getPropertyValue('--workbench-viewport-height') !== value) {
          element.style.setProperty('--workbench-viewport-height', value);
        }
      };
      const schedule = () => {
        if (frame) return;
        frame = requestAnimationFrame(() => { frame = 0; measure(); });
      };
      measureRef.current = measure;
      measure();
      const observer = new ResizeObserver(schedule);
      observer.observe(element);
      if (element.parentElement) observer.observe(element.parentElement);
      window.addEventListener('resize', schedule);
      window.addEventListener('scroll', schedule, { capture: true, passive: true });
      visual?.addEventListener('resize', schedule);
      visual?.addEventListener('scroll', schedule);
      return () => {
        measureRef.current = null;
        observer.disconnect();
        cancelAnimationFrame(frame);
        window.removeEventListener('resize', schedule);
        window.removeEventListener('scroll', schedule, true);
        visual?.removeEventListener('resize', schedule);
        visual?.removeEventListener('scroll', schedule);
      };
    }, []);
    // Frozen controls, filters and the composer can change the viewport's top
    // without resizing it. Re-measure after their layout has committed.
    useLayoutEffect(() => { measureRef.current?.(); });

    return <div {...props} ref={attachRef} data-workbench-scroll-viewport="true" style={{
      ...style,
      height: 'var(--workbench-viewport-height, auto)',
      minHeight: 0,
      boxSizing: 'border-box',
      // 只保留视口自身的滚动条；它已经位于可视区域内，不能再叠加悬浮镜像条。
      overflow: 'auto',
      touchAction: 'pan-x pan-y pinch-zoom',
      WebkitOverflowScrolling: 'touch',
      overscrollBehavior: 'auto',
    }}>{children}</div>;
  },
);

export default WorkbenchScrollViewport;
