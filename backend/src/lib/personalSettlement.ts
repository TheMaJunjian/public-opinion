export interface PersonalSettlementValues {
  principal: number;
  stakePrincipal: number;
  protocolFee: number;
  payout: number;
  previousAfter?: number;
}

export interface PersonalSettlementSnapshot {
  principal: number;
  stakePrincipal: number;
  protocolFee: number;
  change: number;
  after: number;
  previousAfter?: number;
}

export function calculatePersonalSettlement({
  principal,
  stakePrincipal,
  protocolFee,
  payout,
  previousAfter,
}: PersonalSettlementValues): PersonalSettlementSnapshot {
  const baseline = previousAfter ?? principal;
  const after = Math.max(0, payout > 0 ? payout : baseline + payout);
  const change = after - baseline;

  return { principal, stakePrincipal, protocolFee, change, after, previousAfter: baseline };
}