import { useLayoutEffect, type RefObject } from 'react';
type ReadingMarkerTargets=string|readonly string[]|null;
export type ReadingNavigationMarkers={current:ReadingMarkerTargets;previous:ReadingMarkerTargets;next:ReadingMarkerTargets;continue?:ReadingMarkerTargets};
const markerRoles=['current','previous','next','continue'] as const;
const clearReadingMarker=(element:Element)=>{
  element.removeAttribute('data-reading-position');
  for(const role of markerRoles)(element as HTMLElement).style.removeProperty(`--reading-${role}-offset`);
};

/** Keep view anchors marked as virtual cards and relation labels mount/unmount. */
export function useViewedMessageHighlight(viewport: RefObject<HTMLElement>, messageIds: readonly string[],navigation?:ReadingNavigationMarkers) {
  const key = JSON.stringify([...new Set(messageIds)].sort());
  const navigationKey=JSON.stringify(navigation??{});
  useLayoutEffect(() => {
    const root = viewport.current;
    if (!root) return;
    const ids = new Set<string>(JSON.parse(key));
    const marked = new Set<Element>();
    const readingMarked=new Set<Element>();
    const update = () => {
      for (const element of marked) element.removeAttribute('data-view-target');
      marked.clear();
      for(const element of readingMarked)clearReadingMarker(element);
      readingMarked.clear();
      // An expanded organization has one visual boundary. Its header and
      // attached badges must not each pretend to be that whole boundary.
      const framed=new Set<string>();
      for(const element of root.querySelectorAll('[data-frame-visual]')){
        const id=element.getAttribute('data-frame-visual');
        if(id&&ids.has(id)){element.setAttribute('data-view-target','true');marked.add(element);framed.add(id);}
      }
      for (const element of root.querySelectorAll('[data-msgid], [data-jump-msgids], [data-jump-visual-msgids]')) {
        if(element.hasAttribute('data-directed-edge-start'))continue;
        const matches = ['data-msgid', 'data-jump-msgids', 'data-jump-visual-msgids']
          .some(name => element.getAttribute(name)?.split(/\s+/).some(id => ids.has(id)&&!framed.has(id)));
        if (!matches || [...marked].some(parent => parent.contains(element))) continue;
        element.setAttribute('data-view-target', 'true'); marked.add(element);
      }
      const roles=JSON.parse(navigationKey) as Partial<ReadingNavigationMarkers>;
      const positions=new Map<Element,Array<typeof markerRoles[number]>>();
      // Every member of a navigation group uses its primary visual anchor.
      for(const role of markerRoles)for(const id of typeof roles[role]==='string'?[roles[role]]:roles[role]??[]){
        const frames=Array.from(root.querySelectorAll('[data-frame-visual]')).filter(element=>element.getAttribute('data-frame-visual')===id);
        const labels=Array.from(root.querySelectorAll('[data-directed-edge-label]')).filter(element=>element.getAttribute('data-directed-edge-label')===id);
        const cards=Array.from(root.querySelectorAll('[data-msgid]')).filter(element=>element.getAttribute('data-msgid')===id&&!element.closest('svg'));
        const anchors=frames.length?frames:labels.length?labels:cards.filter(element=>!element.hasAttribute('data-rel-overlay'));
        const outer=anchors.filter(element=>!anchors.some(parent=>parent!==element&&parent.contains(element)));
        for(const element of outer.length?outer:cards.slice(0,1)){
          const values=positions.get(element)??[];if(!values.includes(role))values.push(role);positions.set(element,values);
        }
      }
      for(const [element,values] of positions){
        element.setAttribute('data-reading-position',values.join(' '));readingMarked.add(element);
        values.forEach((role,index)=>(element as HTMLElement).style.setProperty(`--reading-${role}-offset`,`${(index-(values.length-1)/2)*18}px`));
      }
    };
    update();
    const observer = new MutationObserver(update);
    observer.observe(root, { childList: true, subtree: true, attributes: true,
      attributeFilter: ['data-msgid', 'data-jump-msgids', 'data-jump-visual-msgids','data-frame-visual'] });
    return () => { observer.disconnect(); for (const element of marked) element.removeAttribute('data-view-target');for(const element of readingMarked)clearReadingMarker(element); };
  }, [viewport, key,navigationKey]);
}
