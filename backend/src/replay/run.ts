/**
 * run.ts — CLI entry point for replay/verify.
 *
 * Usage: npx ts-node src/replay/run.ts
 *    or: npm run replay:verify
 */

import { replay } from './replay';
import { verify, formatReport } from './verify';

async function main() {
  console.log('[replay] 开始重放 AuditLog...');
  const state = await replay();

  console.log(`[replay] 重放完成: ${state.balances.size} 用户, ${state.stakeTotals.size} 消息押注, ${state.rounds.size} 结算轮次`);

  console.log('[verify] 开始对比数据库...');
  const report = await verify(state);

  console.log(formatReport(report));
  process.exit(report.passed ? 0 : 1);
}

main().catch(err => {
  console.error('[replay] 致命错误:', err);
  process.exit(2);
});
