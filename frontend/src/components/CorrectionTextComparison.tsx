import { computeCharDiff, renderDiffParts } from './CharDiffText';
import ComparisonScrollSync from './ComparisonScrollSync';

/** Full readable bodies; only the addressed replacement is changed. */
export default function CorrectionTextComparison({ before, after, status, beforeLabel='修改前全文',afterLabel='修改后全文' }: { before: string; after: string; status?: string;beforeLabel?:string;afterLabel?:string }) {
  const { origParts, nextParts } = computeCharDiff(before, after);
  return <ComparisonScrollSync>{({ controls, onScrollCapture }) => <div data-comparison-content="true" onScrollCapture={onScrollCapture} style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
    {controls}
    {status && <div data-comparison-status="true" style={{ fontSize: 11, color: 'var(--ink-fbbf24)' }}>{status}</div>}
    <div data-comparison-grid="true" style={{ display: 'flex', gap: 10 }}>
      {([[beforeLabel, origParts, 'orig', 'var(--line-554)', 'var(--surface-211e14)'], [afterLabel, nextParts, 'next', 'var(--line-255)', 'var(--surface-14201e)']] as const).map(([title, parts, side, border, background]) =>
        <section key={side} aria-label={title} data-version-side={side === 'orig' ? 'before' : 'after'} style={{ flex: 1, minWidth: 0, borderRadius: 6, border: `1px solid ${border}`, background, color: 'var(--text-primary)', padding: 10 }}>
          <div style={{ fontSize: 11, fontWeight: 600, marginBottom: 6 }}>{title}</div>
          <pre style={{ margin: 0, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', fontSize: 12, color: 'var(--text-primary)', lineHeight: 1.6 }}>{renderDiffParts(parts, side)}</pre>
        </section>)}
    </div>
  </div>}</ComparisonScrollSync>;
}
