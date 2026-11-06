import { describe, expect, it } from 'vitest';
import { getStakeAppearance, groupStakeAppearanceAttributes, type StakeAmounts } from '../utils/stakeAppearance';

const counts = (truth: number, value = 0): StakeAmounts => ({ truth: { pro: truth, con: 0 }, value: { pro: value, con: 0 } });
describe('investment appearance tiers', () => {
  it.each([[0,0],[10,0],[100,0],[999,0],[999.99,0],[1_000,1],[99_999,1],[99_999.99,1],[100_000,2],[999_999,2],[999_999.99,2],[1_000_000,3],[10_000_000,3]])('assigns %s points to L%s', (total,level) => {
    expect(getStakeAppearance(counts(total)).level).toBe(level);
  });
  it('adds both sides of truth and value instead of using the winning side or recommendation expenditure', () => {
    const value = { truth: {pro:40_000,con:60_000}, value:{pro:300_000,con:600_000} };
    expect(getStakeAppearance(value)).toMatchObject({level:3,total:1_000_000});
    expect(getStakeAppearance({truth:value.value,value:value.truth}).level).toBe(3);
    expect(getStakeAppearance({...counts(1), recommendationTotal:1_000_000} as StakeAmounts).level).toBe(0);
  });
  it('does not call missing statistics a known zero stake', () => {
    expect(getStakeAppearance(undefined).level).toBeUndefined();
    expect(getStakeAppearance({truth:{pro:NaN,con:-3},value:{pro:Infinity,con:9}})).toMatchObject({level:0,total:9});
  });
  it('keeps grouped decorations at their strongest member tier instead of summing duplicated or grouped records', () => {
    const records={a:counts(60_000),b:counts(60_000),c:counts(0,1_000_000)};
    expect(groupStakeAppearanceAttributes(['a','a','b'],records)).toMatchObject({'data-stake-level':1,'data-stake-total':60_000});
    expect(groupStakeAppearanceAttributes(['a','c'],records)['data-stake-level']).toBe(3);
    expect(groupStakeAppearanceAttributes(['missing'],records)['data-stake-level']).toBeUndefined();
  });
});
