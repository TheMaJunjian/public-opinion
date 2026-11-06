import { useLayoutEffect, useMemo, useRef, type RefObject } from 'react';
import { useReadingDisplayContext } from './MessageDisplayHints';
import { deriveReadingPresentation, groupedReadingPresentation, type ReadingPresentation } from '../pages/workbench/model/readingPresentation';
import { REVEAL_VIRTUAL_MESSAGE, type VirtualMessageRevealDetail } from '../hooks/useVirtualMessageMounts';
import '../theme/reading-presentation.css';

const attribute = 'data-reading-presentation';
const identityAttributes = ['data-msgid', 'data-jump-msgids', 'data-jump-visual-msgids', 'data-frame-visual'];
const selector = identityAttributes.map(name => `[${name}]`).join(',');
const emptyPresentation = new Map<string, ReadingPresentation>();
const elementMessageIds = (element: Element) => element.hasAttribute('data-jump-msgids')
  ? element.getAttribute('data-jump-msgids')!.split(/\s+/).filter(Boolean)
  : element.hasAttribute('data-msgid') ? [element.getAttribute('data-msgid')!]
  : (element.getAttribute('data-jump-visual-msgids') ?? element.getAttribute('data-frame-visual') ?? '').split(/\s+/).filter(Boolean);

/** Paint mounted cards and relation surfaces without changing the measured scene. */
export default function ReadingCanvasPresentation({ viewport, active }: { viewport: RefObject<HTMLDivElement>; active: boolean }) {
  const context = useReadingDisplayContext();
  const presentation = useMemo(() => active && context
    ? deriveReadingPresentation(context.readingInput, context.data.reading) : emptyPresentation,
  [active, context?.readingInput, context?.data.reading]);
  const revealed = useRef(new Set<string>());
  useLayoutEffect(() => { revealed.current.clear(); }, [context?.input.readingMarks, active]);
  useLayoutEffect(() => {
    if (!active) return;
    let disposed = false, disconnect = () => {};
    const connect = () => {
      if (disposed) return;
      const root = viewport.current;
      if (!root) return;
      root.setAttribute('data-reading-presentation-active', 'true');
      let painted = new Set<Element>();
      const apply = () => {
        const next = new Set<Element>();
        const elements = [...root.querySelectorAll(selector)];
        const visible = new Set(revealed.current);
        // A revisited inline record may live inside a read card. Reveal that carrier too.
        if (visible.size) for (const element of elements) if (elementMessageIds(element).some(id => revealed.current.has(id))) {
          for (let parent = element.parentElement; parent && parent !== root; parent = parent.parentElement) {
            elementMessageIds(parent).forEach(id => visible.add(id));
          }
        }
        for (const element of elements) {
          // A decoration's msgid can name its target; jump IDs name the actual records.
          const ids = elementMessageIds(element);
          let value = groupedReadingPresentation(ids, presentation);
          if (value === 'hidden' && ids.some(id => visible.has(id))) value = 'dimmed';
          // A frame and its SVG border share an identity; do not dim them twice.
          if (value && element.parentElement?.closest(`[${attribute}="${value}"]`)) value = undefined;
          if (value) {
            if (element.getAttribute(attribute) !== value) element.setAttribute(attribute, value);
            next.add(element);
          } else element.removeAttribute(attribute);
        }
        for (const element of painted) if (!next.has(element)) element.removeAttribute(attribute);
        painted = next;
      };
      const reveal = (event: Event) => {
        const ids = (event as CustomEvent<VirtualMessageRevealDetail>).detail?.ids ?? [];
        // Keep an explicitly revisited read message available until the next visit/save.
        if (ids.length) { revealed.current = new Set(ids); apply(); }
      };
      apply();
      const observer = new MutationObserver(apply);
      observer.observe(root, { childList: true, subtree: true, attributes: true, attributeFilter: identityAttributes });
      root.addEventListener(REVEAL_VIRTUAL_MESSAGE, reveal, true);
      disconnect = () => {
        observer.disconnect(); root.removeEventListener(REVEAL_VIRTUAL_MESSAGE, reveal, true);
        root.removeAttribute('data-reading-presentation-active');
        for (const element of painted) element.removeAttribute(attribute);
      };
    };
    // A child layout effect runs before its ancestor's ref is attached on first mount.
    if (viewport.current) connect(); else queueMicrotask(connect);
    return () => { disposed = true; disconnect(); };
  }, [viewport, active, presentation]);
  return null;
}
