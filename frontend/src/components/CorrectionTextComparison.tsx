import { computeCharDiff, renderDiffParts } from './CharDiffText';

/** Full readable bodies; only the addressed replacement is changed. */
export default function CorrectionTextComparison({ before, after, status }: { before: string; after: string; status?: string }) {
  const { origParts, nextParts } = computeCharDiff(before, after);
  return <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
    {status && <div style={{ fontSize: 11, color: '#fbbf24' }}>{status}</div>}
    <div style={{ display: 'flex', gap: 10 }}>
      {([['修改前全文', origParts, 'orig', '#554', '#211e14'], ['修改后全文', nextParts, 'next', '#255', '#14201e']] as const).map(([title, parts, side, border, background]) =>
        <section key={side} aria-label={title} style={{ flex: 1, minWidth: 0, borderRadius: 6, border: `1px solid ${border}`, background, padding: 10 }}>
          <div style={{ fontSize: 11, fontWeight: 600, marginBottom: 6 }}>{title}</div>
          <pre style={{ margin: 0, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', fontSize: 12, color: '#ddd', lineHeight: 1.6 }}>{renderDiffParts(parts, side)}</pre>
        </section>)}
    </div>
  </div>;
}
