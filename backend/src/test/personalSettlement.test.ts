import { calculatePersonalSettlement } from '../lib/personalSettlement';

describe('calculatePersonalSettlement', () => {
  it('counts the protocol fee as a first-round loss when only the stake is returned', () => {
    expect(calculatePersonalSettlement({
      principal: 13,
      stakePrincipal: 11,
      protocolFee: 2,
      payout: 11,
    })).toMatchObject({ previousAfter: 13, after: 11, change: -2 });
  });

  it('reports first-round profit excluding the returned stake', () => {
    expect(calculatePersonalSettlement({
      principal: 13,
      stakePrincipal: 12,
      protocolFee: 1,
      payout: 23,
    })).toMatchObject({ previousAfter: 13, after: 23, change: 10 });
  });

  it('reports first-round loss from the payout while preserving the fee in the baseline', () => {
    expect(calculatePersonalSettlement({
      principal: 13,
      stakePrincipal: 12,
      protocolFee: 1,
      payout: -12,
    })).toMatchObject({ previousAfter: 13, after: 1, change: -12 });
  });

  it('uses the current round investment as the previous-round snapshot on first participation', () => {
    expect(calculatePersonalSettlement({
      principal: 13,
      stakePrincipal: 12,
      protocolFee: 1,
      payout: 23,
    })).toMatchObject({ previousAfter: 13, after: 23, change: 10 });
  });

  it('compares later rounds with the previous personal snapshot', () => {
    expect(calculatePersonalSettlement({
      principal: 13,
      stakePrincipal: 12,
      protocolFee: 1,
      payout: -11,
      previousAfter: 11,
    })).toMatchObject({ after: 0, change: -11 });
  });

  it('keeps a later round with no new stake at the previous snapshot', () => {
    expect(calculatePersonalSettlement({
      principal: 11,
      stakePrincipal: 11,
      protocolFee: 0,
      payout: 0,
      previousAfter: 11,
    })).toMatchObject({ after: 11, change: 0 });
  });
});