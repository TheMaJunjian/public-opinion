import { describe, expect, it } from 'vitest';
import { getStakeAppearance, groupStakeAppearanceAttributes, type StakeAmounts } from '../utils/stakeAppearance';

const counts = (truth: number, value = 0): StakeAmounts => ({ truth: { pro: truth, con: 0 }, value: { pro: value, con: 0 } });
describe('investment appearance tiers', () => {
  it.each([[0,0],[9,0],[9.99,0],[10,1],[99,1],[100,2],[999,2],[1000,3],[10000,3]])('assigns %s points to L%s', (total,level) => {
    expect(getStakeAppearance(counts(total)).level).toBe(level);
  });
  it('adds both sides of truth and value instead of using the winning side or recommendation expenditure', () => {
    const value = { truth: {pro:40,con:60}, value:{pro:300,con:600} };
    expect(getStakeAppearance(value)).toMatchObject({level:3,total:1000});
    expect(getStakeAppearance({truth:value.value,value:value.truth}).level).toBe(3);
    expect(getStakeAppearance({...counts(1), recommendationTotal:10000} as StakeAmounts).level).toBe(0);
  });
  it('does not call missing statistics a known zero stake', () => {
    expect(getStakeAppearance(undefined).level).toBeUndefined();
    expect(getStakeAppearance({truth:{pro:NaN,con:-3},value:{pro:Infinity,con:9}})).toMatchObject({level:0,total:9});
  });
  it('keeps grouped decorations at their strongest member tier instead of summing duplicated or grouped records', () => {
    const records={a:counts(60),b:counts(60),c:counts(0,1000)};
    expect(groupStakeAppearanceAttributes(['a','a','b'],records)).toMatchObject({'data-stake-level':1,'data-stake-total':60});
    expect(groupStakeAppearanceAttributes(['a','c'],records)['data-stake-level']).toBe(3);
    expect(groupStakeAppearanceAttributes(['missing'],records)['data-stake-level']).toBeUndefined();
  });
});
