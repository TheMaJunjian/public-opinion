export function isCurrentRoundVote(payload: unknown, roundId: string): boolean {
  return (payload as { roundId?: unknown } | null)?.roundId === roundId;
}

export function isVoteBeforeCutoff(createdAt: Date | string, cutoff: Date): boolean {
  return new Date(createdAt) <= cutoff;
}

export function sumCumulativeStakeAmounts(
  stakes: Array<{ amount: number; roundId?: string | null; createdAt?: Date | string }>,
  cutoff: Date,
): number {
  return stakes
    .filter(stake => !stake.createdAt || new Date(stake.createdAt) <= cutoff)
    .reduce((sum, stake) => sum + stake.amount, 0);
}

export function sumCurrentRoundFees(
  entries: Array<{ amount: number; roundId?: string | null; data: unknown }>,
  roundId: string,
): number {
  return entries
    .filter(entry => entry.roundId === roundId)
    .filter(entry => (entry.data as { fee?: unknown } | null)?.fee === true)
    .reduce((sum, entry) => sum + Math.abs(entry.amount), 0);
}

export function sumCumulativeFees(
  entries: Array<{ amount: number; roundId?: string | null; createdAt?: Date | string; data: unknown }>,
  cutoff: Date,
): number {
  return entries
    .filter(entry => !entry.createdAt || new Date(entry.createdAt) <= cutoff)
    .filter(entry => (entry.data as { fee?: unknown } | null)?.fee === true)
    .reduce((sum, entry) => sum + Math.abs(entry.amount), 0);
}