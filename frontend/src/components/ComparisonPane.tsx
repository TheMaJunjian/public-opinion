import type { ReactNode } from 'react';

export const COMPARISON_HEADER_HEIGHT = 28;

/** Shared frame for a comparison side, including the single-side viewer. */
export default function ComparisonPane({ side, recommended, children }: {
  side: 'agree' | 'disagree'; recommended?: boolean; children: ReactNode;
}) {
  const agree = side === 'agree';
  return <div data-comparison-view={side} style={{ minWidth: 0, minHeight: 0, border: `1px solid ${agree ? 'var(--line-365314)' : 'var(--line-7f1d1d)'}`, borderRadius: 6, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
    <div style={{ flex: `0 0 ${COMPARISON_HEADER_HEIGHT}px`, height: COMPARISON_HEADER_HEIGHT, boxSizing: 'border-box', display: 'flex', alignItems: 'center', padding: '6px 8px', color: agree ? 'var(--ink-86efac)' : 'var(--ink-fca5a5)', background: agree ? 'var(--surface-17210f)' : 'var(--surface-2a1212)', fontSize: 12, fontWeight: 600 }}>
      {agree ? '赞同后显示' : '反对后显示'}{recommended ? ' · 统计显示' : ''}
    </div>
    {children}
  </div>;
}
