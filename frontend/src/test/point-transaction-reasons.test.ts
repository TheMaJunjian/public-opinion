import { expect, it } from 'vitest';
import { transactionAssetChange, transactionReasonBreakdown, wagerSettlementSummary } from '../utils/pointTransactions';
import type { PointTransaction } from '../types';

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

const settlementEntry=(reason:string,amount:number,lockedDelta:number)=>({reason,amount,lockedDelta});
const operation=(reasonDetails:NonNullable<PointTransaction['reasonDetails']>):PointTransaction=>({
  id:'operation:settlement',operationId:'settlement',type:'OPERATION_GROUP',balanceAfter:117,createdAt:'',reasonDetails,
  amount:reasonDetails.reduce((sum,entry)=>sum+entry.amount,0),lockedDelta:reasonDetails.reduce((sum,entry)=>sum+entry.lockedDelta,0),
});

it('freezing principal moves available points without losing assets; only fees reduce assets',()=>{
  const tx=operation([settlementEntry('对赌锁定',-6,6),settlementEntry('协议费',-1,0)]);
  expect(transactionAssetChange(tx)).toBe(-1);
  expect(wagerSettlementSummary(tx)).toBeUndefined();
});

it('calculates settlement profit after principal and excludes protocol fees from that profit',()=>{
  const tx=operation([settlementEntry('结束对赌锁定',0,-10),settlementEntry('胜方按出资比例分配',16,0),settlementEntry('协议费',-1,0)]);
  expect(wagerSettlementSummary(tx)).toEqual({principal:10,payout:16,adjustment:0,net:6});
  expect(transactionAssetChange(tx)).toBe(5);
});

it('accounts for both sides owned by the same user and for reversal of an earlier result',()=>{
  const tx=operation([settlementEntry('结束对赌锁定',0,-6),settlementEntry('结束对赌锁定',0,-10),settlementEntry('胜方按出资比例分配',20,0)]);
  expect(wagerSettlementSummary(tx)).toEqual({principal:16,payout:20,adjustment:0,net:4});
  const repeated=operation([...tx.reasonDetails!,settlementEntry('撤回先前对赌分配',-20,0),settlementEntry('恢复先前对赌本金',0,16)]);
  expect(wagerSettlementSummary(repeated)).toEqual({principal:16,payout:20,adjustment:-4,net:0});
  expect(transactionAssetChange(repeated)).toBe(0);
  const overturned=operation([settlementEntry('撤回先前对赌分配',-16,0),settlementEntry('恢复先前对赌本金',0,10),settlementEntry('结束对赌锁定',0,-10)]);
  expect(wagerSettlementSummary(overturned)).toEqual({principal:10,payout:0,adjustment:-6,net:-16});
});

it('does not infer a loss from an isolated legacy principal entry before loading its complete message summary',()=>{
  const tx:PointTransaction={id:'legacy',type:'UNLOCK',amount:0,lockedDelta:-10,balanceAfter:117,createdAt:'',reason:'结束对赌锁定',messageId:'settlement'};
  expect(wagerSettlementSummary(tx)).toBeUndefined();
  expect(wagerSettlementSummary(tx,true)).toEqual({principal:10,payout:0,adjustment:0,net:-10});
  expect(wagerSettlementSummary({...tx,type:'MESSAGE_GROUP',amount:16,entries:[{...tx,id:'payout',reason:'胜方按出资比例分配',amount:16,lockedDelta:0},tx]}))
    .toEqual({principal:10,payout:16,adjustment:0,net:6});
});
