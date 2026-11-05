interface Props {
  completion: number;
  roundId?: string;
  compact?: boolean;
  unavailable?: boolean;
}

export default function UsagePointsProgress({ completion, roundId, compact, unavailable }: Props) {
  const percent = Math.round(Math.max(0, Math.min(1, completion)) * 100);
  return (
    <span
      className={`usage-points-progress${compact ? ' usage-points-progress--compact' : ''}`}
      data-usage-points="true"
      role="progressbar"
      aria-label="贡献点积累进度"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={unavailable ? undefined : percent}
      title={unavailable ? '计时同步中' : `本轮进度 ${percent}%`}
    >
      <span key={roundId} className="usage-points-progress__fill" style={{ transform: `scaleX(${unavailable ? 0 : completion})` }} />
    </span>
  );
}
