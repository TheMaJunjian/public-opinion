import type { Change } from '@gonglun/core';

export interface ExportPage {
  format: string; regionId: string; ledgerId: string; programVersion: string;
  changes: Change[]; nextCursor: number; hasMore: boolean;
  rules?: unknown; ruleHistory?: { version: number; [key: string]: unknown }[];
}

/** A complete prefix can be replayed; a sliced ledger without its opening balances cannot. */
export async function collectArchive(
  head: number,
  load: (after: number) => Promise<ExportPage>,
  cutoff?: number,
  onProgress?: (count: number) => void,
) {
  const changes: Change[] = [];
  const history = new Map<number, NonNullable<ExportPage['ruleHistory']>[number]>();
  let after = 0;
  let metadata: Omit<ExportPage, 'changes' | 'nextCursor' | 'hasMore' | 'ruleHistory'> | undefined;
  let done = false;
  do {
    const page = await load(after);
    const { changes: batch, nextCursor, hasMore, ruleHistory, rules: _currentRules, ...header } = page;
    if (!Array.isArray(batch)) throw new Error('导出记录格式无效');
    metadata = header;
    for (const rule of ruleHistory ?? []) history.set(rule.version, rule);
    for (const change of batch) {
      if (change.sequence > head || cutoff !== undefined && change.messages.some(message => Date.parse(message.updatedAt) > cutoff)) { done = true; break; }
      if (change.sequence !== after + 1) throw new Error('导出记录不连续，请重新导出');
      changes.push(change); after = change.sequence;
    }
    onProgress?.(changes.length);
    if (done || after >= head) break;
    if (!hasMore || nextCursor !== after || !batch.length) throw new Error('导出提前中断，请重新导出');
  } while (after < head);
  const usedVersions = new Set(changes.flatMap(change => change.messages.map(message => message.ruleVersion)));
  return {
    ...metadata!, format: 'gonglun-2' as const,
    range: { fromSequence: 1, throughSequence: after, throughTime: cutoff === undefined ? null : new Date(cutoff).toISOString() },
    ruleHistory: [...history.values()].filter(rule => usedVersions.has(rule.version)).sort((a, b) => a.version - b.version),
    changes,
  };
}
