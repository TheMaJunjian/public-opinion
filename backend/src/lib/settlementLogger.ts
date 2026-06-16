import fs from 'fs';
import path from 'path';

const DEBUG = true;

const LOG_DIR = path.resolve(__dirname, '..', '..', '..', 'README', 'logs');
const LOG_FILE = path.join(LOG_DIR, `settlement-${new Date().toISOString().replace(/[:.]/g, '-')}.log`);

let _ready = false;
function ensureReady() {
  if (!DEBUG) return false;
  if (!_ready) {
    if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });
    _ready = true;
  }
  return true;
}

function writeLine(line: string) {
  if (!ensureReady()) return;
  fs.appendFileSync(LOG_FILE, line + '\n');
}

export function logSettlement(roundId: string, result: string, totalPro: number, totalCon: number) {
  writeLine(`=== 结算 round=${roundId.slice(-6)} result=${result} PRO=${totalPro} CON=${totalCon} pool=${totalPro + totalCon} ===`);
}

export function logUserSettlement(uid: string, isWinner: boolean, delta: number, contrib: number, lockedBefore: number, lockedAfter: number, availBefore: number, availAfter: number, netEarned: number) {
  writeLine(`  ${uid.slice(-6)} ${isWinner ? 'WIN' : 'LOSE'} Δ${delta} 锁定${lockedBefore}→${lockedAfter} 余额${availBefore}→${availAfter} 收益+${netEarned}`);
}

export function logLoserSettlement(uid: string, losingContrib: number, lockedBefore: number, lockedAfter: number, totalLost: number) {
  writeLine(`  ${uid.slice(-6)} LOSE 锁定${lockedBefore}→${lockedAfter} 损失+${totalLost}`);
}

export function logClawback(uid: string, payoutTotal: number, origStake: number, netProfit: number, availBefore: number, availAfter: number, lockedBefore: number, lockedAfter: number) {
  writeLine(`  [回滚] ${uid.slice(-6)}  payout${payoutTotal} stake${origStake} profit${netProfit} 余额${availBefore}→${availAfter} 锁定${lockedBefore}→${lockedAfter}`);
}

export function logClawbackLoser(uid: string, lostAmount: number) {
  writeLine(`  [回滚-败方] ${uid.slice(-6)} 锁定+${lostAmount} totalLost-${lostAmount}`);
}

export function logBetPoolRestore(pro: number, con: number, creatorReward: number) {
  writeLine(`  [池恢复] PRO=${pro} CON=${con} creatorReward=${creatorReward}`);
}
