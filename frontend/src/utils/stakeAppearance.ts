/** Visual investment tiers use the same truth/value totals displayed by settlement controls. */
export interface StakeAmounts {
  truth: { pro: number; con: number };
  value: { pro: number; con: number };
}
export const STAKE_TIER_THRESHOLDS = [0, 10, 100, 1000] as const;
export type StakeTier = 0 | 1 | 2 | 3;
const amount = (value: number) => Number.isFinite(value) ? Math.max(0, value) : 0;

export function getStakeAppearance(counts: StakeAmounts | undefined) {
  if (!counts) return { level: undefined, total: undefined, description: '押注统计尚未载入' };
  const truth = amount(counts.truth.pro) + amount(counts.truth.con);
  const value = amount(counts.value.pro) + amount(counts.value.con);
  const total = truth + value;
  const level: StakeTier = total >= STAKE_TIER_THRESHOLDS[3] ? 3 : total >= STAKE_TIER_THRESHOLDS[2] ? 2 : total >= STAKE_TIER_THRESHOLDS[1] ? 1 : 0;
  return { level, total, description: `投入档位 L${level}：真假 ${truth} 点 + 价值 ${value} 点 = ${total} 点（正反双方合计，不代表正确或胜负）` };
}

export function stakeAppearanceAttributes(counts: StakeAmounts | undefined) {
  const { level, total, description } = getStakeAppearance(counts);
  return { 'data-stake-level': level, 'data-stake-total': total, 'data-stake-description': description };
}

/** A grouped badge uses its most invested member; folding/grouping must not manufacture a higher tier. */
export function groupStakeAppearanceAttributes(ids: readonly string[], counts: Readonly<Record<string, StakeAmounts>> = {}) {
  let highest: StakeAmounts | undefined;
  let total = -1;
  for (const id of new Set(ids)) {
    const candidate = counts[id], next = getStakeAppearance(candidate).total;
    if (next !== undefined && next > total) { highest = candidate; total = next; }
  }
  const attributes = stakeAppearanceAttributes(highest);
  return { ...attributes, 'data-stake-description': `${ids.length > 1 ? '组内最高投入档位；' : ''}${attributes['data-stake-description']}` };
}
