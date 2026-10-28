import { useLayoutEffect, type RefObject } from 'react';

/** Keep view anchors marked as virtual cards and relation labels mount/unmount. */
export function useViewedMessageHighlight(viewport: RefObject<HTMLElement>, messageIds: readonly string[]) {
  const key = JSON.stringify([...new Set(messageIds)].sort());
  useLayoutEffect(() => {
    const root = viewport.current;
    if (!root) return;
    const ids = new Set<string>(JSON.parse(key));
    const marked = new Set<Element>();
    const update = () => {
      for (const element of marked) element.removeAttribute('data-view-target');
      marked.clear();
      if (!ids.size) return;
      // An expanded organization has one visual boundary. Its header and
      // attached badges must not each pretend to be that whole boundary.
      const framed=new Set<string>();
      for(const element of root.querySelectorAll('[data-frame-visual]')){
        const id=element.getAttribute('data-frame-visual');
        if(id&&ids.has(id)){element.setAttribute('data-view-target','true');marked.add(element);framed.add(id);}
      }
      for (const element of root.querySelectorAll('[data-msgid], [data-jump-msgids], [data-jump-visual-msgids]')) {
        const matches = ['data-msgid', 'data-jump-msgids', 'data-jump-visual-msgids']
          .some(name => element.getAttribute(name)?.split(/\s+/).some(id => ids.has(id)&&!framed.has(id)));
        if (!matches || [...marked].some(parent => parent.contains(element))) continue;
        element.setAttribute('data-view-target', 'true'); marked.add(element);
      }
    };
    update();
    const observer = new MutationObserver(update);
    observer.observe(root, { childList: true, subtree: true, attributes: true,
      attributeFilter: ['data-msgid', 'data-jump-msgids', 'data-jump-visual-msgids','data-frame-visual'] });
    return () => { observer.disconnect(); for (const element of marked) element.removeAttribute('data-view-target'); };
  }, [viewport, key]);
}
