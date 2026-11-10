import type { PointTransaction } from '../types';
import { pointsReasonExplanation, pointsReasonLabel, signedPoints, transactionReasonBreakdown } from '../utils/pointTransactions';

export default function PointsReasonBreakdown({ transaction }: { transaction: PointTransaction }) {
  const rows = transactionReasonBreakdown(transaction);
  if (!rows.length) return null;
  return <div className="mt-3 text-xs" role="group" aria-label="收支原因">
    <div className="mb-1 font-medium text-[color:var(--text-secondary)]">收支原因</div>
    <ul className="space-y-2">
      {rows.map((row, index) => <li key={index}>
        <div className="flex flex-wrap justify-between gap-x-3 gap-y-1">
          <span>{pointsReasonLabel(row.reason)}<span className="ml-1 text-[color:var(--text-muted)]">· {row.entryCount} 笔</span></span>
          <span className="whitespace-nowrap">可用 {signedPoints(row.amount)}{row.lockedDelta !== 0 && ` · 锁定 ${signedPoints(row.lockedDelta)}`}</span>
        </div>
        {pointsReasonExplanation(row.reason) && <p className="mt-0.5 text-[color:var(--text-muted)]" style={{lineHeight:1.5}}>{pointsReasonExplanation(row.reason)}</p>}
      </li>)}
    </ul>
  </div>;
}
