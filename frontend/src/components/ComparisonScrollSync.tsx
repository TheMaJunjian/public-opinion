import { createContext, useContext, useRef, useState, type ReactNode, type UIEventHandler } from 'react';

const ComparisonScrollContext = createContext(false);

type ScrollBindings = {
  controls: ReactNode;
  onScrollCapture?: UIEventHandler<HTMLDivElement>;
};

/** The outer comparison owns synchronization when readable versions are nested. */
export default function ComparisonScrollSync({ children }: { children: (bindings: ScrollBindings) => ReactNode }) {
  const inherited = useContext(ComparisonScrollContext);
  const [enabled, setEnabled] = useState(true);
  const mirroredPositions = useRef(new WeakMap<HTMLElement, number>());
  const mirroring = useRef(false);

  const onScrollCapture: UIEventHandler<HTMLDivElement> = event => {
    if (!enabled || mirroring.current || !(event.target instanceof HTMLElement)) return;
    const source = event.target;
    if (!source.matches('[data-version-side]')) return;
    const pendingPosition = mirroredPositions.current.get(source);
    mirroredPositions.current.delete(source);
    // Browsers deliver programmatic scroll events asynchronously. Ignore only
    // the position we wrote, so a later visitor scroll remains independent.
    if (pendingPosition === source.scrollTop) return;
    const grid = source.closest('[data-comparison-grid]');
    if (!grid || !event.currentTarget.contains(grid)) return;
    const columns = Array.from(grid.querySelectorAll<HTMLElement>('[data-version-side]'))
      .filter(column => column.closest('[data-comparison-grid]') === grid && column.querySelector('pre'));
    if (columns.length !== 2 || !columns.includes(source)) return;
    const target = columns.find(column => column !== source)!;
    if (target.scrollTop === source.scrollTop) return;
    mirroring.current = true;
    try {
      target.scrollTop = source.scrollTop;
      mirroredPositions.current.set(target, target.scrollTop);
    } finally {
      mirroring.current = false;
    }
  };

  if (inherited) return children({ controls: null });

  return <ComparisonScrollContext.Provider value>
    {children({
      onScrollCapture,
      controls: <label className="comparison-scroll-controls" style={{ display: 'none' }}>
        <input type="checkbox" checked={enabled} onChange={event => {
          setEnabled(event.target.checked);
        }} />
        <span>同步滚动</span>
      </label>,
    })}
  </ComparisonScrollContext.Provider>;
}
