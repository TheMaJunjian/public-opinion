import type React from 'react';

export type DiffPart = { type: 'keep' | 'del' | 'ins'; text: string };

const MAX_DIFF_LENGTH = 500;

export function computeCharDiff(orig: string, next: string): { origParts: DiffPart[]; nextParts: DiffPart[] } {
  const n = orig.length;
  const m = next.length;
  if (n > MAX_DIFF_LENGTH || m > MAX_DIFF_LENGTH) {
    return { origParts: [{ type: 'keep', text: orig }], nextParts: [{ type: 'keep', text: next }] };
  }

  const dp: number[][] = Array(n + 1).fill(null).map(() => new Array(m + 1).fill(0));
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      dp[i][j] = orig[i - 1] === next[j - 1] ? dp[i - 1][j - 1] + 1 : Math.max(dp[i - 1][j], dp[i][j - 1]);
    }
  }

  const origSegs: DiffPart[] = [];
  const nextSegs: DiffPart[] = [];
  let i = n;
  let j = m;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && orig[i - 1] === next[j - 1]) {
      origSegs.unshift({ type: 'keep', text: orig[i - 1] });
      nextSegs.unshift({ type: 'keep', text: next[j - 1] });
      i--;
      j--;
    } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
      nextSegs.unshift({ type: 'ins', text: next[j - 1] });
      j--;
    } else {
      origSegs.unshift({ type: 'del', text: orig[i - 1] });
      i--;
    }
  }

  return { origParts: mergeDiffParts(origSegs), nextParts: mergeDiffParts(nextSegs) };
}

function mergeDiffParts(segs: DiffPart[]): DiffPart[] {
  const res: DiffPart[] = [];
  for (const s of segs) {
    if (res.length > 0 && res[res.length - 1].type === s.type) {
      res[res.length - 1].text += s.text;
    } else {
      res.push({ ...s });
    }
  }
  return res;
}

export function renderDiffParts(parts: DiffPart[], side: 'orig' | 'next'): React.ReactNode {
  return parts.map((p, idx) => {
    const isChanged = (side === 'orig' && p.type === 'del') || (side === 'next' && p.type === 'ins');
    return (
      <span key={idx} style={isChanged ? {
        background: side === 'orig' ? 'rgba(220,50,50,0.35)' : 'rgba(50,200,80,0.35)',
        borderRadius: 2,
        outline: side === 'orig' ? '1px solid rgba(220,50,50,0.6)' : '1px solid rgba(50,200,80,0.6)',
      } : undefined}>{p.text}</span>
    );
  });
}
