import { expect, it } from 'vitest';
import { transactionReasonBreakdown } from '../utils/pointTransactions';

it('preserves a payment, a refund and a lock-only change instead of hiding them behind a zero net', () => {
  const tx = { id:'operation:reversal',type:'OPERATION_GROUP',amount:0,balanceAfter:20,createdAt:'',reasonDetails:[
    {reason:'调整',amount:-6,lockedDelta:0}, {reason:'调整',amount:6,lockedDelta:0},
    {reason:'恢复本金',amount:0,lockedDelta:6}, {reason:'恢复本金',amount:0,lockedDelta:4},
  ] };
  expect(transactionReasonBreakdown(tx)).toEqual([
    {reason:'调整',amount:-6,lockedDelta:0,entryCount:1}, {reason:'调整',amount:6,lockedDelta:0,entryCount:1},
    {reason:'恢复本金',amount:0,lockedDelta:10,entryCount:2},
  ]);
  expect(transactionReasonBreakdown({...tx,type:'USAGE_REWARD'})).toEqual([]);
});
