import { log } from './logger';

const tag = '结算';

export function logSettlement(roundId: string, result: string, totalPro: number, totalCon: number) {
  log(tag, `=== round=${roundId.slice(-6)} result=${result} PRO=${totalPro} CON=${totalCon} pool=${totalPro + totalCon} ===`);
}

export function logUserSettlement(uid: string, isWinner: boolean, delta: number, contrib: number, lockedBefore: number, lockedAfter: number, availBefore: number, availAfter: number, netEarned: number) {
  log(tag, `${uid.slice(-6)} ${isWinner ? 'WIN' : 'LOSE'} Δ${delta} 锁定${lockedBefore}→${lockedAfter} 余额${availBefore}→${availAfter} 收益+${netEarned}`);
}

export function logLoserSettlement(uid: string, losingContrib: number, lockedBefore: number, lockedAfter: number, totalLost: number) {
  log(tag, `${uid.slice(-6)} LOSE 锁定${lockedBefore}→${lockedAfter} 损失+${totalLost}`);
}

export function logClawback(uid: string, payoutTotal: number, origStake: number, netProfit: number, availBefore: number, availAfter: number, lockedBefore: number, lockedAfter: number) {
  log(tag, `[回滚] ${uid.slice(-6)} payout${payoutTotal} stake${origStake} profit${netProfit} 余额${availBefore}→${availAfter} 锁定${lockedBefore}→${lockedAfter}`);
}

export function logClawbackLoser(uid: string, lostAmount: number) {
  log(tag, `[回滚-败方] ${uid.slice(-6)} 锁定+${lostAmount} totalLost-${lostAmount}`);
}

export function logBetPoolRestore(pro: number, con: number, creatorReward: number) {
  log(tag, `[池恢复] PRO=${pro} CON=${con} creatorReward=${creatorReward}`);
}
