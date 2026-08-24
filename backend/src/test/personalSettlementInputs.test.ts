import { isCurrentRoundVote, isVoteBeforeCutoff, sumCumulativeFees, sumCumulativeStakeAmounts, sumCurrentRoundFees } from '../lib/personalSettlementInputs';

describe('personal settlement input scoping', () => {
  it('keeps previous-round stake in the cumulative investment total', () => {
    expect(sumCumulativeStakeAmounts([
      { amount: 11, roundId: 'previous-round' },
      { amount: 11, roundId: 'current-round' },
    ], new Date())).toBe(22);
  });

  it('keeps previous-round protocol fee in the cumulative investment total', () => {
    expect(sumCumulativeFees([
      { amount: -1, roundId: 'previous-round', data: { fee: true } },
      { amount: -1, roundId: 'current-round', data: { fee: true } },
    ], new Date())).toBe(2);
  });

  it('can still isolate the current-round protocol fee for round-specific calculations', () => {
    expect(sumCurrentRoundFees([
      { amount: -1, roundId: 'previous-round', data: { fee: true } },
      { amount: -1, roundId: 'current-round', data: { fee: true } },
    ], 'current-round')).toBe(1);
  });

  it('accepts only votes explicitly belonging to the current round', () => {
    expect(isCurrentRoundVote({ roundId: 'current-round' }, 'current-round')).toBe(true);
    expect(isCurrentRoundVote({ roundId: 'previous-round' }, 'current-round')).toBe(false);
  });

  it('includes all votes created before the cumulative cutoff', () => {
    const cutoff = new Date('2026-08-24T12:00:00.000Z');
    expect(isVoteBeforeCutoff('2026-08-24T11:00:00.000Z', cutoff)).toBe(true);
    expect(isVoteBeforeCutoff('2026-08-24T13:00:00.000Z', cutoff)).toBe(false);
  });
});